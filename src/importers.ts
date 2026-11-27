/**
 * One-shot importers: ~/.ssh/config and the existing dsh-ssh.json. Both only
 * READ the source and produce payloads for our own store — no runtime coupling.
 * Hosts are direct key hosts; the egress half of a `Host` block (`ProxyJump` /
 * `ProxyCommand`) is mapped onto the store's `proxy` field when it names
 * something this import actually produces, and refused BY NAME when it names a
 * form this plugin cannot dial (multi-hop, a shell command, a jump host that is
 * not part of the config). A silent skip used to be the answer to all of them;
 * "one hop, from this same config" is the honest boundary.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dshHome } from './paths.ts'
import type { HostPayload } from './store.ts'
import type { ImportReport, RemoteHostProxySetting } from './protocol.ts'
import { parseProxyCommand, parseProxyJump } from './proxy.ts'

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

/** One host block that WILL be imported once its egress decision is known. */
interface CandidateHost {
  alias: string
  hostname: string
  port: number
  user: string
  identityFile: string
  fields: Map<string, string>
}

/** What resolving one block's `ProxyJump`/`ProxyCommand` produced. */
type ProxyResolution =
  | { ok: true; proxy?: RemoteHostProxySetting }
  | { ok: false; reason: string }

/** `ProxyJump none` / `ProxyCommand none` is OpenSSH for "explicitly no proxy". */
function isNone(value: string): boolean {
  return value.trim().toLowerCase() === 'none'
}

/**
 * Index every name an imported host answers to: its alias and its `HostName`.
 *
 * `ProxyJump bastion` may name the `Host bastion` alias or the literal hostname
 * it resolves to, so both are accepted; a name with no host behind it in THIS
 * config cannot become a `viaAlias` (the stored setting would dangle).
 */
function nameIndex(candidates: CandidateHost[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const candidate of candidates) {
    index.set(candidate.alias, candidate.alias)
    index.set(candidate.alias.toLowerCase(), candidate.alias)
    index.set(candidate.hostname, candidate.alias)
    index.set(candidate.hostname.toLowerCase(), candidate.alias)
  }
  return index
}

/** Resolve one jump host name against the hosts this import creates. */
function resolveJump(self: string, name: string, index: Map<string, string>): ProxyResolution {
  const viaAlias = index.get(name) ?? index.get(name.toLowerCase())
  if (viaAlias === undefined) {
    return {
      ok: false,
      reason: `jump host '${name}' is not imported by this config — a jump host must be one of its Host entries`,
    }
  }
  if (viaAlias === self) return { ok: false, reason: `jump host '${name}' is this host itself` }
  return { ok: true, proxy: { mode: 'jump', jump: { viaAlias } } }
}

/**
 * Turn one block's egress directive into the store's proxy decision.
 *
 * Precedence matches OpenSSH (a set `ProxyJump` wins over `ProxyCommand`), and
 * everything unusable keeps the PARSER's own reason so the report says what to
 * fix ("only one hop", "not supported program") instead of a generic skip.
 */
function resolveProxy(self: string, fields: Map<string, string>, index: Map<string, string>): ProxyResolution {
  const jump = fields.get('proxyjump')
  if (jump !== undefined) {
    if (isNone(jump)) return { ok: true }
    const parsed = parseProxyJump(jump)
    if (!parsed.ok) return { ok: false, reason: parsed.reason }
    return resolveJump(self, parsed.target.host, index)
  }
  const command = fields.get('proxycommand')
  if (command !== undefined) {
    if (isNone(command)) return { ok: true }
    const plan = parseProxyCommand(command)
    if (plan.kind === 'proxy') {
      // The parsed plan carries no credentials on purpose: an nc/ncat command
      // line may name a proxy but never its password, and guessing one would
      // produce a host that fails with "the proxy rejected the credentials".
      return {
        ok: true,
        proxy: { mode: 'proxy', proxy: { kind: plan.proxy.kind, host: plan.proxy.host, port: plan.proxy.port } },
      }
    }
    if (plan.kind === 'jump') return resolveJump(self, plan.target.host, index)
    return { ok: false, reason: plan.reason }
  }
  return { ok: true }
}

/** Parse OpenSSH client config text into host payloads. */
export function parseSshConfig(text: string): ParsedImport {
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
  // Pass 1: which names become hosts at all. The proxy decision is resolved in
  // pass 2 because `ProxyJump` may name a block that appears LATER in the file —
  // and because a jump host that is itself skipped (no IdentityFile) must not be
  // recorded as a live alias.
  const candidates: CandidateHost[] = []
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
      candidates.push({
        alias,
        hostname: block.fields.get('hostname') ?? alias,
        port,
        user,
        identityFile,
        fields: block.fields,
      })
    }
  }
  // Pass 2: the egress decision, against the names pass 1 will actually create.
  const index = nameIndex(candidates)
  const payloads: HostPayload[] = []
  for (const candidate of candidates) {
    const resolution = resolveProxy(candidate.alias, candidate.fields, index)
    if (!resolution.ok) {
      skipped.push({ alias: candidate.alias, reason: resolution.reason })
      continue
    }
    payloads.push({
      alias: candidate.alias,
      host: candidate.hostname,
      port: candidate.port,
      user: candidate.user,
      auth: { kind: 'key', keyPath: expandHome(candidate.identityFile) },
      tags: ['imported:ssh-config'],
      ...(resolution.proxy === undefined ? {} : { proxy: resolution.proxy }),
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
      // dsh-ssh.json stores the SAME two directives in its own shape; mapping
      // them would mean a second parser with no cfg sample to verify against, so
      // this path keeps refusing and says where the mapping DOES exist.
      skipped.push({ alias, reason: "proxyJump/proxyCommand in dsh-ssh.json is not mapped — import from ~/.ssh/config instead" })
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
