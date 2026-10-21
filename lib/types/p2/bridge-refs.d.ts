/**
 * Refs bridge: publishes the isolated local file-reference provider under
 * the name the file-refs router consumes. Split from p2-bridge ON PURPOSE:
 * the stock local impl injects workingDirectory (downstream of our replaced
 * fs), so sharing one bridge would cycle the whole Host (2026-10-13 second
 * pending cascade: bridge → local-refs → workingDirectory → fs-router →
 * bridge). This bridge mounts late but terminates; fs/subprocess/spillStore
 * publishing never waits on it.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { FileReferenceService } from '@deepseek-ai/dsh-file-reference';
declare module '@deepseek-ai/cordis' {
    interface Context {
        localFileReferences: FileReferenceService;
    }
}
/** Stable cordis plugin name. */
export declare const name = "dsh-remote-vs-p2-bridge-refs";
export declare const inject: string[];
/** Publish the isolated local file-reference provider. */
export declare function apply(ctx: Context): void;
