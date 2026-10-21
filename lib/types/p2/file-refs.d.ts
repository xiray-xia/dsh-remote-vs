/**
 * Remote `@file` discovery: the far side of TransparentFileReferences.
 * Mirrors the stock local semantics (dsh-file-reference-local) point for
 * point, with two documented adaptations for RPC transport:
 *
 * - Bare fuzzy queries run ONE remote `rg --files` (head-capped, sorted
 *   locally for determinism) instead of a recursive listDir walk (hundreds
 *   of RPCs). Excluded basenames are pushed down as rg --glob filters.
 * - Symlinked files may appear in bare results (stock prunes them via
 *   non-following Dirent; per-entry remote lstat is prohibitive). Symlinked
 *   dirs stay absent (rg does not descend without -L), matching stock.
 *
 * Everything else is exact: path shapes, dotfile rules, exclusion lists,
 * scoring/ranking math, caps (20 results / 50k entries), jail semantics.
 * No ctx reads inside (explicit deps only) so the router owns all service
 * visibility concerns and this module stays unit-testable.
 */
import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference';
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
/** Mirrored stock defaults (dsh-file-reference-local). */
export declare const REMOTE_FILE_SEARCH_MAX_RESULTS = 20;
export declare const REMOTE_FILE_SEARCH_MAX_ENTRIES = 50000;
/** Mirrored stock exclusion list (order kept for diffability). */
export declare const REMOTE_FILE_SEARCH_EXCLUDED_DIRECTORIES: readonly string[];
export interface RemoteFileSearchDeps {
    /** Remote fs view (worlds.fsFor) for scoped live listings. */
    fs: FileSystem;
    /** Spawn in the remote world (SshProcRuntime.spawn bound). */
    spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle;
    /** Remote absolute root (the binding's remotePath). */
    remoteRoot: string;
    /** Optional warn sink (router wires ctx.logger). */
    warn?: (message: string) => void;
}
export declare class RemoteFileSearch {
    private readonly deps;
    private readonly excluded;
    private settled;
    private pending;
    private pendingAbort;
    /** Invalidation generation the pending scan belongs to (-1: none). */
    private pendingGeneration;
    private disposed;
    /** Monotonic invalidation counter; a scan started below it is stale. */
    private invalidations;
    constructor(deps: RemoteFileSearchDeps);
    /**
     * Drop the cached index (tool activity); the next bare query rebuilds.
     *
     * Dropping — rather than keeping the entries and revalidating behind the
     * caret the way the stock local service does — is deliberate: nothing local
     * can tell whether a remote tree moved, so an index that could predate a
     * change must cost a rebuild instead of answering. For the same reason a
     * minimum rebuild interval is not used to coalesce a burst; the burst is
     * damped where it is generated, by invalidating for write-capable tools in
     * router-refs.ts.
     *
     * Aborting an in-flight scan is part of that: its result can no longer be
     * published, and a query arriving after this call must not join it.
     */
    invalidate(): void;
    dispose(): void;
    /** Ranked candidates for one @ token (mirrors WorkspaceFileSearch.list). */
    list(rawQuery: string, signal: AbortSignal): Promise<FileReferenceCandidate[]>;
    /** Live single-level listing (one RPC; mirrors listDirectory exactly). */
    private listDirectory;
    /** Cached full listing; concurrent callers share one in-flight build. */
    private indexFor;
    /** One remote `rg --files` run, head-capped, sorted for determinism. */
    private buildIndex;
    private warn;
}
