/**
 * Durable store for dsh-remote-vs: hosts + workspace bindings in
 * $DSH_HOME/dsh-remote.json (0600, atomic tmp+rename writes).
 */
import { existsSync, statSync, openSync, readFileSync, renameSync, writeSync, closeSync, fsyncSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { aliasRoot, keysDir, storePath } from './paths.ts'
import { normalizeProxy, type ProxyConfig } from './proxy.ts'
import type {
  RemoteDeployState,
  RemoteHostEntry,
  RemoteHostProxySetting,
  RemoteHostProxyView,
  RemoteProxyMode,
  RemoteProxySetting,
  RemoteProxySettingsPatch,
  RemoteProxySettingsView,
  RemoteProxyTargetView,
  RemoteHostSummary,
  RemoteWorkspaceBinding,
} from './protocol.ts'

/** Profile-wide proxy default as stored (absent = direct). */
interface StoredDefaultProxy {
  mode: 'direct' | 'proxy'
  /** Endpoint for `mode: 'proxy'`; kept when switching back to direct. */
  proxy?: ProxyConfig
}

/** On-disk document shape. */
interface StoreDoc {
  version: 1
  hosts: RemoteHostEntry[]
  workspaces: RemoteWorkspaceBinding[]
  /** Removed alias dirs (fail-closed tombstones; never auto-deleted). */
  tombstones: string[]
  /**
   * Profile-wide proxy default (the "upper" level hosts may `inherit`).
   *
   * Optional so every pre-existing file keeps loading; absent means direct, which
   * is the behaviour an upgrade must not change.
   */
  defaultProxy?: StoredDefaultProxy
}

/** Empty document. */
function emptyDoc(): StoreDoc {
  return { version: 1, hosts: [], workspaces: [], tombstones: [] }
}

/** The proxy modes a stored host decision may name. */
const PROXY_MODES: readonly RemoteProxyMode[] = ['inherit', 'direct', 'proxy', 'jump']

/** Narrow an untrusted value to a declared mode (garbage falls back to `inherit`). */
function proxyModeOf(mode: unknown): RemoteProxyMode {
  return PROXY_MODES.includes(mode as RemoteProxyMode) ? (mode as RemoteProxyMode) : 'inherit'
}

/** Message of an error without assuming it is an `Error`. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read a stored default-proxy block, tolerating hand-edited garbage.
 *
 * A malformed value is DROPPED (→ direct) rather than throwing: a store file an
 * older version or a text editor touched must still load, and "direct" is the
 * behaviour an upgrade would have had anyway.
 */
function sanitizeDefaultProxy(value: unknown): StoredDefaultProxy | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as { mode?: unknown; proxy?: unknown }
  if (raw.proxy === undefined) return { mode: raw.mode === 'proxy' ? 'proxy' : 'direct' }
  try {
    return { mode: raw.mode === 'proxy' ? 'proxy' : 'direct', proxy: normalizeProxy(raw.proxy) }
  } catch {
    return { mode: 'direct' }
  }
}

/** Identity of the store file at one point in time; `null` = the file is absent. */
type FileStamp = { mtimeMs: number; size: number } | null

/** Same file identity (both absent counts as same). */
function sameStamp(left: FileStamp, right: FileStamp): boolean {
  if (left === null || right === null) return left === right
  return left.mtimeMs === right.mtimeMs && left.size === right.size
}

/** Alias grammar: 1-64 chars of letters/digits/._- */
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function assertAlias(alias: unknown): asserts alias is string {
  if (typeof alias !== 'string' || !ALIAS_RE.test(alias)) {
    throw new Error('alias must match [A-Za-z0-9._-]{1,64} and start with an alphanumeric')
  }
}

/**
 * Replays one read-modify-write before giving up. Two processes sharing
 * `$DSH_HOME` (desktop + `dsh web`) can each land an edit between the other's
 * read and write; a single retry almost always settles it, and the third attempt
 * fails loud instead of silently dropping someone's change.
 */
const MUTATION_ATTEMPTS = 3

