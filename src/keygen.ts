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
  const publicKey = readFileSync(publicPath, 'utf8').trim()
  if (!publicKey.startsWith('ssh-ed25519 ')) throw new Error(`unexpected public key format in ${publicPath}`)
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
  // Single-line ed25519 key: safe inside single quotes (base64 has no quote chars).
  const script = [
    'mkdir -p ~/.ssh && chmod 700 ~/.ssh',
    `touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
    `grep -qxF '${publicKey}' ~/.ssh/authorized_keys 2>/dev/null || echo '${publicKey}' >> ~/.ssh/authorized_keys`,
  ].join(' && ')
  const result = await pool.exec(alias, script, { timeoutMs: 30_000 })
  if (!result.success) {
    throw new Error(`key install failed [exit code: ${result.exitCode}]: ${result.stderr || result.stdout || result.error || 'unknown'}`)
  }
  store.update(alias, { auth: { kind: 'key', keyPath: privatePath } })
  pool.drop(alias)
  // Verify the new key actually works before declaring victory.
  const check = await pool.test(alias)
  if (!check.ok) {
    throw new Error(`key installed but key login failed: ${check.error} (password entry was already flipped; fix the key or re-enter the password)`)
  }
  return { alias, keyPath: privatePath, flipped: true, detail: 'public key installed; entry now uses key auth' }
}
