/**
 * Routed bash executor: the stock local bash executor with world-aware
 * dispatch. Local worlds run unchanged; remote worlds strip host-local
 * DSH_* facts and spawn through the (routed) subprocess service, which
 * carries the call to the right host by workdir.
 *
 * Mounted inside preset-remote's isolated shell group alongside tool-bash;
 * the stock root shell rows are untouched.
 */
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local';
import type { ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell';
export default class RoutedBashExecutor extends LocalBashExecutor {
    static inject: string[];
    private get remote();
    execute(spec: ShellExecSpec): Promise<ShellExecution>;
}
