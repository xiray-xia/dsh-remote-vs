/**
 * Transparent filesystem router: cwd/path-keyed delegation between the local
 * backend (private realm) and per-host helper fs views. Targets are tracked
 * in a WeakMap (never mutated — the helper's strict schemas would reject
 * extra fields); unknown targets fail closed.
 */
import { FileSystem, FsError, type FsErrorCode } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { aliasRoot } from '../paths.ts'
import { isWindowsAbsolute, type RemoteWorlds, type WorldRoute } from './worlds.ts'

export default class TransparentFileSystem extends FileSystem {
  static inject = ['localFs', 'remoteWorlds']

  /** Target identity -> owning world (full route for policy rewrites). */
  private readonly worlds = new WeakMap<object, WorldRoute>()
  /**
   * Hint for a target that was deliberately routed local from a remote session.
   *
   * The read tool observes absence through stat, which only ever receives the
   * resolved target — the original path and cwd are gone by then. So the note is
   * computed once, at resolve time, and carried on the target itself.
   */
  private readonly missNotes = new WeakMap<object, string>()

  private get localFs(): FileSystem {
    return (this.ctx as unknown as { localFs: FileSystem }).localFs
  }

  private get remote(): RemoteWorlds {
    return (this.ctx as unknown as { remoteWorlds: RemoteWorlds }).remoteWorlds
  }

  get sandboxMode(): SandboxMode | undefined {
    return this.localFs.sandboxMode
  }

  private effective(route: WorldRoute, what: string): WorldRoute {
    const mode = this.remote.mode
    if (mode === 'off') return { kind: 'local' }
    if (mode === 'shadow') {
      this.remote.note(route, what)
      return { kind: 'local' }
    }
    return route
  }

  /**
   * True when the path sits under the alias root — the only place a remote
   * binding or a tombstone can live (every alias dir is `join(aliasRoot(), id)`,
   * and `store.removeWorkspace` tombstones the same way), so it is exactly the
   * input set whose route is not trivially local.
   */
  private underAliasRoot(path: string | undefined): boolean {
    return path !== undefined && this.remote.underAlias(aliasRoot(), path)
  }

  /**
   * Mode-gated route for one call. `off` discards the route anyway (see
   * `effective`), so computing it first — the argument-first idiom this used to
   * have — was pure waste on the root fs path. Only an alias-root cwd or path
   * can name a remote world, or a tombstoned one, and a tombstone must keep
   * failing closed (`worlds.routePath` throws), so that case still resolves;
   * everything else is local without touching the store. `enforce`/`shadow`
   * take the exact path they took before.
   */
  private routeFor(path: string, cwd: string | undefined, what: string): WorldRoute {
    // `off` with nothing that could name a remote world: answer local here, so
    // the store is never consulted (the decision would be thrown away anyway).
    if (this.remote.mode === 'off' && !this.underAliasRoot(path) && !this.underAliasRoot(cwd)) {
      return { kind: 'local' }
    }
    return this.effective(this.remote.routePath(path, cwd), what)
  }

  private async backendOf(target: FsTarget): Promise<{ fs: FileSystem; world: WorldRoute }> {
    const world = this.worlds.get(target)
    if (world === undefined) {
      throw new FsError('unknown target world (not resolved through this router)', 'FS_IO_ERROR')
    }
    if (world.kind === 'local') return { fs: this.localFs, world }
    return { fs: await this.remote.fsFor(world.alias), world }
  }

  /** Translate call cwd into the routed world (alias -> remote, else drop). */
  private routeOpts(
    route: WorldRoute,
    opts: { cwd?: string; signal?: AbortSignal } | undefined,
  ): { cwd?: string; signal?: AbortSignal } | undefined {
    if (route.kind === 'local' || opts?.cwd === undefined) return opts
    const remoteCwd = this.cwdToRemote(route, opts.cwd)
    if (remoteCwd === undefined) {
      const { signal } = opts
      return signal === undefined ? undefined : { signal }
    }
    return { ...opts, cwd: remoteCwd }
  }

