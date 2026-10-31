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
/** Why the cached index is a bounded prefix instead of the whole tree. */
export type RemoteIndexCap = 'entries' | 'bytes' | 'timeout';
export interface RemoteFileSearchDeps {
    /** Remote fs view (worlds.fsFor) for scoped live listings. */
    fs: FileSystem;
    /** Spawn in the remote world (SshProcRuntime.spawn bound). */
    spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle;
    /** Remote absolute root (the binding's remotePath). */
    remoteRoot: string;
    /** Optional warn sink (router wires ctx.logger). */
    warn?: (message: string) => void;
    /** Override the post-cap close wait (tests only; production keeps the default). */
    doneTimeoutMs?: number;
}
export declare class RemoteFileSearch {
    private readonly excluded;
    /**
     * Explicit field assignment instead of a constructor parameter property: the
     * local gates load this module through Node's type-stripping runner (same as
     * `changes/recorder.ts`), which rejects parameter properties.
     */
    private readonly deps;
    private settled;
    private pending;
    private pendingAbort;
    /** Invalidation generation the pending scan belongs to (-1: none). */
    private pendingGeneration;
    private disposed;
    /** Monotonic invalidation counter; a scan started below it is stale. */
    private invalidations;
    /** Why the cached index is bounded, or undefined when it is complete. */
    private cappedIndex;
    constructor(deps: RemoteFileSearchDeps);
    /**
     * Why the current index is a bounded prefix, or `undefined` for a complete one.
     *
     * The `@` surface itself returns candidates only (its contract is the stock
     * local list), so this is the honest place to expose "you are looking at a
     * prefix": host logs get the warning, and a future consumer can surface it.
     */
    get indexCap(): RemoteIndexCap | undefined;
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
    /**
     * One remote `rg --files` run, head-capped, sorted for determinism.
     *
     * A cap is a BOUNDED ANSWER, not a failure: whatever was read before the cap is
     * still the prefix of the listing, and it used to be thrown away because the
     * process's own SIGTERM (we killed it) looked like a non-zero exit. On a
     * monorepo past 50k files that made the bare `@` query answer "nothing to
     * reference" for a repo full of files. Now the prefix is served and
     * {@link RemoteFileSearch.indexCap} / the warn sink say it is a prefix.
     */
    private buildIndex;
    /**
     * Wait for the ended scan to close, but never forever.
     *
     * `handle.done` settles from the transport's close event; a half-dead channel
     * can withhold it for the life of the process. Every outcome is reported as a
     * fact — a rejection stays a rejection so the caller can still treat it as a
     * failure when nothing else explains the scan.
     */
    private waitForDone;
    private warn;
}
