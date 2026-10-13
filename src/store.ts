/**
 * Durable store for dsh-remote-vs: hosts + workspace bindings in
 * $DSH_HOME/dsh-remote.json (0600, atomic tmp+rename writes).
 */
import { existsSync, openSync, readFileSync, renameSync, writeSync, closeSync } from 'node:fs'
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

  constructor(file?: string) {
    this.file = file ?? storePath()
    this.doc = this.loadDoc()
  }

  /** Reload from disk (picks up external edits). */
  reload(): void {
    this.doc = this.loadDoc()
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
  // NOTE: reads reload from disk first (the file is tiny; routers + routes +
  // GUI always see fresh state without a watcher).

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
