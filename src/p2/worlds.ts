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
import { deployFailure, probe, pushPipeline } from '../deploy.ts'
import { aliasRoot } from '../paths.ts'
import type { RemoteHostEntry, RemoteWorkspaceBinding } from '../protocol.ts'
import { RpcConnection } from './helper-rpc.ts'
import { SshProcRuntime } from './ssh-proc.ts'
import { legacyWorkspaceTitle, workspaceTitle } from '../workspace-title.ts'

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
  /** Connection the view's `ssh` provider is bound to (cache-hit liveness gate). */
  conn: RpcConnection
}

/** Untyped provide: 'ssh' has no Context key in compositions without official dsh-ssh. */
function provideRaw(ctx: Context, name: string, value: unknown): void {
  (ctx as unknown as { provide(name: string, value: unknown): void }).provide(name, value)
}

/** True for drive-letter and UNC absolutes (never remote-meaningful). */
export function isWindowsAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/** Dial cooldown after consecutive helper-connection failures: 1s, 2s, 4s … capped. */
const DIAL_BACKOFF_BASE_MS = 1_000
const DIAL_BACKOFF_CAP_MS = 30_000
/**
 * Immediate redials allowed before a helper that dies right after hello counts
 * as a failure. Each one is a full SSH dial, so this stays small; it exists so a
 * transient blip heals itself instead of failing the caller's operation.
 */
const DIAL_IMMEDIATE_RETRIES = 2

export class RemoteWorlds {
  private readonly rpcs = new Map<string, Promise<RpcConnection>>()
  private readonly fsViews = new Map<string, Promise<FsView>>()
  private readonly fsReady = new Map<string, FsView>()
  private readonly procs = new Map<string, SshProcRuntime>()
  /** Consecutive dial failures per alias; while the cooldown is set, no dial is attempted. */
  private readonly dialFailures = new Map<string, { failures: number; retryAt: number; lastFailureAt: number; reason: string }>()

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

  /**
   * Containment that also accepts the directory itself.
   *
   * `contains` excludes equality, so a session whose cwd IS the workspace root
   * matched nothing and fell back to the local world — the same class of miss as
   * the remote-form one below, and just as invisible.
   */
  private containsOrIs(root: string, target: string): boolean {
    return target === root || this.contains(root, target)
  }

  /**
   * The remote SPELLING of a binding's directory, e.g. `/opt`.
   *
   * A spawned session can arrive with the remote form instead of the local alias
   * path. `routeDir` then matched nothing and EVERYTHING fell back to the Host —
   * `read`/`write`/`glob`/`grep` and even `subprocess` (which routes on the same
   * `routeDir(cwd)`), so a write to `/tmp/x` silently landed in `C:\tmp\x` and a
   * spawn of `bash` died with ENOENT on Windows. Both spellings have to name the
   * same world.
   *
   * Windows-only on purpose: on a Linux Host a genuinely local `/home/...` would
   * otherwise be mistaken for a binding's remote directory.
   */
  private containsRemote(root: string, target: string): boolean {
    if (process.platform !== 'win32') return false
    const dir = root.endsWith('/') && root !== '/' ? root.slice(0, -1) : root
    return target === dir || target.startsWith(dir === '/' ? '/' : `${dir}/`)
  }

  private aliasFor(dir: string): RemoteWorkspaceBinding | undefined {
    let bestAlias: { binding: RemoteWorkspaceBinding; length: number } | undefined
    const byRemotePath: { binding: RemoteWorkspaceBinding; length: number }[] = []
    for (const binding of this.deps.store.listWorkspaces()) {
      const aliasPath = this.aliasPathFor(binding.id)
      if (this.containsOrIs(aliasPath, dir)) {
        if (bestAlias === undefined || aliasPath.length > bestAlias.length) {
          bestAlias = { binding, length: aliasPath.length }
        }
        continue
      }
      if (this.containsRemote(binding.remotePath, dir)) {
        byRemotePath.push({ binding, length: binding.remotePath.length })
      }
    }
    if (bestAlias !== undefined) return bestAlias.binding
    if (byRemotePath.length === 0) return undefined
    const longest = Math.max(...byRemotePath.map(candidate => candidate.length))
    const top = byRemotePath.filter(candidate => candidate.length === longest)
    // Two bindings can share one remote directory — here two aliases both
    // mounted at `/home` do. Picking either would send a write to the wrong host,
    // and a wrong-host write is silent and destructive in a way a local one is
    // not, so an ambiguous remote-form cwd stays local instead of guessing.
    //
    // Raising a named error here instead was tried and reverted. It reads better
    // but it lands during CHILD SESSION CREATION, where the spawn tool has
    // already returned its activation receipt to the caller - so the message has
    // no way back, the caller only ever sees "failed before it finished", and a
    // session that would otherwise run (locally, imperfectly) dies instead.
    // A silent local session beats a clear error nobody receives.
    return top.length === 1 ? top[0].binding : undefined
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
    const base = route.remotePath.endsWith('/') && route.remotePath !== '/' ? route.remotePath.slice(0, -1) : route.remotePath
    // Already the remote spelling. A spawned session can arrive with `/opt/...`
    // as its cwd, and mapping THAT through the alias arithmetic produces
    // nonsense like `/opt/../../opt`.
    if (this.containsRemote(base, localAbsPath)) return localAbsPath
    const rel = relative(route.aliasPath, resolve(localAbsPath))
    const posixRel = rel === '' ? '' : rel.split(sep).join('/')
    return posixRel === '' ? base : `${base}/${posixRel}`
  }

