/**
 * Routed bash executor: the stock local bash executor with world-aware
 * dispatch. Local worlds run unchanged; remote worlds strip host-local
 * DSH_* facts and spawn through the (routed) subprocess service, which
 * carries the call to the right host by workdir.
 *
 * Mounted inside preset-remote's isolated shell group alongside tool-bash;
 * the stock root shell rows are untouched.
 */
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import type { ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'
import type { RemoteWorlds } from './worlds.ts'

export default class RoutedBashExecutor extends LocalBashExecutor {
  static inject = ['subprocess', 'remoteWorlds']

  private get remote(): RemoteWorlds {
    return (this.ctx as unknown as { remoteWorlds: RemoteWorlds }).remoteWorlds
  }

  async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const route = this.remote.routeDir(spec.workdir)
    if (route.kind === 'local') return super.execute(spec)
    // Remote world: host-local DSH_* facts (local paths, session facts) must
    // not leak into the remote environment; the base executor merges the rest.
    const { dshEnv: _dropped, ...rest } = spec
    void _dropped
    return super.execute(rest)
  }
}
