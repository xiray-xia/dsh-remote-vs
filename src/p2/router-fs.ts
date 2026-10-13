/**
 * Transparent filesystem router: cwd/path-keyed delegation between the local
 * backend (private realm) and per-host helper fs views. Targets are tracked
 * in a WeakMap (never mutated — the helper's strict schemas would reject
 * extra fields); unknown targets fail closed.
 */
import { FileSystem, FsError } from '@deepseek-ai/dsh-fs'
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
import type { RemoteWorlds, WorldRoute } from './worlds.ts'

export default class TransparentFileSystem extends FileSystem {
  static inject = ['localFs', 'remoteWorlds']

  /** Target identity -> owning world (full route for policy rewrites). */
  private readonly worlds = new WeakMap<object, WorldRoute>()

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
    const route = this.effective(this.remote.routePath(path, opts?.cwd), `resolve ${path}`)
    const fs = route.kind === 'local' ? this.localFs : await this.remote.fsFor(route.alias)
    const target = await fs.resolve(this.routePathFor(route, path), this.routeOpts(route, opts))
    this.worlds.set(target, route)
    return target
  }

  processPath(target: FsTarget): string {
    const world = this.worlds.get(target)
    if (world === undefined) throw new FsError('unknown target world (not resolved through this router)', 'FS_IO_ERROR')
    if (world.kind === 'local') return this.localFs.processPath(target)
    const fs = this.remote.cachedFs(world.alias)
    if (fs === undefined) throw new FsError(`remote fs view for ${world.alias} is not ready (resolve first)`, 'FS_IO_ERROR')
    return fs.processPath(target)
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
    return fs.stat(target, signal)
  }

  async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const route = this.effective(this.remote.routePath(path, opts?.cwd), `lstat ${path}`)
    const fs = route.kind === 'local' ? this.localFs : await this.remote.fsFor(route.alias)
    const routed = route.kind === 'local' ? opts : this.routeOpts(route, opts) as { cwd?: string } | undefined
    return fs.lstat(this.routePathFor(route, path), routed, signal)
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
