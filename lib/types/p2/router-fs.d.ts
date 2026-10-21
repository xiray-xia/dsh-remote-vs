/**
 * Transparent filesystem router: cwd/path-keyed delegation between the local
 * backend (private realm) and per-host helper fs views. Targets are tracked
 * in a WeakMap (never mutated — the helper's strict schemas would reject
 * extra fields); unknown targets fail closed.
 */
import { FileSystem } from '@deepseek-ai/dsh-fs';
import type { FsDirEntry, FsEditOutcome, FsEditRequest, FsInfo, FsPathInfo, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs';
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox';
export default class TransparentFileSystem extends FileSystem {
    static inject: string[];
    /** Target identity -> owning world (full route for policy rewrites). */
    private readonly worlds;
    /**
     * Hint for a target that was deliberately routed local from a remote session.
     *
     * The read tool observes absence through stat, which only ever receives the
     * resolved target — the original path and cwd are gone by then. So the note is
     * computed once, at resolve time, and carried on the target itself.
     */
    private readonly missNotes;
    private get localFs();
    private get remote();
    get sandboxMode(): SandboxMode | undefined;
    private effective;
    /**
     * True when the path sits under the alias root — the only place a remote
     * binding or a tombstone can live (every alias dir is `join(aliasRoot(), id)`,
     * and `store.removeWorkspace` tombstones the same way), so it is exactly the
     * input set whose route is not trivially local.
     */
    private underAliasRoot;
    /**
     * Mode-gated route for one call. `off` discards the route anyway (see
     * `effective`), so computing it first — the argument-first idiom this used to
     * have — was pure waste on the root fs path. Only an alias-root cwd or path
     * can name a remote world, or a tombstoned one, and a tombstone must keep
     * failing closed (`worlds.routePath` throws), so that case still resolves;
     * everything else is local without touching the store. `enforce`/`shadow`
     * take the exact path they took before.
     */
    private routeFor;
    private backendOf;
    /** Translate call cwd into the routed world (alias -> remote, else drop). */
    private routeOpts;
    private cwdToRemote;
    /**
     * Translate the call path into the routed world: alias-contained paths map
     * to remote absolutes; already-remote absolutes and relatives (resolved
     * against the translated cwd) pass through.
     */
    private routePathFor;
    resolve(path: string, opts?: {
        cwd?: string;
        signal?: AbortSignal;
    }): Promise<FsTarget>;
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
    private localMissNote;
    processPath(target: FsTarget): string;
    processPathFromHostPath(hostPath: string): string | undefined;
    fileUrl(target: FsTarget): string;
    contains(parent: FsTarget, child: FsTarget): boolean;
    stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>;
    lstat(path: string, opts?: {
        cwd?: string;
    }, signal?: AbortSignal): Promise<FsPathInfo | undefined>;
    readText(target: FsTarget, signal?: AbortSignal): Promise<string>;
    streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>;
    readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>;
    readByteRange(target: FsTarget, range: {
        offset: number;
        length: number;
    }, signal?: AbortSignal): Promise<Uint8Array>;
    listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>;
    writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsWriteOutcome>;
    editText(target: FsTarget, edit: FsEditRequest, expected?: {
        version: FsVersion;
    }, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsEditOutcome>;
    watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>>;
}
