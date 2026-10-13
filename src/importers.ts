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
    } else if (current !== undefined && !current.fields.has(key)) {
      current.fields.set(key, value)
    }
  }
  for (const block of blocks) {
    const alias = block.patterns[0] as string
    if (alias === undefined || alias.includes('*') || alias.includes('?') || alias.includes('!')) {
      skipped.push({ alias: block.patterns.join(' ') || '(empty)', reason: 'wildcard patterns are not imported' })
      continue
    }
    if (block.fields.has('proxyjump') || block.fields.has('proxycommand')) {
      skipped.push({ alias, reason: 'proxyJump/proxyCommand needs P1 (direct hosts only in P0)' })
      continue
    }
    const identityFile = block.fields.get('identityfile')?.split(/\s+/)[0]
    payloads.push({
      alias,
      host: block.fields.get('hostname') ?? alias,
      port: block.fields.get('port') !== undefined ? Number(block.fields.get('port')) : 22,
      user: block.fields.get('user') ?? '',
      auth: identityFile !== undefined
        ? { kind: 'key', keyPath: expandHome(identityFile) }
        : { kind: 'password', password: '' },
      tags: ['imported:ssh-config'],
    })
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
    const proxyJump = (raw.proxyJump ?? []) as unknown[]
    const proxyCommand = raw.proxyCommand
    if (kind !== 'key' && kind !== 'password') {
      skipped.push({ alias, reason: `auth kind '${String(kind)}' needs P1 (key/password only in P0)` })
      continue
    }
    if (proxyJump.length > 0 || (typeof proxyCommand === 'string' && proxyCommand !== '')) {
      skipped.push({ alias, reason: 'proxyJump/proxyCommand needs P1 (direct hosts only in P0)' })
      continue
    }
    if (kind === 'key' && typeof auth.keyPath !== 'string') {
      skipped.push({ alias, reason: 'key auth without keyPath' })
      continue
    }
    if (kind === 'password' && typeof auth.password !== 'string') {
      skipped.push({ alias, reason: 'password auth without stored password (enter it manually)' })
      continue
    }
    payloads.push({
      alias,
      host: typeof raw.host === 'string' ? raw.host : '',
      port: typeof raw.port === 'number' ? raw.port : 22,
      user: typeof raw.user === 'string' ? raw.user : '',
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
