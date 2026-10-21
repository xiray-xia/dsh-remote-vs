/**
 * Transparent subprocess router: cwd-keyed delegation between the local
 * runtime (private realm) and per-host ssh runtimes. Handles are created by
 * the chosen backend, so no handle mapping is needed; pwsh argv in a remote
 * world fails closed with guidance instead of exit-127 confusion.
 */
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalEnvironment, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess';
export default class TransparentSubprocessRuntime extends SubprocessRuntime {
    static inject: string[];
    private get local();
    private get remote();
    private effective;
    /**
     * Executable lookup stays local (the seam carries no cwd): a remote spawn
     * re-resolves in its own world. Mirrors the Yan-Zero rule.
     */
    resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>;
    /** Provider environment facts stay local (used by local UI shell selection). */
    terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment>;
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle;
    spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>;
}