  /** True when a remote-spelling path sits at/inside one binding's remote root. */
  private underRemoteBase(route: Extract<WorldRoute, { kind: 'remote' }>, remoteAbsPath: string): boolean {
    return this.containsRemote(route.remotePath, remoteAbsPath)
  }

  /**
   * The spelling a remote target has to be COMMITTED as when a session path is
   * derived from it.
   *
   * `workingDirectory.set` stores `fs.processPath(target)` (the working-directory
   * service canonicalizes through it), and the remote fs view answers the remote
   * absolute path. That is the right spelling for display and for remote
   * processes, but it is not always a spelling the router can route BACK: two
   * bindings may share one remote root (two aliases both mounted at `/home`), and
   * `/home` is then deliberately ambiguous and resolves local. A spawned child
   * session inherits exactly that committed spelling — so every subagent of a
   * remote session in one of those workspaces silently ran on the Host (and a
   * re-`ensure()` could not repair it: the restored value is the same `/home`
   * again, so no corrective event is ever appended).
   *
   * The alias spelling is unique per binding by construction, so it is the only
   * spelling that always routes back. Keep the remote spelling wherever it is
   * already unambiguous (every uniquely-mapped workspace stays byte-identical);
   * switch to the alias spelling only where the remote one cannot answer.
   * Paths outside the binding root keep the remote spelling — they name no alias
   * location and are only reached through a session cwd that already routes.
   */
  toSessionPath(route: Extract<WorldRoute, { kind: 'remote' }>, remoteAbsPath: string): string {
    if (!this.underRemoteBase(route, remoteAbsPath)) return remoteAbsPath
    let routed: WorldRoute
    try {
      routed = this.routeDir(remoteAbsPath)
    } catch {
      // Tombstoned spelling: leave it as-is (the caller's operation fails closed
      // on the next routeDir anyway; rewriting it would hide the tombstone).
      return remoteAbsPath
    }
    if (routed.kind === 'remote' && routed.id === route.id) return remoteAbsPath
    return this.toAliasPath(route, remoteAbsPath)
  }

  /** Inverse of {@link toRemotePath}: the alias spelling of a remote path. */
  toAliasPath(route: Extract<WorldRoute, { kind: 'remote' }>, remoteAbsPath: string): string {
    const base = route.remotePath.endsWith('/') && route.remotePath !== '/' ? route.remotePath.slice(0, -1) : route.remotePath
    if (!this.containsRemote(base, remoteAbsPath)) return remoteAbsPath
    if (remoteAbsPath === base) return route.aliasPath
    // `containsRemote` already guarded the boundary, so the remainder is a
    // relative POSIX path beneath the binding root.
    const rel = remoteAbsPath.slice(base === '/' ? 1 : base.length + 1)
    return rel === '' ? route.aliasPath : join(route.aliasPath, ...rel.split('/'))
  }