/**
 * Validate the SHAPE of an `auth` patch before it is merged.
 *
 * `update()` used to treat anything whose `kind` was not `'key'` as a password
 * patch: `{kind:'garbage'}` silently kept the stored password (HTTP 200), and
 * `auth: null` threw an engine TypeError. The merge below (and `normalize()`)
 * must only ever see the two declared kinds, with a real object to read from.
 */
function assertAuthPatch(auth: unknown): asserts auth is HostPayload['auth'] {
  if (typeof auth !== 'object' || auth === null) throw new Error('auth must be an object')
  const kind = (auth as { kind?: unknown }).kind
  if (kind !== 'key' && kind !== 'password') throw new Error('auth.kind must be key or password')
}

/** Payload accepted by create/update (secrets included, host-side only). */
export interface HostPayload {
  alias: string
  host: string
  port?: number
  user: string
  auth: { kind: 'key' | 'password'; keyPath?: string; passphrase?: string; password?: string }
  /** How this host reaches the network; omitted = `inherit` (back-compat). */
  proxy?: RemoteHostProxySetting
  description?: string
  tags?: string[]
}

export interface WorkspacePayload {
  name: string
  alias: string
  remotePath: string
}

/**
 * The effective network route one dial must take (see `resolveProxy`).
 *
 * `source` is kept because "the profile default sent me through a proxy" and "this
 * host says so" are different answers to the same question in `remote_hosts`.
 */
export type ResolvedProxy =
  | { kind: 'direct' }
  | { kind: 'proxy'; proxy: ProxyConfig; source: 'host' | 'default' }
  | { kind: 'jump'; viaAlias: string }

export class RemoteStore {
  private readonly file: string
  private doc: StoreDoc
  /** File identity when `doc` was read from disk (undefined = `doc` is not known fresh). */
  private stamp: FileStamp | undefined

  constructor(file?: string) {
    this.file = file ?? storePath()
    // `doc` starts empty and `reload()` fills it: `stamp` is undefined, so the
    // first read always takes the real path (missing file -> empty doc).
    this.doc = emptyDoc()
    this.reload()
  }

  /**
   * Absolute path of the JSON document.
   *
   * Diagnostics only: a corrupt file must name itself in the error a surface
   * shows, otherwise the user only sees "the request failed".
   */
  get filePath(): string {
    return this.file
  }

  /**
   * Reload from disk (picks up external edits).
   *
   * Re-reading on every access is deliberate: the root fs router asks this store
   * 2-4 times per routed file operation, and an edit made by another process
   * must be visible without a restart. A stat is orders of magnitude cheaper
   * than read + parse, so the file's identity (mtime + size) decides instead —
   * unchanged means the cached doc is already the file's content. The stamp is
   * taken BEFORE the read: a write landing in between leaves the older stamp
   * behind, so the next access re-reads rather than trusting a stale doc. The
   * one edit this cannot see is a same-length rewrite inside the filesystem's
   * mtime granularity (sub-ms on NTFS/ext4).
   */
  reload(): void {
    const stamp = this.stampOf()
    if (stamp !== undefined && this.stamp !== undefined && sameStamp(stamp, this.stamp)) return
    this.doc = this.loadDoc()
    this.stamp = stamp
  }

  /**
   * File identity right now: `null` when the file is absent, `undefined` when it
   * cannot be statted at all. Both cases fall through to a full load, so the
   * missing-file and unreadable-file paths behave exactly as they did before.
   */
  private stampOf(): FileStamp | undefined {
    try {
      const stat = statSync(this.file, { throwIfNoEntry: false })
      return stat === undefined ? null : { mtimeMs: stat.mtimeMs, size: stat.size }
    } catch {
      return undefined
    }
  }

