/**
 * Transparent subprocess router: cwd-keyed delegation between the local
 * runtime (private realm) and per-host ssh runtimes. Handles are created by
 * the chosen backend, so no handle mapping is needed; pwsh argv in a remote
 * world fails closed with guidance instead of exit-127 confusion.
 */
import { SubprocessRuntime, SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalEnvironment,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { RemoteWorlds, WorldRoute } from './worlds.ts'
import { remoteCommand } from './ssh-proc.ts'

/** True when argv selects PowerShell (remote worlds are POSIX-only). */
function isPwshArgv(argv: readonly string[]): boolean {
  if (argv.length === 0) return false
  const base = (argv[0] as string).replace(/\\/g, '/').split('/').pop() ?? ''
  return /^pwsh(\.exe)?$/i.test(base)
}

export default class TransparentSubprocessRuntime extends SubprocessRuntime {
  static inject = ['localSubprocess', 'remoteWorlds']

  private get local(): SubprocessRuntime {
    return (this.ctx as unknown as { localSubprocess: SubprocessRuntime }).localSubprocess
  }

  private get remote(): RemoteWorlds {
    return (this.ctx as unknown as { remoteWorlds: RemoteWorlds }).remoteWorlds
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
   * Executable lookup stays local (the seam carries no cwd): a remote spawn
   * re-resolves in its own world. Mirrors the Yan-Zero rule.
   */
  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.local.resolveExecutable(command, env, signal)
  }

  /** Provider environment facts stay local (used by local UI shell selection). */
  async terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    return this.local.terminalEnvironment(signal)
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const route = this.effective(this.remote.routeDir(spec.cwd), `spawn ${spec.argv[0] ?? ''} @ ${spec.cwd}`)
    if (route.kind === 'local') return this.local.spawn(spec)
    if (isPwshArgv(spec.argv)) {
      throw new SubprocessExecutableNotFoundError(
        `remote worlds are POSIX-only: '${spec.argv[0]}' cannot run on ${route.alias}; use the bash tool (Remote preset) instead`,
      )
    }
    const runtime = this.remote.procFor(route.alias)
    // Absolute argv: POSIX paths are already remote-native; Windows paths are
    // meaningless remotely, so reduce to a bare name for remote PATH lookup.
    // spawn() is sync by contract, so no async re-resolution happens here.
    const argv0 = spec.argv[0] as string
    const remoteArgv0 = argv0.startsWith('/')
      ? argv0
      : /^[A-Za-z]:[\\/]/.test(argv0) || argv0.includes('\\')
        ? remoteCommand(argv0)
        : argv0
    const cwd = this.remote.toRemotePath(route, spec.cwd)
    return runtime.spawn({ ...spec, argv: [remoteArgv0, ...spec.argv.slice(1)], cwd })
  }

  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const route = this.effective(this.remote.routeDir(spec.cwd), `spawnTerminal @ ${spec.cwd}`)
    if (route.kind === 'local') return this.local.spawnTerminal(spec)
    throw new Error(
      'remote agent terminals are not implemented in P2-v1 (interactive remote shells live in the Remote tab); file/shell/subprocess routing is unaffected',
    )
  }
}
