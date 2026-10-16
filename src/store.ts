/**
 * Durable store for dsh-remote-vs: hosts + workspace bindings in
 * $DSH_HOME/dsh-remote.json (0600, atomic tmp+rename writes).
 */
import { existsSync, statSync, openSync, readFileSync, renameSync, writeSync, closeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { aliasRoot, keysDir, storePath } from './paths.ts'
import type {
  RemoteDeployState,
  RemoteHostEntry,
  RemoteHostSummary,
  RemoteWorkspaceBinding,
} from './protocol.ts'

/** On-disk document shape. */
interface StoreDoc {
  version: 1
  hosts: RemoteHostEntry[]
  workspaces: RemoteWorkspaceBinding[]
  /** Removed alias dirs (fail-closed tombstones; never auto-deleted). */
  tombstones: string[]
}

/** Empty document. */
function emptyDoc(): StoreDoc {
  return { version: 1, hosts: [], workspaces: [], tombstones: [] }
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

/** Payload accepted by create/update (secrets included, host-side only). */
export interface HostPayload {
  alias: string
  host: string
  port?: number
  user: string
  auth: { kind: 'key' | 'password'; keyPath?: string; passphrase?: string; password?: string }
  description?: string
  tags?: string[]
}

export interface WorkspacePayload {
  name: string
  alias: string
  remotePath: string
}

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
    }
  }

  private save(): void {
    // The caller already mutated `doc`, so in-memory state is ahead of the file:
    // invalidate the stamp. A failed write must not pin the dirty doc in place
    // (the next read goes back to the file, as it always did), and a successful
    // one is picked up by that same re-read, which re-arms the fast path.
    this.stamp = undefined
    const payload = JSON.stringify(this.doc, null, 2)
    const tmp = `${this.file}.${process.pid}.tmp`
    // 0600 from creation (Windows: best effort, mode is advisory there).
    const fd = openSync(tmp, 'w', 0o600)
    try {
      writeSync(fd, payload)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, this.file)
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
    if (this.get(payload.alias) !== undefined) throw new Error(`alias already exists: ${payload.alias}`)
    const entry = this.normalize(payload, undefined)
    this.doc.hosts.push(entry)
    this.save()
    return entry
  }

  update(alias: string, patch: Partial<Omit<HostPayload, 'alias'>>): RemoteHostEntry {
    const current = this.require(alias)
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
      description: patch.description ?? current.description,
      tags: patch.tags ?? current.tags,
    }
    const next = this.normalize(merged, current)
    const index = this.doc.hosts.findIndex(h => h.alias === alias)
    this.doc.hosts[index] = next
    this.save()
    return next
  }

  remove(alias: string): boolean {
    const before = this.doc.hosts.length
    this.doc.hosts = this.doc.hosts.filter(h => h.alias !== alias)
    this.doc.workspaces = this.doc.workspaces.filter(w => w.alias !== alias)
    if (this.doc.hosts.length === before) return false
    this.save()
    return true
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
      ...(payload.description !== undefined ? { description: payload.description } : {}),
      tags: payload.tags ?? [],
      ...(current?.deploy !== undefined ? { deploy: current.deploy } : {}),
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    }
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
      ...(entry.deploy !== undefined ? { deploy: entry.deploy } : {}),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }
  }

  setDeploy(alias: string, state: RemoteDeployState): void {
    const entry = this.require(alias)
    entry.deploy = state
    entry.updatedAt = Date.now()
    this.save()
  }

  // -------------------------------------------------------- workspaces

  listWorkspaces(): RemoteWorkspaceBinding[] {
    this.reload()
    return [...this.doc.workspaces]
  }

  createWorkspace(payload: WorkspacePayload): RemoteWorkspaceBinding {
    if (typeof payload.name !== 'string' || payload.name.trim() === '') throw new Error('name must be a non-empty string')
    this.require(payload.alias)
    if (typeof payload.remotePath !== 'string' || !payload.remotePath.startsWith('/')) {
      throw new Error('remotePath must be an absolute POSIX path')
    }
    const binding: RemoteWorkspaceBinding = {
      id: randomUUID().slice(0, 8),
      name: payload.name.trim(),
      alias: payload.alias,
      remotePath: payload.remotePath,
      createdAt: Date.now(),
    }
    this.doc.workspaces.push(binding)
    this.save()
    return binding
  }

  removeWorkspace(id: string): boolean {
    this.reload()
    const victim = this.doc.workspaces.find(w => w.id === id)
    if (victim === undefined) return false
    // Tombstone the alias BEFORE dropping the binding (history stays readable,
    // new tool calls fail closed instead of silently running locally).
    this.addTombstone(join(aliasRoot(), id))
    this.doc.workspaces = this.doc.workspaces.filter(w => w.id !== id)
    this.save()
    return true
  }

  /** Record a removed alias path (idempotent). */
  addTombstone(aliasPath: string): void {
    if (!this.doc.tombstones.includes(aliasPath)) {
      this.doc.tombstones.push(aliasPath)
      this.save()
    }
  }

  listTombstones(): string[] {
    this.reload()
    return [...this.doc.tombstones]
  }
}
