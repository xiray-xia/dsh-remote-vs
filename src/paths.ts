/**
 * Home-directory layout for dsh-remote-vs. Everything lives under DSH_HOME
 * (default ~/.dsh), next to — but independent from — dsh-ssh.json:
 *
 * - dsh-remote.json          host + workspace store (0600)
 * - dsh-remote-keys/         plugin-managed keypairs (0700 dir, 0600 keys)
 * - dsh-remote-helpers/      cached helper tarballs + .sha256 + .helper.json
 * - remote-ssh/aliases/      local alias dirs, one per remote workspace binding
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chmodSync, mkdirSync } from 'node:fs'

/** Resolved DSH home directory. */
export function dshHome(): string {
  const env = process.env.DSH_HOME
  if (env !== undefined && env !== '') return env
  return join(homedir(), '.dsh')
}

/** Absolute path of the remote store file. */
export function storePath(home: string = dshHome()): string {
  return join(home, 'dsh-remote.json')
}

/** Absolute path of the managed-keys directory (created 0700 on demand). */
export function keysDir(home: string = dshHome()): string {
  return join(home, 'dsh-remote-keys')
}

/** Absolute path of the helper tarball cache directory. */
export function helpersDir(home: string = dshHome()): string {
  return join(home, 'dsh-remote-helpers')
}

/** Absolute path of the remote-workspace alias root. */
export function aliasRoot(home: string = dshHome()): string {
  return join(home, 'remote-ssh', 'aliases')
}

/** Ensure a directory exists with 0700 (best effort on Windows). */
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  try {
    // mkdirSync mode only applies on creation; chmod enforces on every call.
    chmodSync(path, 0o700)
  } catch {
    // Windows ACLs: ignore.
  }
}
