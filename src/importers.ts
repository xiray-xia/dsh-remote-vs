/**
 * One-shot importers: ~/.ssh/config and the existing dsh-ssh.json. Both only
 * READ the source and produce payloads for our own store — no runtime coupling.
 * P0 supports direct key/password hosts only; jump/proxy/agent entries are
 * reported as skipped with reasons.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dshHome } from './paths.ts'
import type { HostPayload } from './store.ts'
import type { ImportReport } from './protocol.ts'

export interface ParsedImport {
  payloads: HostPayload[]
  skipped: { alias: string; reason: string }[]
}

/** Expand a leading ~ to the user home. */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Parse one configured port (number, or a decimal string from older stores).
 *
 * `undefined` means absent (caller defaults to 22); `NaN`/out-of-range returns
 * `undefined` too, and callers turn that into an explicit skip — silently
 * importing an invalid port as 22 would connect to the wrong sshd (or none).
 */
function validPort(value: string | number): number | undefined {
  const port = typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return port
}

/** Parse OpenSSH client config text into host payloads. */
export function parseSshConfig(text: string): ParsedImport {
  const payloads: HostPayload[] = []
  const skipped: { alias: string; reason: string }[] = []
  interface Block { patterns: string[]; fields: Map<string, string> }
  const blocks: Block[] = []
  let current: Block | undefined
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^(\S+)\s+(.*)$/.exec(line)
    if (match === null) continue
    const key = (match[1] as string).toLowerCase()
    let value = (match[2] as string).trim().replace(/^"(.*)"$/, '$1')
    // Strip trailing inline comments (naive: values with # are rare here).
    const hash = value.indexOf(' #')
    if (hash >= 0) value = value.slice(0, hash).trim()
    if (key === 'host') {
      current = { patterns: value.split(/\s+/), fields: new Map() }
      blocks.push(current)
    } else if (key === 'match') {
      current = undefined
      skipped.push({ alias: '(match)', reason: 'Match conditional blocks are not imported' })
    } else if (key === 'include') {
      // Not expanded: multi-file configs live in separate files, and a silent
      // omission used to look like "the config only had a few hosts".
      skipped.push({ alias: '(include)', reason: `Include ${value} is not expanded — import that file separately` })
    } else if (current !== undefined && !current.fields.has(key)) {
      current.fields.set(key, value)
    }
  }
  for (const block of blocks) {
    // A `Host a b` line declares TWO names with the same fields: import each
    // concrete pattern instead of silently dropping everything after the first.
    const concrete = block.patterns.filter(pattern => pattern !== '' && !/[*?!]/.test(pattern))
    const special = block.patterns.filter(pattern => pattern !== '' && /[*?!]/.test(pattern))
    if (special.length > 0) {
      skipped.push({ alias: special.join(' '), reason: 'wildcard/negation patterns are not imported' })
    }
    if (concrete.length === 0) {
      if (special.length === 0) skipped.push({ alias: '(empty)', reason: 'Host line has no pattern' })
      continue
    }
    if (block.fields.has('proxyjump') || block.fields.has('proxycommand')) {
      for (const alias of concrete) skipped.push({ alias, reason: 'proxyJump/proxyCommand needs P1 (direct hosts only in P0)' })
      continue
    }
    const rawPort = block.fields.get('port')
    const port = rawPort === undefined ? 22 : validPort(rawPort)
    const identityFile = block.fields.get('identityfile')?.split(/\s+/)[0]
    const user = block.fields.get('user') ?? ''
    for (const alias of concrete) {
      if (port === undefined) {
        skipped.push({ alias, reason: `invalid Port '${rawPort ?? ''}' (expected 1-65535)` })
        continue
      }
      if (user === '') {
        skipped.push({ alias, reason: 'no User in ssh_config — set the login user after import' })
        continue
      }
      if (identityFile === undefined) {
        // The old code produced an empty-password payload, which the store then
        // rejected with a misleading "auth.password must be non-empty".
        skipped.push({ alias, reason: 'no IdentityFile in ssh_config — add the key or password after import' })
        continue
      }
      payloads.push({
        alias,
        host: block.fields.get('hostname') ?? alias,
        port,
        user,
        auth: { kind: 'key', keyPath: expandHome(identityFile) },
        tags: ['imported:ssh-config'],
      })
    }
  }
  return { payloads, skipped }
}

