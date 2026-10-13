/**
 * Remote worlds: alias registry, tombstones, cwd-keyed routing decisions,
 * per-host helper RPC connections and remote fs views. The routers consult
 * this service; it owns no tools itself.
 *
 * Routing answers one question per call — "which world?" — and never falls
 * back silently: unknown sessions stay local (system callers), tombstoned
 * aliases throw, everything else follows the alias map.
 */
import { mkdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-sandbox'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-workspace'
import type { RemoteStore } from '../store.ts'
import type { RemotePool } from '../pool.ts'
import { probe, pushPipeline } from '../deploy.ts'
import { aliasRoot } from '../paths.ts'
import type { RemoteHostEntry, RemoteWorkspaceBinding } from '../protocol.ts'
import { RpcConnection } from './helper-rpc.ts'
import { SshProcRuntime } from './ssh-proc.ts'

export type RoutingMode = 'off' | 'shadow' | 'enforce'

export type WorldRoute =
  | { kind: 'local' }
  | { kind: 'remote'; id: string; alias: string; aliasPath: string; remotePath: string }

export class TombstonedError extends Error {
  constructor(readonly aliasPath: string) {
    super(`remote workspace mapping was removed: ${aliasPath} (history kept, tools refused)`)
    this.name = 'TombstonedError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteWorlds: RemoteWorlds
  }
}

export interface WorldsDeps {
  store: RemoteStore
  pool: RemotePool
  /** Live kill-switch (volatile config ref). */
  mode: () => RoutingMode
}

interface FsView {
  child: Context
  fs: FileSystem
}

/** Untyped provide: 'ssh' has no Context key in compositions without official dsh-ssh. */
function provideRaw(ctx: Context, name: string, value: unknown): void {
  (ctx as unknown as { provide(name: string, value: unknown): void }).provide(name, value)
}

/** True for drive-letter and UNC absolutes (never remote-meaningful). */
function isWindowsAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

export class RemoteWorlds {
  private readonly rpcs = new Map<string, Promise<RpcConnection>>()
  private readonly fsViews = new Map<string, Promise<FsView>>()
  private readonly fsReady = new Map<string, FileSystem>()
  private readonly procs = new Map<string, SshProcRuntime>()

  constructor(
    private readonly ctx: Context,
    private readonly deps: WorldsDeps,
  ) {}

  get mode(): RoutingMode {
    try {
      return this.deps.mode()
    } catch {
      return 'off'
    }
  }

  aliasPathFor(bindingId: string): string {
    return join(aliasRoot(), bindingId)
  }

  // ------------------------------------------------------------ decisions

  /** Compare paths with platform semantics (case-insensitive on Windows). */
  private same(left: string, right: string): boolean {
    if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase()
    return left === right
  }

  /** True when child is at/inside parent (boundary-aware). */
  private contains(parent: string, child: string): boolean {
    const root = resolve(parent)
    const target = resolve(child)
    if (this.same(root, target)) return true
    const rel = relative(root, target)
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  }

  /** Public containment check for routers (alias mapping without decisions). */
  underAlias(aliasPath: string, path: string): boolean {
    return this.contains(aliasPath, path)
  }

  private aliasFor(dir: string): RemoteWorkspaceBinding | undefined {
    let best: RemoteWorkspaceBinding | undefined
    for (const binding of this.deps.store.listWorkspaces()) {
      if (this.contains(this.aliasPathFor(binding.id), dir)) {
        if (best === undefined || this.aliasPathFor(binding.id).length > this.aliasPathFor(best.id).length) {
          best = binding
        }
      }
    }
    return best
  }

  private tombstoneFor(dir: string): string | undefined {
    return this.deps.store.listTombstones().find(t => this.contains(t, dir))
  }

  /** Route one directory (a session cwd): local, remote, or tombstone-throw. */
  routeDir(dir: string | undefined): WorldRoute {
    if (dir === undefined || dir.trim() === '') return { kind: 'local' }
    const binding = this.aliasFor(dir)
    if (binding !== undefined) {
      return {
        kind: 'remote',
        id: binding.id,
        alias: binding.alias,
        aliasPath: this.aliasPathFor(binding.id),
        remotePath: binding.remotePath,
      }
    }
    const tomb = this.tombstoneFor(dir)
    if (tomb !== undefined) throw new TombstonedError(tomb)
    return { kind: 'local' }
  }

  /**
   * Route a (path, cwd) pair. Tombstoned cwd throws first (fail-closed dead
   * sessions, regardless of path spelling); otherwise alias-contained paths
   * stay remote (alias dirs are Windows-spelled but remote-meaningful), while
   * other Windows absolutes are local-unambiguous — a non-alias Windows path
   * can never name a remote file, so it routes local even from a remote
   * session (tool seam spillPaths live on the Host by contract and the model
   * reads them back from remote sessions; 2026-10-13). Relative paths and
   * POSIX absolutes follow the session world.
   */
  routePath(path: string, cwd?: string): WorldRoute {
    if (cwd !== undefined && cwd.trim() !== '') {
      const byCwd = this.routeDir(cwd)
      // routeDir throws on tombstoned cwd (fail-closed dead sessions).
      if (byCwd.kind === 'remote') {
        if (isWindowsAbsolute(path) && !this.underAlias(byCwd.aliasPath, path)) return { kind: 'local' }
        return byCwd
      }
    }
    if (isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) {
      return this.routeDir(path)
    }
    return { kind: 'local' }
  }

  /** Route by owner session id (spill): unknown sessions stay local. */
  sessionWorld(sessionId: SessionId): WorldRoute {
    try {
      // Soft reads (no inject waiting, no throw): system callers and
      // half-booted compositions resolve local, never crash routing.
      const agents = this.ctx.get('agents')
      const workingDirectory = this.ctx.get('workingDirectory')
      if (agents === undefined || workingDirectory === undefined) return { kind: 'local' }
      const agent = agents.get(sessionId)
      if (agent === undefined) return { kind: 'local' }
      return this.routeDir(workingDirectory.get(agent.session))
    } catch (error) {
      if (error instanceof TombstonedError) throw error
      return { kind: 'local' }
    }
  }

  /** Map a local alias path to its remote absolute path. */
  toRemotePath(route: Extract<WorldRoute, { kind: 'remote' }>, localAbsPath: string): string {
    const rel = relative(route.aliasPath, resolve(localAbsPath))
    const posixRel = rel === '' ? '' : rel.split(sep).join('/')
    const base = route.remotePath.endsWith('/') && route.remotePath !== '/' ? route.remotePath.slice(0, -1) : route.remotePath
    return posixRel === '' ? base : `${base}/${posixRel}`
  }

  /** Rewrite a sandbox policy root into the remote world when it sits under the alias. */
  rewritePolicy<T extends { workspaceRoot?: string }>(policy: T | undefined, route: WorldRoute): T | undefined {
    if (policy === undefined || route.kind !== 'remote') return policy
    const root = policy.workspaceRoot
    if (typeof root !== 'string' || root === '') return policy
    if (!this.contains(route.aliasPath, root)) return policy
    return { ...policy, workspaceRoot: this.toRemotePath(route, root) }
  }

  /** Shadow-mode note (remote/tombstone decisions only; locals stay silent). */
  note(route: WorldRoute, what: string): void {
    if (this.mode !== 'shadow') return
    if (route.kind === 'local') return
    try {
      this.ctx.logger.info(`[remote-vs shadow] ${what} -> ${route.alias}:${route.remotePath}`)
    } catch {
      // Logging must never break routing.
    }
  }

  // ------------------------------------------------------------ materialize

  /** Ensure alias dirs + native registry entries for every binding. */
  async syncWorkspaces(): Promise<void> {
    const bindings = this.deps.store.listWorkspaces()
    // Soft read: at boot the registry may not be ready yet (it waits for
    // session persistence) — mkdir still runs, registry entries retry on the
    // next sync (every workspaces GET/POST re-runs this; the GUI always GETs).
    const registry = this.ctx.get('workspaceRegistry') as
      | {
        resolveByPath(path: string): Promise<unknown>
        create(path: string, title?: string): Promise<unknown>
      }
      | undefined
    for (const binding of bindings) {
      const aliasPath = this.aliasPathFor(binding.id)
      try {
        mkdirSync(aliasPath, { recursive: true })
      } catch (error) {
        // Per-binding loud + continue: one bad binding must neither abort the
        // whole sync nor fail silently (2026-10-13: a swallowed mkdir failure
        // surfaced downstream as a cryptic owner ENOENT).
        try {
          this.ctx.logger.warn(`[remote-vs] alias mkdir failed for ${aliasPath}: ${error instanceof Error ? error.message : String(error)}`)
        } catch {
          // Ignore.
        }
        continue
      }
      if (registry === undefined) continue
      try {
        const existing = await registry.resolveByPath(aliasPath)
        if (existing !== undefined) continue
        const base = binding.remotePath.split('/').filter(Boolean).pop() ?? binding.remotePath
        await registry.create(aliasPath, `${binding.alias} > ${base}`)
      } catch (error) {
        try {
          this.ctx.logger.warn(`[remote-vs] workspace registration failed for ${aliasPath}: ${error instanceof Error ? error.message : String(error)}`)
        } catch {
          // Ignore.
        }
      }
    }
  }

  // ------------------------------------------------------------ remote contexts

  /** Remote $HOME for one host alias (deploy record, else one probe). */
  async homeFor(alias: string): Promise<string> {
    const home = this.deps.store.require(alias).deploy?.home
    if (home !== undefined && home !== '') return home
    const probed = await probe(this.deps.pool, alias)
    if (!probed.ok || probed.home === undefined || probed.home === '') {
      throw new Error(`cannot locate remote home for ${alias}: ${probed.error ?? 'probe failed'}`)
    }
    return probed.home
  }

  /** Best-effort remote mkdir -p (for paths the fs seam cannot create). */
  async mkdirRemote(alias: string, dir: string): Promise<void> {
    if (!dir.startsWith('/')) throw new Error(`refusing non-absolute remote dir: ${dir}`)
    const quoted = `'${dir.replace(/'/g, `'\\''`)}'`
    const result = await this.deps.pool.exec(alias, `mkdir -p ${quoted} && chmod 700 ${quoted}`, { timeoutMs: 15000 })
    if (!result.success) {
      throw new Error(`remote mkdir failed: ${result.stderr || result.error || `exit ${result.exitCode}`}`)
    }
  }

  /** Drop one host's RPC + fs view + proc runtime (call after host update/delete). */
  async dropHost(alias: string): Promise<void> {
    this.fsReady.delete(alias)
    const proc = this.procs.get(alias)
    this.procs.delete(alias)
    if (proc !== undefined) await proc.dispose().catch(() => undefined)
    const rpc = this.rpcs.get(alias)
    this.rpcs.delete(alias)
    if (rpc !== undefined) {
      const conn = await rpc.catch(() => undefined)
      if (conn !== undefined) await conn.dispose().catch(() => undefined)
    }
    const view = this.fsViews.get(alias)
    this.fsViews.delete(alias)
    if (view !== undefined) {
      const resolved = await view.catch(() => undefined)
      if (resolved !== undefined) {
        try {
          await resolved.child.fiber.dispose()
        } catch {
          // Ignore.
        }
      }
    }
  }

  async dispose(): Promise<void> {
    for (const alias of new Set([...this.rpcs.keys(), ...this.fsViews.keys(), ...this.procs.keys()])) {
      await this.dropHost(alias).catch(() => undefined)
    }
  }

  /** Remote fs view for one host alias (official fs-ssh on our RPC). */
  async fsFor(alias: string): Promise<FileSystem> {
    const ready = this.fsReady.get(alias)
    if (ready !== undefined) return ready
    let pending = this.fsViews.get(alias)
    if (pending === undefined) {
      pending = this.createFsView(alias)
      this.fsViews.set(alias, pending)
      void pending.catch(() => {
        if (this.fsViews.get(alias) === pending) this.fsViews.delete(alias)
      })
    }
    const view = await pending
    this.fsReady.set(alias, view.fs)
    return view.fs
  }

  /** Sync accessor for already-warm views (sync seams only, never creates). */
  cachedFs(alias: string): FileSystem | undefined {
    return this.fsReady.get(alias)
  }

  /** Shared ssh process runtime for one host alias. */
  procFor(alias: string): SshProcRuntime {
    let runtime = this.procs.get(alias)
    if (runtime === undefined) {
      runtime = new SshProcRuntime(this.deps.pool, alias)
      this.procs.set(alias, runtime)
    }
    return runtime
  }

  private async createFsView(alias: string): Promise<FsView> {
    const rpc = await this.rpcFor(alias)
    // Remote-adapted sandbox policy: fs-ssh falls back to
    // ctx.sandboxPolicy.resolve() when a call carries no explicit policy, and
    // the helper validates workspaceRoot as an absolute POSIX path — a local
    // Windows root would be rejected. Callers with explicit (rewritten)
    // policies are unaffected; this default only covers policy-less calls
    // (spill, ad-hoc writes) with the remote home as the world root.
    const home = await this.homeFor(alias)
    // Soft read (ctx.get, never throws): the sandboxPolicy service is root
    // infrastructure, but exotic compositions (or a future service rename)
    // must degrade to a sane default, never fail remote fs. The default only
    // covers policy-less calls; explicit (rewritten) policies bypass it
    // entirely. Mode mirrors this deployment (danger-full-access);
    // workspaceRoot is fenced below.
    let parentPolicy: { resolve?: (...args: never[]) => unknown } | undefined
    try {
      const raw: unknown = this.ctx.get('sandboxPolicy')
      parentPolicy = (typeof raw === 'object' && raw !== null ? raw : undefined) as typeof parentPolicy
    } catch {
      parentPolicy = undefined
    }
    const remotePolicy = {
      ...((typeof parentPolicy === 'object' && parentPolicy !== null ? parentPolicy : {}) as Record<string, unknown>),
      resolve: (...args: never[]): unknown => {
        const base = typeof parentPolicy?.resolve === 'function' ? parentPolicy.resolve(...args) : undefined
        const rec = (typeof base === 'object' && base !== null ? base : {}) as Record<string, unknown>
        const root = rec.workspaceRoot
        const workspaceRoot = typeof root === 'string' && root.startsWith('/') ? root : home
        // Mode fallback mirrors this deployment; only reachable when the
        // parent policy service itself is unreadable (inject covers it).
        const mode = typeof rec.mode === 'string' ? rec.mode : 'danger-full-access'
        return { ...rec, mode, workspaceRoot }
      },
    }
    const child = new Context()
    try {
      provideRaw(child, 'ssh', {
        ready: rpc.ready,
        request: (method: string, params: unknown, schema: never, signal?: AbortSignal) =>
          rpc.request(method, params, schema, signal),
        connectStream: () => {
          throw new Error('P2-v1: helper streams are not implemented (processes ride ssh2)')
        },
        dispose: () => rpc.dispose(),
      })
      provideRaw(child, 'sandboxPolicy', remotePolicy)
      const { default: SshFileSystem } = await import('@deepseek-ai/dsh-fs-ssh')
      await child.plugin(SshFileSystem)
      const fs = (child as unknown as Record<string, FileSystem>).fs
      if (fs === undefined) throw new Error('fs-ssh did not provide ctx.fs')
      return { child, fs }
    } catch (error) {
      try {
        await child.fiber.dispose()
      } catch {
        // Ignore.
      }
      throw error
    }
  }

  /** Shared helper RPC connection for one host alias (auto-deploys). */
  async rpcFor(alias: string): Promise<RpcConnection> {
    let pending = this.rpcs.get(alias)
    if (pending === undefined) {
      pending = this.createRpc(alias)
      this.rpcs.set(alias, pending)
      void pending.catch(() => {
        if (this.rpcs.get(alias) === pending) this.rpcs.delete(alias)
      })
    }
    const conn = await pending
    if (!conn.alive) {
      this.rpcs.delete(alias)
      return this.rpcFor(alias)
    }
    return conn
  }

  private async createRpc(alias: string): Promise<RpcConnection> {
    const entry: RemoteHostEntry = this.deps.store.require(alias)
    let deploy = entry.deploy
    if (deploy?.artifact === undefined || !deploy.artifact.startsWith('dsh-ssh-helper/') || deploy.helper === undefined) {
      // First contact (or legacy marker): auto-deploy, VSCode-style.
      const report = await pushPipeline(this.deps.pool, this.deps.store, alias)
      if (report.action === 'failed') {
        throw new Error(`helper auto-deploy failed: ${report.detail}`)
      }
      deploy = this.deps.store.require(alias).deploy
    }
    const helper = deploy?.helper
    if (helper === undefined) throw new Error(`no helper deployed for ${alias}`)
    let home = deploy?.home
    let platform = helper.platform
    if (home === undefined || home === '' || platform === undefined || platform === '') {
      // Pre-P2 deploy record: backfill coordinates with one probe.
      const probed = await probe(this.deps.pool, alias)
      if (!probed.ok || probed.home === undefined || probed.home === '') {
        throw new Error(`cannot locate remote home for ${alias}: ${probed.error ?? 'probe failed'}`)
      }
      home = probed.home
      platform = platform && platform !== '' ? platform : probed.platform === 'unknown' ? undefined : probed.platform
      if (platform === undefined) throw new Error(`cannot locate helper platform for ${alias}`)
    }
    const helperPath = `${home}/.dsh-helpers/dsh-ssh-helper-${helper.version}-${platform}/dsh-ssh-helper`
    const conn = new RpcConnection({
      entry: this.deps.store.require(alias),
      helperPath,
      helperHash: helper.sha256,
      workspace: home,
      leaseMs: 60000,
    })
    try {
      await conn.ready
    } catch (error) {
      await conn.dispose().catch(() => undefined)
      throw error
    }
    return conn
  }
}