  private cwdToRemote(route: Extract<WorldRoute, { kind: 'remote' }>, cwd: string): string | undefined {
    try {
      const check = this.remote.routeDir(cwd)
      if (check.kind === 'remote' && check.id === route.id) return this.remote.toRemotePath(route, cwd)
      return undefined
    } catch {
      return undefined
    }
  }

  /**
   * Translate the call path into the routed world: alias-contained paths map
   * to remote absolutes; already-remote absolutes and relatives (resolved
   * against the translated cwd) pass through.
   */
  private routePathFor(route: WorldRoute, path: string): string {
    if (route.kind !== 'local' && this.remote.underAlias(route.aliasPath, path)) {
      return this.remote.toRemotePath(route, path)
    }
    return path
  }

  async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const route = this.routeFor(path, opts?.cwd, `resolve ${path}`)
    const fs = route.kind === 'local' ? this.localFs : await this.remote.fsFor(route.alias)
    try {
      const target = await fs.resolve(this.routePathFor(route, path), this.routeOpts(route, opts))
      this.worlds.set(target, route)
      const note = this.localMissNote(path, route, opts?.cwd)
      if (note !== undefined) this.missNotes.set(target, note)
      return target
    } catch (error) {
      const note = this.localMissNote(path, route, opts?.cwd)
      if (note === undefined) throw error
      const detail = error instanceof Error ? error.message : String(error)
      const original = (error as { code?: FsErrorCode } | undefined)?.code
      throw new FsError(`${detail}${note}`, original ?? 'FS_IO_ERROR')
    }
  }

  /**
   * The explanatory suffix for the one genuinely confusing miss.
   *
   * `routePath` sends a Windows-absolute path outside the alias to the LOCAL
   * world deliberately: a `C:\…` path can never name a remote file, and the tool
   * seam's spill files genuinely live on the Host. But in a REMOTE session the
   * likely mistake is that the caller wrote the remote path with a drive letter
   * — `C:\opt\x` when it meant `/opt/x` — and a bare "not found" hides it.
   * Naming both working forms is the difference between a guess and a fix.
   *
   * Returns undefined when nothing about this call is confusing, so callers can
   * keep their normal behaviour untouched.
   */
  private localMissNote(path: string, route: WorldRoute, cwd: string | undefined): string | undefined {
    if (route.kind !== 'local') return undefined
    if (!isWindowsAbsolute(path)) return undefined
    if (cwd === undefined || cwd.trim() === '') return undefined
    let remote: Extract<WorldRoute, { kind: 'remote' }>
    try {
      const byCwd = this.remote.routeDir(cwd)
      if (byCwd.kind !== 'remote') return undefined
      remote = byCwd
    } catch {
      return undefined
    }
    const posix = `/${path.replace(/^[A-Za-z]:[\\/]/, '').split('\\').join('/')}`
    return ' — this session works in the remote workspace '
      + `"${remote.remotePath}", and "${path}" is a Windows-absolute path outside that workspace's local alias, `
      + 'so it was looked up on the Host. If you meant the remote file, pass '
      + `"${posix}" or a path relative to the workspace.`
  }

  processPath(target: FsTarget): string {
    const world = this.worlds.get(target)
    if (world === undefined) throw new FsError('unknown target world (not resolved through this router)', 'FS_IO_ERROR')
    if (world.kind === 'local') return this.localFs.processPath(target)
    const fs = this.remote.cachedFs(world.alias)
    if (fs === undefined) throw new FsError(`remote fs view for ${world.alias} is not ready (resolve first)`, 'FS_IO_ERROR')
    // The remote view answers the remote absolute path (correct for display and
    // for remote processes), but that spelling is not guaranteed to route BACK:
    // a session path derived from it (working-directory.set commits THIS value)
    // would resolve local whenever two bindings share the remote root — that is
    // how subagents of `alias-c`/`alias-d` sessions ended up running on the Host.
    // toSessionPath keeps the remote spelling where it is unambiguous and uses
    // the binding's unique alias spelling only where it is not.
    return this.remote.toSessionPath(world, fs.processPath(target))
  }

  processPathFromHostPath(hostPath: string): string | undefined {
    // Alias dirs hold no real files: a host path under an alias can never be
    // read as a host file, so it maps nowhere (prevents alias/local confusion).
    try {
      const route = this.remote.routeDir(hostPath)
      if (route.kind !== 'local') return undefined
    } catch {
      return undefined
    }
    return this.localFs.processPathFromHostPath(hostPath)
  }

  fileUrl(target: FsTarget): string {
    const world = this.worlds.get(target)
    if (world === undefined) throw new FsError('unknown target world (not resolved through this router)', 'FS_IO_ERROR')
    if (world.kind === 'local') return this.localFs.fileUrl(target)
    const fs = this.remote.cachedFs(world.alias)
    if (fs === undefined) throw new FsError(`remote fs view for ${world.alias} is not ready (resolve first)`, 'FS_IO_ERROR')
    return fs.fileUrl(target)
  }

  contains(parent: FsTarget, child: FsTarget): boolean {
    const pw = this.worlds.get(parent)
    const cw = this.worlds.get(child)
    if (pw === undefined || cw === undefined) return false
    if (pw.kind !== cw.kind) return false
    if (pw.kind === 'local') return this.localFs.contains(parent, child)
    if (pw.id !== (cw as Extract<WorldRoute, { kind: 'remote' }>).id) return false
    // Same remote binding: containment by remote path order.
    try {
      const left = this.processPath(parent)
      const right = this.processPath(child)
      return right === left || right.startsWith(left.endsWith('/') ? left : `${left}/`)
    } catch {
      return false
    }
  }

  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const { fs } = await this.backendOf(target)
    const info = await fs.stat(target, signal)
    if (info === undefined) {
      // Absence is observed HERE, not through resolve or lstat: the read tool
      // resolves first — which succeeds for a path that does not exist — and only
      // then stats, turning `undefined` into its own "not found". So the hint
      // computed at resolve time has to be raised at exactly this point.
      const note = this.missNotes.get(target)
      if (note !== undefined) throw new FsError(`not found${note}`, 'FS_NOT_FOUND')
    }
    return info
  }

  async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const route = this.routeFor(path, opts?.cwd, `lstat ${path}`)
    const fs = route.kind === 'local' ? this.localFs : await this.remote.fsFor(route.alias)
    const routed = route.kind === 'local' ? opts : this.routeOpts(route, opts) as { cwd?: string } | undefined
    try {
      const info = await fs.lstat(this.routePathFor(route, path), routed, signal)
      if (info === undefined) {
        // A miss comes back as `undefined`, NOT as an exception — which is why
        // wrapping this call in try/catch was not enough to surface the hint.
        // The caller turns `undefined` into its own "not found", so the only
        // place to say anything useful is here.
        const note = this.localMissNote(path, route, opts?.cwd)
        if (note !== undefined) throw new FsError(`not found${note}`, 'FS_NOT_FOUND')
      }
      return info
    } catch (error) {
      if (error instanceof FsError) throw error
      const note = this.localMissNote(path, route, opts?.cwd)
      if (note === undefined) throw error
      const detail = error instanceof Error ? error.message : String(error)
      throw new FsError(`${detail}${note}`, 'FS_IO_ERROR')
    }
  }

  async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const { fs } = await this.backendOf(target)
    return fs.readText(target, signal)
  }

  async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const { fs } = await this.backendOf(target)
    return fs.streamText(target, signal)
  }

  async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const { fs } = await this.backendOf(target)
    return fs.readBytes(target, signal, maxBytes)
  }

  async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    const { fs } = await this.backendOf(target)
    return fs.readByteRange(target, range, signal)
  }

  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const { fs, world } = await this.backendOf(target)
    const entries = await fs.listDir(target, signal)
    for (const entry of entries) this.worlds.set(entry.target, world)
    return entries
  }

  async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const { fs, world } = await this.backendOf(target)
    return fs.writeText(target, content, expected, signal, this.remote.rewritePolicy(sandboxPolicy, world))
  }

  async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const { fs, world } = await this.backendOf(target)
    return fs.editText(target, edit, expected, signal, this.remote.rewritePolicy(sandboxPolicy, world))
  }

  async watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>> {
    const { fs } = await this.backendOf(target)
    return fs.watch(target, changed, signal)
  }
}
