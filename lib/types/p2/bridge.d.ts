/**
 * Local bridge: captures the isolated local providers (private realm group)
 * under names the root routers consume. Pattern copied from
 * Yan-Zero/dsh-remote-ssh's local-bridge (mechanics identical on 0.2.1).
 * fileReferences has its OWN bridge (bridge-refs.ts): the stock local impl
 * injects workingDirectory (downstream of our replaced fs), so sharing one
 * bridge would cycle the whole Host — each bridge only waits early services.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type { SpillStore } from '@deepseek-ai/dsh-spill';
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
declare module '@deepseek-ai/cordis' {
    interface Context {
        localFs: FileSystem;
        localSpillStore: SpillStore;
        localSubprocess: SubprocessRuntime;
    }
}
/** Stable cordis plugin name. */
export declare const name = "dsh-remote-vs-p2-bridge";
export declare const inject: string[];
/** Publish isolated local providers without changing their implementation. */
export declare function apply(ctx: Context): void;