  private loadDoc(): StoreDoc {
    if (!existsSync(this.file)) return emptyDoc()
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (error) {
      throw new Error(`cannot parse ${this.file}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (typeof parsed !== 'object' || parsed === null) throw new Error(`${this.file}: root must be an object`)
    const doc = parsed as Partial<StoreDoc>
    if (doc.version !== 1) throw new Error(`${this.file}: unsupported version ${(doc as { version?: unknown }).version}`)
    if (!Array.isArray(doc.hosts) || !Array.isArray(doc.workspaces)) {
      throw new Error(`${this.file}: hosts/workspaces must be arrays`)
    }
    return {
      version: 1,
      hosts: doc.hosts,
      workspaces: doc.workspaces,
      tombstones: Array.isArray(doc.tombstones) ? doc.tombstones.filter(t => typeof t === 'string') : [],
      ...(() => {
        const defaultProxy = sanitizeDefaultProxy((doc as { defaultProxy?: unknown }).defaultProxy)
        return defaultProxy === undefined ? {} : { defaultProxy }
      })(),
    }
  }

  private save(): void {
    // The caller already mutated `doc`, so in-memory state is ahead of the file:
    // invalidate the stamp. A failed write must not pin the dirty doc in place
    // (the next read goes back to the file, as it always did), and a successful
    // one is picked up by that same re-read, which re-arms the fast path.
    this.stamp = undefined
    const payload = JSON.stringify(this.doc, null, 2)
    const dir = dirname(this.file)
    // A fresh $DSH_HOME may not exist yet: the first host/workspace write must
    // not fail with ENOENT.
    mkdirSync(dir, { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    // 0600 from creation (Windows: best effort, mode is advisory there).
    const fd = openSync(tmp, 'w', 0o600)
    try {
      writeSync(fd, payload)
      // Flush the bytes BEFORE the rename: a power loss/blue screen must not
      // leave the store empty or half written (the next boot refuses to load
      // that). Best effort — an OS refusing fsync must not fail the save.
      try {
        fsyncSync(fd)
      } catch {
        // Durability is improved, not guaranteed.
      }
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, this.file)
    // Make the rename itself durable (POSIX directory fsync). Windows cannot
    // open a directory for fsync, so it keeps the file-level flush above.
    if (process.platform !== 'win32') {
      let dirFd: number | undefined
      try {
        dirFd = openSync(dir, 'r')
        fsyncSync(dirFd)
      } catch {
        // Best effort.
      } finally {
        if (dirFd !== undefined) {
          try {
            closeSync(dirFd)
          } catch {
            // Ignore.
          }
        }
      }
    }
  }

  /**
   * Re-read, mutate, then write only while the file has not changed underneath.
   *
   * Every mutation here rewrites the WHOLE document, so a plain
   * read-modify-write let the last writer win: desktop and `dsh web` share
   * `$DSH_HOME/dsh-remote.json` by design, and one side's host edit could
   * disappear without any error. Re-reading at the start plus a stamp re-check
   * right before the write turns that into a replay on fresh content.
   *
   * `apply` must only touch `this.doc` and return a value (no I/O, no logging):
   * a conflicting attempt is executed again against the reloaded document.
   * The final rename window is still unguarded (a real lock needs blocking I/O);
   * this narrows the lost-update window from a whole user edit to microseconds.
   */
  private mutate<T>(apply: (doc: StoreDoc) => T): T {
    for (let attempt = 0; attempt < MUTATION_ATTEMPTS; attempt += 1) {
      this.reload()
      const base: FileStamp = this.stamp ?? null
      const before = JSON.stringify(this.doc)
      const result = apply(this.doc)
      // Nothing changed (e.g. deleting an unknown alias): do not rewrite the file.
      if (JSON.stringify(this.doc) === before) return result
      if (!sameStamp(base, this.stampOf() ?? null)) continue
      this.save()
      return result
    }
    throw new Error(`${this.file}: another process keeps editing the store; retry the operation`)
  }

  // ------------------------------------------------------------- hosts
  // NOTE: reads revalidate the file first (one stat; the file is tiny and a
  // read + parse only happens when its identity changed), so routers + routes +
  // GUI still see fresh state without a watcher.

  list(): RemoteHostEntry[] {
    this.reload()
    return [...this.doc.hosts]
  }

  get(alias: string): RemoteHostEntry | undefined {
    this.reload()
    return this.doc.hosts.find(h => h.alias === alias)
  }

  require(alias: string): RemoteHostEntry {
    const entry = this.get(alias)
    if (entry === undefined) throw new Error(`unknown host alias: ${alias}`)
    return entry
  }

  create(payload: HostPayload): RemoteHostEntry {
    assertAlias(payload.alias)
    return this.mutate(() => {
      if (this.doc.hosts.some(host => host.alias === payload.alias)) {
        throw new Error(`alias already exists: ${payload.alias}`)
      }
      const entry = this.normalize(payload, undefined)
      this.doc.hosts.push(entry)
      return entry
    })
  }

  update(alias: string, patch: Partial<Omit<HostPayload, 'alias'>>): RemoteHostEntry {
    // The HTTP route casts an arbitrary JSON body here, so the SHAPE has to be
    // checked before the merge: otherwise an unknown `auth.kind` silently became
    // a password patch (and `auth: null` threw an engine TypeError).
    if (patch.auth !== undefined) assertAuthPatch(patch.auth)
    return this.mutate(() => {
      const index = this.doc.hosts.findIndex(h => h.alias === alias)
      if (index < 0) throw new Error(`unknown host alias: ${alias}`)
      const current = this.doc.hosts[index] as RemoteHostEntry
      // Empty auth materials mean "keep the stored one" (the browser never
      // echoes secrets back, so an untouched field arrives empty/omitted).
      let auth = patch.auth ?? current.auth
      if (patch.auth !== undefined) {
        if (patch.auth.kind === 'key') {
          const keyPath = (patch.auth.keyPath ?? '').trim()
          auth = {
            kind: 'key',
            keyPath: keyPath !== ''
              ? keyPath
              : current.auth.kind === 'key'
                ? (current.auth.keyPath as string)
                : '',
            ...(patch.auth.passphrase !== undefined
              ? { passphrase: patch.auth.passphrase }
              : current.auth.kind === 'key' && current.auth.passphrase !== undefined
                ? { passphrase: current.auth.passphrase }
                : {}),
          }
        } else {
          const password = patch.auth.password ?? ''
          auth = {
            kind: 'password',
            password: password !== ''
              ? password
              : current.auth.kind === 'password'
                ? (current.auth.password as string)
                : '',
          }
        }
      }
      const merged: HostPayload = {
        alias,
        host: patch.host ?? current.host,
        port: patch.port ?? current.port,
        user: patch.user ?? current.user,
        auth,
        // `undefined` keeps the stored decision; `{mode:'inherit'}` clears it
        // (the browser cannot send `null` through this payload shape).
        proxy: patch.proxy ?? current.proxy,
        description: patch.description ?? current.description,
        tags: patch.tags ?? current.tags,
      }
      const next = this.normalize(merged, current)
      /*
       * A host other hosts jump through must stay a SINGLE hop.
       *
       * Making it a `jump` host would turn every dependent into a two-hop chain
       * that `resolveProxy` refuses at dial time ("itself uses a jump host"), so
       * the change landed here and broke someone ELSE's dials later without a
       * word. Refusing it at save time is the only place the user can still see
       * which host is in the way. (The reverse direction — creating a host that
       * jumps through a jump host — stays allowed on purpose: that setting is new
       * and its own row says why it cannot work today.)
       */
      if (proxyModeOf(next.proxy?.mode) === 'jump' && proxyModeOf(current.proxy?.mode) !== 'jump') {
        const dependent = this.doc.hosts.find(
          host => host.alias !== alias
            && proxyModeOf(host.proxy?.mode) === 'jump'
            && host.proxy?.jump?.viaAlias === alias,
        )
        if (dependent !== undefined) {
          throw new Error(`host "${dependent.alias}" jumps through this host; change it first`)
        }
      }
      this.doc.hosts[index] = next
      return next
    })
  }

  /**
   * Delete one host AND its workspace bindings.
   *
   * The cascade has to keep the tombstone contract (see `removeWorkspace`): a
   * binding that disappears while its alias dir stays on disk is no longer
   * routed, but DSH's workspace registry still lists that dir, so a session
   * rooted there would quietly execute LOCALLY against an empty folder instead
   * of failing closed. Every cascaded binding is therefore tombstoned in the
   * SAME atomic write as the removal — there is no on-disk state where the
   * binding is gone but its tombstone is missing.
   */
  remove(alias: string): boolean {
    return this.mutate(() => {
      const hosts = this.doc.hosts.filter(h => h.alias !== alias)
      // Unknown alias: do not mutate (and do not record tombstones for nothing).
      if (hosts.length === this.doc.hosts.length) return false
      this.doc.hosts = hosts
      for (const binding of this.doc.workspaces) {
        if (binding.alias === alias) this.recordTombstone(join(aliasRoot(), binding.id))
      }
      this.doc.workspaces = this.doc.workspaces.filter(w => w.alias !== alias)
      return true
    })
  }

  private normalize(payload: HostPayload, current: RemoteHostEntry | undefined): RemoteHostEntry {
    if (typeof payload.host !== 'string' || payload.host.trim() === '') throw new Error('host must be a non-empty string')
    const port = payload.port ?? 22
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be an integer 1-65535')
    if (typeof payload.user !== 'string' || payload.user.trim() === '') throw new Error('user must be a non-empty string')
    const auth = payload.auth
    if (auth === undefined || (auth.kind !== 'key' && auth.kind !== 'password')) {
      throw new Error('auth.kind must be key or password')
    }
    if (auth.kind === 'key') {
      if (typeof auth.keyPath !== 'string' || auth.keyPath.trim() === '') throw new Error('auth.keyPath is required for key auth')
      if (auth.passphrase !== undefined && typeof auth.passphrase !== 'string') throw new Error('auth.passphrase must be a string when provided')
    } else {
      if (typeof auth.password !== 'string' || auth.password === '') throw new Error('auth.password must be a non-empty string for password auth')
    }
    if (payload.description !== undefined && typeof payload.description !== 'string') throw new Error('description must be a string when provided')
    if (payload.tags !== undefined && (!Array.isArray(payload.tags) || payload.tags.some(t => typeof t !== 'string'))) {
      throw new Error('tags must be string[] when provided')
    }
    // `inherit` is the absence of a decision, so it is stored as absence
    // (an older file keeps loading, and a client that ignores the field is right).
    const proxy = payload.proxy === undefined
      ? undefined
      : this.validateHostProxy(payload.proxy, payload.alias, current)
    const now = Date.now()
    return {
      alias: payload.alias,
      host: payload.host.trim(),
      port,
      user: payload.user.trim(),
      auth: {
        kind: auth.kind,
        ...(auth.keyPath !== undefined ? { keyPath: auth.keyPath } : {}),
        ...(auth.passphrase !== undefined ? { passphrase: auth.passphrase } : {}),
        ...(auth.password !== undefined ? { password: auth.password } : {}),
      },
      ...(proxy === undefined ? {} : { proxy }),
      ...(payload.description !== undefined ? { description: payload.description } : {}),
      tags: payload.tags ?? [],
      ...(current?.deploy !== undefined ? { deploy: current.deploy } : {}),
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    }
  }

  /**
   * Validate one host's stored proxy decision.
   *
   * The rules are the ones the two-level model needs to stay explainable:
   * - the mode is one of the four declared values;
   * - `proxy` needs an endpoint, `jump` needs another EXISTING alias (a host
   *   cannot jump through itself, and a chain is impossible to resolve with one
   *   pooled hop);
   * - fields that the chosen mode does not use are DROPPED rather than stored, so
   *   switching modes cannot leave a stale endpoint behind that a later reader
   *   would take for the active one.
   *
   * @returns the normalized setting, or undefined for `inherit` (stored as the
   *   field's absence, which is what older files have).
   */
  private validateHostProxy(
    input: RemoteHostProxySetting,
    alias: string,
    current: RemoteHostEntry | undefined,
  ): RemoteHostProxySetting | undefined {
    if (typeof input !== 'object' || input === null) throw new Error('proxy must be an object')
    const mode = input.mode
    if (!PROXY_MODES.includes(mode)) {
      throw new Error('proxy.mode must be inherit, direct, proxy or jump')
    }
    if (mode === 'inherit') return undefined
    if (mode === 'direct') return { mode }
    if (mode === 'proxy') {
      if (input.proxy === undefined) throw new Error('proxy.mode "proxy" requires a proxy endpoint')
      /*
       * The browser never receives the stored password back, so an untouched
       * egress decision arrives WITHOUT one — and a PATCH that only changes the
       * description resends that decision. Merging here (the same rule
       * `mergeProxyTarget` applies to the profile default) is what keeps the
       * password alive: without it, editing any field wiped it and the next dial
       * failed with 407. An empty/omitted password keeps the stored one; the way
       * to clear it is to leave `proxy` mode (which drops the endpoint).
       */
      return { mode, proxy: this.mergeProxyTarget(input.proxy, current?.proxy?.proxy) }
    }
    const viaAlias = input.jump?.viaAlias
    if (typeof viaAlias !== 'string' || viaAlias === '') {
      throw new Error('proxy.mode "jump" requires proxy.jump.viaAlias')
    }
    if (viaAlias === alias) throw new Error('proxy.jump.viaAlias must name another host, not this one')
    if (!this.doc.hosts.some(host => host.alias === viaAlias)) {
      throw new Error(`proxy.jump.viaAlias: unknown host alias ${viaAlias}`)
    }
    return { mode, jump: { viaAlias } }
  }

  /**
   * Why a host's proxy decision cannot be used, when it cannot.
   *
   * Reads NEVER throw for this: a host that points at a deleted jump host must
   * still be listed (with the reason on its row) instead of making the whole host
   * list fail. The dial path asks {@link resolveProxy}, which does fail closed.
   */
  private proxyProblem(entry: RemoteHostEntry, mode: RemoteProxyMode): string | undefined {
    const setting = entry.proxy
    if (mode === 'proxy') {
      if (setting?.proxy === undefined) return 'proxy mode is selected but no proxy endpoint is configured'
      try {
        normalizeProxy(setting.proxy)
        return undefined
      } catch (error) {
        return messageOf(error)
      }
    }
    if (mode !== 'jump') return undefined
    const viaAlias = setting?.jump?.viaAlias
    if (viaAlias === undefined || viaAlias === '') return 'jump mode is selected but no jump host is configured'
    if (viaAlias === entry.alias) return 'a host cannot jump through itself'
    const via = this.doc.hosts.find(host => host.alias === viaAlias)
    if (via === undefined) return `jump host "${viaAlias}" is not configured`
    if (proxyModeOf(via.proxy?.mode) === 'jump') return `jump host "${viaAlias}" itself uses a jump host (one hop only)`
    return undefined
  }

  /** Secret-free view of one stored proxy endpoint. */
  private targetView(setting: RemoteProxySetting | ProxyConfig): RemoteProxyTargetView {
    return {
      kind: setting.kind,
      host: setting.host,
      port: setting.port,
      ...(setting.username === undefined || setting.username === '' ? {} : { username: setting.username }),
      hasPassword: typeof setting.password === 'string' && setting.password !== '',
    }
  }

  /** Secret-free view of one host's proxy decision (always present). */
  private proxyView(entry: RemoteHostEntry): RemoteHostProxyView {
    const mode = proxyModeOf(entry.proxy?.mode)
    const view: RemoteHostProxyView = { mode }
    if (entry.proxy?.proxy !== undefined) {
      try {
        view.target = this.targetView(normalizeProxy(entry.proxy.proxy))
      } catch {
        // The problem string below carries the reason.
      }
    }
    if (entry.proxy?.jump?.viaAlias !== undefined) view.jumpVia = entry.proxy.jump.viaAlias
    const problem = this.proxyProblem(entry, mode)
    if (problem !== undefined) view.problem = problem
    return view
  }

  /** Secret-free projection for browser/agent surfaces. */
  summarize(entry: RemoteHostEntry): RemoteHostSummary {
    let keyReady = false
    if (entry.auth.kind === 'key' && entry.auth.keyPath !== undefined) {
      try {
        keyReady = existsSync(entry.auth.keyPath)
      } catch {
        keyReady = false
      }
    }
    return {
      alias: entry.alias,
      host: entry.host,
      port: entry.port,
      user: entry.user,
      auth: entry.auth.kind,
      keyReady,
      managedKey: entry.auth.kind === 'key'
        && entry.auth.keyPath !== undefined
        && entry.auth.keyPath.startsWith(keysDir() + (process.platform === 'win32' ? '\\' : '/')),
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      tags: [...entry.tags],
      proxy: this.proxyView(entry),
      ...(entry.deploy !== undefined ? { deploy: entry.deploy } : {}),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }
  }

  // ------------------------------------------------------ proxy defaults

  /** Secret-free view of the profile-wide proxy default (read-only). */
  getDefaultProxy(): RemoteProxySettingsView {
    this.reload()
    return this.defaultProxyView()
  }

  /** View of the in-memory document (no reload: callers already reloaded). */
  private defaultProxyView(): RemoteProxySettingsView {
    const stored = this.doc.defaultProxy
    const view: RemoteProxySettingsView = { defaultMode: stored?.mode === 'proxy' ? 'proxy' : 'direct' }
    if (stored?.proxy !== undefined) {
      try {
        view.target = this.targetView(normalizeProxy(stored.proxy))
      } catch {
        // A malformed stored endpoint is not addressable: report direct instead of
        // echoing a target nobody could dial (the dial path fails closed too).
        view.defaultMode = 'direct'
      }
    } else if (view.defaultMode === 'proxy') {
      // "proxy" without an endpoint is not a usable default; the upgrade-safe
      // answer is direct until the user (or a patch) supplies one.
      view.defaultMode = 'direct'
    }
    return view
  }

  /**
   * Patch the profile-wide proxy default.
   *
   * `target` semantics follow the host form: omitted keeps the stored endpoint,
   * `null` clears it, an object replaces it — and an EMPTY PASSWORD keeps the
   * stored one, because the browser never receives secrets back.
   */
  patchDefaultProxy(patch: RemoteProxySettingsPatch): RemoteProxySettingsView {
    if (typeof patch !== 'object' || patch === null) throw new Error('proxy settings patch must be an object')
    return this.mutate(() => {
      const current: StoredDefaultProxy = this.doc.defaultProxy ?? { mode: 'direct' }
      let proxy = current.proxy
      if (patch.target === null) {
        proxy = undefined
      } else if (patch.target !== undefined) {
        proxy = this.mergeProxyTarget(patch.target, current.proxy)
      }
      const mode = patch.defaultMode ?? current.mode
      if (mode !== 'direct' && mode !== 'proxy') throw new Error("defaultMode must be 'direct' or 'proxy'")
      if (mode === 'proxy' && proxy === undefined) {
        throw new Error('defaultMode "proxy" requires a proxy target')
      }
      this.doc.defaultProxy = { mode, ...(proxy === undefined ? {} : { proxy }) }
      return this.defaultProxyView()
    })
  }

  /**
   * Normalize a patched endpoint, keeping the stored password on an empty one.
   *
   * "Empty means keep" is only sound for the SAME endpoint: the browser never
   * receives the secret back, so every PATCH of a proxied host arrives without
   * one — but when kind/host/port/username changed, the stored password is a
   * credential for a DIFFERENT server, and carrying it over would send the old
   * secret to a new address (a 407 at best, a leaked credential at worst). A
   * changed endpoint therefore drops it and the user re-enters it.
   */
  private mergeProxyTarget(target: RemoteProxySetting, current: ProxyConfig | undefined): ProxyConfig {
    const next = normalizeProxy(target)
    const password = typeof target.password === 'string' ? target.password : ''
    if (password === '') {
      const sameEndpoint = current !== undefined
        && current.kind === next.kind
        && current.host === next.host
        && current.port === next.port
        && (current.username ?? '') === (next.username ?? '')
      if (sameEndpoint && current.password !== undefined) next.password = current.password
      else delete next.password
    }
    return next
  }

  /**
   * Resolve one host's EFFECTIVE route, in the precedence the UI describes:
   * the host's own decision, else the profile default, else direct.
   *
   * Unlike {@link summarize}, this FAILS CLOSED for an unusable jump: dialing
   * through a deleted host (or a second jump) cannot work, and the caller must say
   * why instead of silently connecting some other way.
   */
  resolveProxy(alias: string): ResolvedProxy {
    const entry = this.require(alias)
    const mode = proxyModeOf(entry.proxy?.mode)
    if (mode === 'direct') return { kind: 'direct' }
    if (mode === 'proxy') {
      const stored = entry.proxy?.proxy
      if (stored === undefined) {
        throw new Error(`host ${alias}: proxy mode is selected but no proxy endpoint is configured`)
      }
      return { kind: 'proxy', proxy: this.requireStoredProxy(stored, alias), source: 'host' }
    }
    if (mode === 'jump') {
      const viaAlias = entry.proxy?.jump?.viaAlias
      if (viaAlias === undefined || viaAlias === '') {
        throw new Error(`host ${alias}: jump mode is selected but no jump host is configured`)
      }
      if (viaAlias === alias) throw new Error(`host ${alias}: a host cannot jump through itself`)
      const via = this.get(viaAlias)
      if (via === undefined) throw new Error(`host ${alias}: jump host "${viaAlias}" is not configured`)
      if (proxyModeOf(via.proxy?.mode) === 'jump') {
        throw new Error(`host ${alias}: jump host "${viaAlias}" itself uses a jump host (one hop only)`)
      }
      return { kind: 'jump', viaAlias }
    }
    const storedDefault = this.doc.defaultProxy
    if (storedDefault?.mode === 'proxy' && storedDefault.proxy !== undefined) {
      return { kind: 'proxy', proxy: this.requireStoredProxy(storedDefault.proxy, alias), source: 'default' }
    }
    return { kind: 'direct' }
  }

  private requireStoredProxy(stored: RemoteProxySetting | ProxyConfig, alias: string): ProxyConfig {
    try {
      return normalizeProxy(stored)
    } catch (error) {
      throw new Error(`host ${alias}: invalid proxy configuration (${messageOf(error)})`)
    }
  }

  setDeploy(alias: string, state: RemoteDeployState): void {
    this.mutate(() => {
      const entry = this.doc.hosts.find(h => h.alias === alias)
      if (entry === undefined) throw new Error(`unknown host alias: ${alias}`)
      entry.deploy = state
      entry.updatedAt = Date.now()
    })
  }

  // -------------------------------------------------------- workspaces

  listWorkspaces(): RemoteWorkspaceBinding[] {
    this.reload()
    return [...this.doc.workspaces]
  }

  createWorkspace(payload: WorkspacePayload): RemoteWorkspaceBinding {
    if (typeof payload.name !== 'string' || payload.name.trim() === '') throw new Error('name must be a non-empty string')
    if (typeof payload.remotePath !== 'string' || !payload.remotePath.startsWith('/')) {
      throw new Error('remotePath must be an absolute POSIX path')
    }
    return this.mutate(() => {
      if (!this.doc.hosts.some(host => host.alias === payload.alias)) {
        throw new Error(`unknown host alias: ${payload.alias}`)
      }
      const binding: RemoteWorkspaceBinding = {
        id: randomUUID().slice(0, 8),
        name: payload.name.trim(),
        alias: payload.alias,
        remotePath: payload.remotePath,
        createdAt: Date.now(),
      }
      this.doc.workspaces.push(binding)
      return binding
    })
  }

  removeWorkspace(id: string): boolean {
    return this.mutate(() => {
      const victim = this.doc.workspaces.find(w => w.id === id)
      if (victim === undefined) return false
      // Tombstone the alias BEFORE dropping the binding (history stays readable,
      // new tool calls fail closed instead of silently running locally).
      this.recordTombstone(join(aliasRoot(), id))
      this.doc.workspaces = this.doc.workspaces.filter(w => w.id !== id)
      return true
    })
  }

  /**
   * Record one tombstone without writing (idempotent).
   *
   * The caller owns `save()` so a change covering several bindings lands in ONE
   * atomic write: a crash between two writes must never leave a binding removed
   * while its tombstone is still missing.
   */
  private recordTombstone(aliasPath: string): void {
    if (!this.doc.tombstones.includes(aliasPath)) this.doc.tombstones.push(aliasPath)
  }

  /** Record a removed alias path (idempotent). */
  addTombstone(aliasPath: string): void {
    this.mutate(() => {
      this.recordTombstone(aliasPath)
    })
  }

  listTombstones(): string[] {
    this.reload()
    return [...this.doc.tombstones]
  }
}