/** Read the default ~/.ssh/config (throws when missing). */
export function readDefaultSshConfig(): string {
  const file = join(homedir(), '.ssh', 'config')
  if (!existsSync(file)) throw new Error(`no such file: ${file}`)
  return readFileSync(file, 'utf8')
}

interface DshSshDoc {
  hosts?: unknown
}

/** Migrate entries from the third-party dsh-ssh.json (one-shot copy). */
export function migrateDshSsh(home: string = dshHome()): ParsedImport {
  const file = join(home, 'dsh-ssh.json')
  if (!existsSync(file)) throw new Error(`no such file: ${file} (nothing to import)`)
  const doc = JSON.parse(readFileSync(file, 'utf8')) as DshSshDoc
  if (!Array.isArray(doc.hosts)) throw new Error(`${file}: hosts is not an array`)
  const payloads: HostPayload[] = []
  const skipped: { alias: string; reason: string }[] = []
  for (const raw of doc.hosts as Record<string, unknown>[]) {
    const alias = typeof raw.alias === 'string' ? raw.alias : '(unknown)'
    const auth = (raw.auth ?? {}) as Record<string, unknown>
    const kind = auth.kind
    const proxyJump = raw.proxyJump
    const proxyCommand = raw.proxyCommand
    const hasProxy = (Array.isArray(proxyJump) && proxyJump.length > 0)
      || (typeof proxyJump === 'string' && proxyJump !== '')
      || (typeof proxyCommand === 'string' && proxyCommand !== '')
    if (kind !== 'key' && kind !== 'password') {
      skipped.push({ alias, reason: `auth kind '${String(kind)}' needs P1 (key/password only in P0)` })
      continue
    }
    if (hasProxy) {
      skipped.push({ alias, reason: 'proxyJump/proxyCommand needs P1 (direct hosts only in P0)' })
      continue
    }
    if (kind === 'key' && (typeof auth.keyPath !== 'string' || auth.keyPath.trim() === '')) {
      skipped.push({ alias, reason: 'key auth without keyPath' })
      continue
    }
    if (kind === 'password' && (typeof auth.password !== 'string' || auth.password === '')) {
      skipped.push({ alias, reason: 'password auth without stored password (enter it manually)' })
      continue
    }
    const host = typeof raw.host === 'string' ? raw.host : ''
    const user = typeof raw.user === 'string' ? raw.user : ''
    const rawPort = raw.port
    const port = rawPort === undefined ? 22 : validPort(rawPort as string | number)
    if (host === '') {
      skipped.push({ alias, reason: 'no host address — enter it manually after import' })
      continue
    }
    if (user === '') {
      skipped.push({ alias, reason: 'no login user — enter it manually after import' })
      continue
    }
    if (port === undefined) {
      skipped.push({ alias, reason: `invalid port '${String(rawPort)}' (expected 1-65535)` })
      continue
    }
    payloads.push({
      alias,
      host,
      port,
      user,
      auth: kind === 'key'
        ? {
            kind: 'key',
            keyPath: auth.keyPath as string,
            ...(typeof auth.passphrase === 'string' ? { passphrase: auth.passphrase } : {}),
          }
        : { kind: 'password', password: auth.password as string },
      ...((typeof raw.description === 'string' && raw.description !== '' ? { description: raw.description } : {})),
      tags: ['imported:dsh-ssh'],
    })
  }
  return { payloads, skipped }
}

/** Merge parsed payloads into the report shape after applying them. */
export function toReport(imported: string[], skipped: { alias: string; reason: string }[]): ImportReport {
  return { imported, skipped }
}
