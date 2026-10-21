import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import type { RemotePool } from '../pool.ts';
/** Strip a Windows absolute executable to a remote-resolvable bare name. */
export declare function remoteCommand(input: string): string;
export declare class SshProcRuntime {
    private readonly pool;
    private readonly alias;
    private readonly live;
    /** Whether the remote offers a compatible setsid(1); optimistic until disproven. */
    private setsid;
    constructor(pool: RemotePool, alias: string);
    /** Resolve via remote `command -v` (Windows paths reduce to bare names). */
    resolveExecutable(command: string): Promise<string>;
    terminalEnvironment(): {
        platform: 'posix';
        defaultShell: string;
    };
    /** Spawn one managed remote process. Throws synchronously on invalid spec. */
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle;
    /** Terminate every live remote process (service disposal). */
    dispose(): Promise<void>;
}