  /**
   * Express a sandbox policy's workspace root in the remote world.
   *
   * The helper validates `workspaceRoot` as an absolute POSIX path
   * (`dsh-ssh/lib/schemas.js`), so anything Windows-spelled has to be converted
   * or the write dies with a zod error that names the field but not the caller's
   * mistake. Three cases, and the last one is why this is a fallback rather than
   * a conditional rewrite:
   *
   * - under the alias directory  -> map through the alias arithmetic
   * - already a remote path      -> use it as-is
   * - anything else (a Windows-spelled root that is neither) -> fall back to the
   *   remote workspace base. Refusing is strictly worse: the operation is legal,
   *   only the policy spelling is not, and `remotePolicy` already fences the same
   *   way for the child's own service policy.
   */
  rewritePolicy<T extends { workspaceRoot?: string }>(policy: T | undefined, route: WorldRoute): T | undefined {
    if (policy === undefined || route.kind !== 'remote') return policy
    const root = policy.workspaceRoot
    if (typeof root !== 'string' || root === '') return policy
    const base = route.remotePath.endsWith('/') && route.remotePath !== '/'
      ? route.remotePath.slice(0, -1)
      : route.remotePath
    if (this.containsOrIs(route.aliasPath, root) || this.containsRemote(base, root)) {
      return { ...policy, workspaceRoot: this.toRemotePath(route, root) }
    }
    // Named once so the next occurrence is diagnosable from the host log instead
    // of needing another round of guessing.
    try {
      this.ctx.logger.info(
        `[remote-vs] policy workspaceRoot "${root}" is not expressible on ${route.alias}; using ${base}`,
      )
    } catch {
      // Logging must never break a write.
    }
    return { ...policy, workspaceRoot: base }
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
        const existing = await registry.resolveByPath(aliasPath) as
          | { title?: string; setTitle?: (title: string) => Promise<unknown> }
          | undefined
        const desired = workspaceTitle(binding)
        if (existing !== undefined) {
          // DISPLAY ONLY: the registry resolves workspaces by canonical PATH
          // (`resolveByPath`) and its own docs call the title "used only when a
          // new record is created", so nothing here can move a route. The
          // retitle is additionally gated on the current title still being
          // EXACTLY what the old code produced (`alias > <last path segment>`),
          // so a title the user renamed by hand is never overwritten.
          if (desired !== existing.title && existing.title === legacyWorkspaceTitle(binding) && typeof existing.setTitle === 'function') {
            await existing.setTitle(desired)
          }
          continue
        }
        await registry.create(aliasPath, desired)
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
    // Host edit/delete: what failed before says nothing about the new
    // coordinates, so the dial cooldown starts over too.
    this.dialFailures.delete(alias)
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
    if (ready !== undefined) {
      // The view's ssh provider is bound to the connection that existed when
      // the view was built, and nothing in the RPC layer redials on
      // invalidation — so a warm view whose connection died stays broken for
      // the rest of the process (`dropHost`, on host edit/delete, is the only
      // other eviction point). Verify liveness on every hit; a dead view drops
      // out of the cache and re-enters the single-flight path below.
      if (ready.conn.alive) return ready.fs
      this.evictFsView(alias)
    }
    let pending = this.fsViews.get(alias)
    if (pending === undefined) {
      pending = this.createFsView(alias)
      this.fsViews.set(alias, pending)
      void pending.catch(() => {
        if (this.fsViews.get(alias) === pending) this.fsViews.delete(alias)
      })
    }
    const view = await pending
    this.fsReady.set(alias, view)
    return view.fs
  }

  /**
   * Drop one alias's cached fs view. `fsViews` keeps the resolved promise, so
   * leaving that entry in place would hand the next caller the same dead
   * closure. The child fiber owns the fs-ssh instance, so it is torn down
   * best-effort: the connection is already dead, nothing in flight through it
   * can succeed, and a failed teardown must not block the rebuild.
   */
  private evictFsView(alias: string): void {
    this.fsReady.delete(alias)
    const view = this.fsViews.get(alias)
    this.fsViews.delete(alias)
    if (view === undefined) return
    void view.then(resolved => resolved.child.fiber.dispose()).catch(() => undefined)
  }

  /** Sync accessor for already-warm views (sync seams only, never creates). */
  cachedFs(alias: string): FileSystem | undefined {
    return this.fsReady.get(alias)?.fs
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
      return { child, fs, conn: rpc }
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
    return this.dial(alias, 0)
  }

