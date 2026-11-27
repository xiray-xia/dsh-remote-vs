/**
 * Password -> key bootstrap (Q2 decision): a password host gets a dedicated
 * ed25519 keypair generated locally (ssh-keygen), the public half is appended
 * to the remote ~/.ssh/authorized_keys over the password connection, and the
 * store entry flips to key auth with the managed keyPath.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmodSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { keysDir, ensurePrivateDir } from './paths.ts'
import type { RemotePool } from './pool.ts'
import type { RemoteStore } from './store.ts'

const execFileAsync = promisify(execFile)

export interface BootstrapResult {
  alias: string
  keyPath: string
  /** True when the store entry flipped from password to key auth. */
  flipped: boolean
  detail: string
}

/**
 * `type base64` — the only two fields of a `.pub` file that are key material.
 *
 * ssh-keygen appends a free-text comment, and that comment is NOT part of the
 * key. The old code only checked the line's prefix and then spliced the WHOLE
 * line into a single-quoted remote shell command; a garbled or tampered `.pub`
 * therefore reached `sh -c` as code. The strict grammar below admits nothing
 * but the two safe fields, and the comment is regenerated from the alias.
 */
const PUBLIC_KEY_FIELDS_RE = /^(ssh-ed25519) ([A-Za-z0-9+/]+={0,2})$/

/** Ed25519 wire blob: 4-byte length + "ssh-ed25519", 4-byte length + 32 bytes. */
function isEd25519Blob(blob: string): boolean {
  const decoded = Buffer.from(blob, 'base64')
  if (decoded.length !== 51) return false
  if (decoded.readUInt32BE(0) !== 11) return false
  if (decoded.subarray(4, 15).toString('latin1') !== 'ssh-ed25519') return false
  return decoded.readUInt32BE(15) === 32
}

/**
 * Normalize one `.pub` line to `ssh-ed25519 <base64> dsh-remote-vs/<alias>`.
 *
 * Throws when the line is not a well-formed ed25519 public key, so the caller
 * sees a clear "this file is not a key" error instead of a remote login that
 * fails later. The returned text is the only form that may enter the shell
 * command: its comment is ours, and both remaining fields are shell-inert.
 */
export function formatPublicKey(raw: string, alias: string): string {
  const fields = raw.trim().split(/\s+/)
  const type = fields[0]
  const blob = fields[1]
  if (fields.length < 2 || type === undefined || blob === undefined || !PUBLIC_KEY_FIELDS_RE.test(`${type} ${blob}`)) {
    throw new Error('expected an "ssh-ed25519 <base64>" public key line')
  }
  if (!isEd25519Blob(blob)) throw new Error('the base64 blob is not a valid ed25519 public key')
  // The comment never matters to sshd; rebuild it from the (already validated)
  // alias so no text from the file can reach the remote command.
  return `${type} ${blob} dsh-remote-vs/${alias.replace(/[^A-Za-z0-9._-]/g, '_')}`
}

/** Ensure the managed keypair exists; return the private key path. */
export async function ensureKeypair(alias: string, dir: string = keysDir()): Promise<{ privatePath: string; publicKey: string }> {
  ensurePrivateDir(dir)
  const privatePath = join(dir, alias)
  const publicPath = `${privatePath}.pub`
  if (!existsSync(privatePath) || !existsSync(publicPath)) {
    try {
      await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-f', privatePath, '-N', '', '-C', `dsh-remote-vs/${alias}`])
    } catch (error) {
      throw new Error(
        `ssh-keygen failed (required for key bootstrap): ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    try {
      chmodSync(privatePath, 0o600)
    } catch {
      // Windows ACLs: ignore.
    }
  }
  let publicKey: string
  try {
    publicKey = formatPublicKey(readFileSync(publicPath, 'utf8'), alias)
  } catch (error) {
    throw new Error(
      `unexpected public key format in ${publicPath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return { privatePath, publicKey }
}

/**
 * Bootstrap one host: install the managed public key remotely, then flip the
 * entry to key auth and drop the pooled password connection.
 */
export async function bootstrap(pool: RemotePool, store: RemoteStore, alias: string): Promise<BootstrapResult> {
  const entry = store.require(alias)
  if (entry.auth.kind !== 'password') {
    return { alias, keyPath: entry.auth.keyPath ?? '', flipped: false, detail: 'host already uses key auth' }
  }
  const { privatePath, publicKey } = await ensureKeypair(alias)
  // `formatPublicKey` reduced the line to type + base64 + our own comment:
  // safe inside single quotes (no quote, whitespace or shell metacharacters).
  // Match on the two KEY FIELDS only: an older/foreign comment on the same key
  // must not cause a duplicate authorized_keys line.
  const keyFields = publicKey.split(' ').slice(0, 2).join(' ')
  const script = [
    'mkdir -p ~/.ssh && chmod 700 ~/.ssh',
    `touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
    `grep -qF '${keyFields}' ~/.ssh/authorized_keys 2>/dev/null || echo '${publicKey}' >> ~/.ssh/authorized_keys`,
  ].join(' && ')
  const result = await pool.exec(alias, script, { timeoutMs: 30_000 })
  if (!result.success) {
    throw new Error(`key install failed [exit code: ${result.exitCode}]: ${result.stderr || result.stdout || result.error || 'unknown'}`)
  }
  // Order matters and matches the host PATCH route: flip the entry FIRST, then
  // drop the connection, so a dial racing this request cannot slip in a
  // password-auth connection that nobody tears down afterwards.
  store.update(alias, { auth: { kind: 'key', keyPath: privatePath } })
  // `forget`, not `drop`: the old auth attempt's verdict ("password rejected",
  // "key not installed yet") describes a credential this entry no longer uses,
  // so it must not survive to colour the chip. The `test()` below records the
  // new verdict against the key.
  pool.forget(alias)
  // Verify the new key actually works before declaring victory.
  const check = await pool.test(alias)
  if (!check.ok) {
    throw new Error(`key installed but key login failed: ${check.error} (password entry was already flipped; fix the key or re-enter the password)`)
  }
  return { alias, keyPath: privatePath, flipped: true, detail: 'public key installed; entry now uses key auth' }
}