  private async dial(alias: string, attempt: number): Promise<RpcConnection> {
    this.assertDialAllowed(alias)
    let pending = this.rpcs.get(alias)
    if (pending === undefined) {
      pending = this.createRpc(alias)
      this.rpcs.set(alias, pending)
      void pending.then(
        () => {
          this.dialFailures.delete(alias)
        },
        (error: unknown) => {
          if (this.rpcs.get(alias) === pending) this.rpcs.delete(alias)
          this.noteDialFailure(alias, error)
        },
      )
    }
    const conn = await pending
    if (!conn.alive) {
      // Dialed, then closed before the caller could use it — a helper that dies
      // right after hello.
      //
      // Retry a bounded number of times BEFORE recording a failure. Recording
      // one here sets a cooldown that the very next line then trips, so this
      // branch could never actually retry: a blip that used to heal itself
      // (v0.4.0 redialed with no delay until it either worked or spun) became a
      // guaranteed failed turn. Only when the attempts are spent does the
      // cooldown engage, which is what keeps a PERMANENT condition from
      // storming — the guard belongs on the persistent case, not the first
      // hiccup.
      this.rpcs.delete(alias)
      if (attempt < DIAL_IMMEDIATE_RETRIES) return this.dial(alias, attempt + 1)
      const detail = conn.diagnostics
      const reason = 'helper connection closed right after dialing'
        + (detail === '' ? ' (the helper wrote nothing to stderr)' : ` — helper stderr: ${detail}`)
      // Recorded so the NEXT call backs off, and thrown here rather than
      // recursed: the first recorded failure no longer blocks (see
      // noteDialFailure), so recursing would spend another full round of dials
      // before it could ever give up.
      this.noteDialFailure(alias, new Error(reason))
      throw new Error(`helper RPC for ${alias} is unavailable after ${attempt + 1} attempt(s): ${reason}`)
    }
    return conn
  }

  /** Fail fast while an alias is inside its cooldown; the cooldown never dials. */
  private assertDialAllowed(alias: string): void {
    const state = this.dialFailures.get(alias)
    if (state === undefined) return
    const remaining = state.retryAt - Date.now()
    if (remaining <= 0) return
    // Any host-record write after the failure (a host edit, or a manual deploy
    // through the Settings button) may have fixed the cause, so it releases the
    // cooldown instead of swallowing the user's fix.
    //
    // INVARIANT: for a failure recorded during one attempt, `updatedAt` must
    // stay OLDER than `lastFailureAt`. `setDeploy` writes the host record too,
    // and its stamp lands between the failed deploy and the dial failure that
    // follows, so the ordering holds. Recording the dial failure BEFORE the
    // deploy write would make every failure release its own cooldown and turn
    // this gate into a no-op.
    if (this.deps.store.require(alias).updatedAt > state.lastFailureAt) {
      this.dialFailures.delete(alias)
      return
    }
    throw new Error(
      `helper RPC for ${alias} is cooling down for ${Math.ceil(remaining / 1000)}s after `
      + `${state.failures} consecutive failure(s): ${state.reason}`,
    )
  }

  private noteDialFailure(alias: string, error: unknown): void {
    const failures = (this.dialFailures.get(alias)?.failures ?? 0) + 1
    const now = Date.now()
    this.dialFailures.set(alias, {
      failures,
      // The FIRST consecutive failure does not block. A cooldown exists to stop
      // a storm, and one failure is not a storm — but it used to cost the caller
      // every call it made for the next second, which turns a single network
      // blip into a visibly broken turn. From the second failure on the backoff
      // is 1s, 2s, 4s … capped, so a persistent condition still backs right off.
      retryAt: now + (failures <= 1
        ? 0
        : Math.min(DIAL_BACKOFF_BASE_MS * 2 ** Math.min(failures - 2, 5), DIAL_BACKOFF_CAP_MS)),
      lastFailureAt: now,
      reason: error instanceof Error ? error.message : String(error),
    })
  }

  private async createRpc(alias: string): Promise<RpcConnection> {
    const entry: RemoteHostEntry = this.deps.store.require(alias)
    let deploy = entry.deploy
    if (deploy?.artifact === undefined || !deploy.artifact.startsWith('dsh-ssh-helper/') || deploy.helper === undefined) {
      // A failed deploy never writes `helper`, so this predicate stays true
      // forever and every remote file operation re-ran the whole pipeline
      // (probe + up to 45MB upload + install). `deployFailure` separates
      // "never deployed" (no ledger on the record) from "deployed and failed",
      // and reports the remaining backoff for the latter. The Settings deploy
      // button calls pushPipeline directly, so it still retries immediately.
      const failure = deployFailure(deploy)
      if (failure !== undefined && failure.retryInMs > 0) {
        throw new Error(
          `helper deploy for ${alias} failed ${failure.attempts} time(s); next automatic attempt in `
          + `${Math.ceil(failure.retryInMs / 1000)}s (deploy it again from Settings to force one now)`,
        )
      }
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
