/**
 * Ctrl+P quick open: the remote file index and its fuzzy matcher.
 *
 * Pure logic on purpose (no React, no store, no `api` import): the pixels live
 * in `QuickOpen.tsx`, and everything that has to be provable in Node lives
 * here — scoring, ranking, the index lifecycle, the remote command and its
 * parser. The only I/O this module performs is the injected `exec`, so a gate
 * can drive it with a stub and never touch a real host.
 *
 * The incident-index rules that shape every decision below:
 *
 * - **A failed listing is not an empty listing.** {@link buildFileIndex}
 *   REJECTS a run that did not produce a trustworthy listing: a timed-out or
 *   transport-broken command, a command that never entered the workspace root,
 *   and a listing TOOL that exited non-zero without listing anything. Returning
 *   `[]` there would make "the host failed" look exactly like "this tree has no
 *   files".
 * - **A capped listing is a bounded PREFIX, never a complete index.** THREE
 *   separate caps are enforced on the remote and reported as three separate
 *   facts: entries, bytes, and the walk depth of the no-ripgrep fallback. A
 *   listing that was cut anywhere says so in the result; nothing is silently
 *   dropped and called complete. A tool that listed SOME files and then exited
 *   non-zero is a fourth, separate fact (`toolStatus`) — its prefix is still
 *   useful, so it is kept but marked incomplete instead of being thrown away.
 * - **A late answer must not overwrite a newer screen.** The index records which
 *   workspace it is for; a result (or failure) that lands after the user
 *   switched workspaces is discarded, because its relative paths would be
 *   resolved against the wrong root (see {@link applyIndexResult}).
 *
 * Privacy: the index is memory-only. Nothing here stores file content, and
 * nothing is written to IndexedDB. The single persisted item is the recent-file
 * list — absolute paths only — under a `dsh-remote-vs.` key, the same
 * trade-off the panel-layout prefs already make.
 */
/** Cap on one listing's entries; precedent: `src/p2/file-refs.ts` (same 50k). */
export declare const QUICKOPEN_MAX_ENTRIES = 50000;
/**
 * Byte ceiling for one listing.
 *
 * Deliberately BELOW the Host's per-stream exec cap (2 MiB, `src/pool.ts`):
 * when the transport truncates it appends its own marker line, which would
 * arrive as a half-written path and be indistinguishable from a real one.
 * Staying under it means every truncation is OURS and is reported as one.
 */
export declare const QUICKOPEN_MAX_BYTES = 1200000;
/**
 * One listing command's budget. A cold `find` walk over a very large tree is
 * the slow path (a few seconds with `rg`, minutes without it), and giving up
 * too early turns "slow host" into "broken index".
 */
export declare const QUICKOPEN_INDEX_TIMEOUT_MS = 120000;
/** Rows rendered in the result list. */
export declare const QUICKOPEN_RESULT_LIMIT = 50;
/** Recent files remembered per host — paths only, never content. */
export declare const QUICKOPEN_RECENT_LIMIT = 20;
/** localStorage key: `{ [alias]: string[] }`. Prefix kept for the panel's own data. */
export declare const QUICKOPEN_RECENT_KEY = "dsh-remote-vs.recentFiles";
/**
 * How deep the `find` fallback walks. `rg --files` has no depth limit and is
 * the preferred path; this only bounds the no-ripgrep case, where an uncapped
 * walk on a multi-million-file tree never finishes. 40 is far past any sane
 * source layout (the name search needed 12 to see a deep file, and its cap was
 * raised for exactly that reason).
 *
 * The bound is DECLARED in the listing stream ({@link DEPTH_CAP_PREFIX}), so an
 * index built without ripgrep is never presented as complete.
 */
export declare const QUICKOPEN_FALLBACK_MAX_DEPTH = 40;
/**
 * Score one path against one query, or `undefined` when it does not match.
 *
 * Greedy left-to-right subsequence matching (not optimal alignment): it is what
 * every editor's quick open does, it is O(path length), and — most importantly
 * here — it is DETERMINISTIC, so equal scores can be tie-broken by path and the
 * list never reshuffles between identical inputs.
 *
 * Weighting, in the order it matters for a filename jump list:
 * - each matched character scores 1;
 * - a run of consecutive characters beats the same characters spread out;
 * - a match inside the LAST path segment (the file name) scores higher than one
 *   inside directories — the query is almost always "the name I remember";
 * - a match at a word boundary (`/`, `_`, `-`, `.`, camel hump) beats one in the
 *   middle of a word.
 *
 * Case-insensitive in both directions; an empty query scores 0 (it matches
 * everything, which is how "recent files" reuses this path).
 */
export declare function fuzzyScore(query: string, path: string): number | undefined;
/**
 * Rank `paths` for one query.
 *
 * - Empty query: the caller's ORDER is the answer (that is what makes "recent
 *   files first" work without a second code path); the list is merely capped.
 * - Otherwise: score descending, then path ascending. The path tie-break is not
 *   cosmetic — without it, equal-scoring matches would come out in whatever
 *   order the (remote-driven) input happened to have, and the list would jump
 *   around between two identical keystrokes.
 *
 * `truncated` here means "more matches than fit", which is a different fact
 * from the index being truncated ({@link FileIndex.truncated}) — both are
 * reported, and neither is swallowed.
 */
export declare function rankFiles(query: string, paths: readonly string[], limit: number): {
    hits: string[];
    truncated: boolean;
};
/**
 * Character offsets matched by `query` inside `text`, for highlighting.
 *
 * Only a match that fits ENTIRELY inside the file name produces offsets: a hit
 * whose characters are split between a directory and the name would otherwise
 * highlight a misleading subset of the name. Returns `[]` when the query does
 * not fully match, so the caller can render the name plain.
 */
export declare function matchPositions(query: string, text: string): number[];
/** Split a relative path into its directory part (trailing slash kept) and name. */
export declare function splitPath(path: string): {
    dir: string;
    name: string;
};
/** Absolute remote path for a workspace-relative one. */
export declare function absoluteFromRoot(root: string, relative: string): string;
/**
 * Workspace-relative form of an absolute path, or `undefined` when it is not
 * inside this workspace.
 *
 * Used for the recent list: an entry from ANOTHER workspace must not be shown
 * as if it were reachable here — opening it would act on a path whose binding
 * the user is no longer looking at (the "opened in the wrong host" class of
 * incident).
 */
export declare function relativeToRoot(root: string, absolute: string): string | undefined;
/** Render one thrown value as a readable reason. */
export declare function errorText(error: unknown): string;
/** Recently opened absolute paths for one host, newest first. */
export declare function loadRecentFiles(alias: string): string[];
/**
 * Record one opened file and return the new list.
 *
 * Paths only — this is the one thing quick open persists, so the promise in the
 * README ("remote source never lands on this device") stays literally true:
 * what is stored is a location, not content.
 */
export declare function rememberRecentFile(alias: string, absolutePath: string): string[];
export type IndexPhase = 'idle' | 'loading' | 'ready' | 'error';
/** One built listing. Immutable; replaced wholesale, never mutated in place. */
export interface FileIndex {
    alias: string;
    root: string;
    /** Remote-write counter observed when the listing was requested. */
    writeSeq: number;
    /** Workspace-relative paths, sorted (deterministic order for equal scores). */
    paths: readonly string[];
    /** This is a bounded PREFIX in the entry/byte dimension: more files exist. */
    truncated: boolean;
    /**
     * The no-ripgrep fallback only walked this deep, so deeper files may be
     * missing. `undefined` means the listing had no depth bound (ripgrep).
     */
    depthCapped: number | undefined;
    /**
     * Exit status of the listing tool when it complained. The prefix is kept (a
     * partial list is still useful) but it is NOT a complete index.
     */
    toolStatus: number | undefined;
    /** Human-readable reasons the index is incomplete (tool status, stderr). */
    warning: string | undefined;
}
/** Which workspace an index state is about. */
export interface IndexTarget {
    alias: string;
    root: string;
}
export interface IndexState {
    phase: IndexPhase;
    /**
     * The workspace this state belongs to — for `loading`, the build in flight.
     *
     * Carried explicitly because "loading" alone was a lie: a build for workspace
     * A that was still in flight when the user switched to B made
     * `indexNeedsRebuild` answer "nothing to do" for B, and A's listing then
     * landed as if it were B's — Enter would join B's root with A's relative
     * paths (a file that is not there, or, worse, a same-named one that is not
     * what the list showed).
     */
    target: IndexTarget | undefined;
    index: FileIndex | undefined;
    error: string | undefined;
}
export declare function createIndexState(): IndexState;
/** Cache identity: an index is only valid for the alias + root it came from. */
export declare function indexTargetKey(alias: string, root: string): string;
/** Is `left` the same workspace as `right`? A trailing slash is not another tree. */
export declare function isSameIndexTarget(left: IndexTarget | undefined, right: IndexTarget): boolean;
/**
 * Does the cached state still answer for this target?
 *
 * Three independent invalidations, all cheap:
 * - this state is about a DIFFERENT workspace — including a build still in
 *   flight for one. Switching is a rebuild, and the foreign answer is dropped
 *   when it arrives (see {@link applyIndexResult});
 * - no index yet, or the last attempt FAILED (a transient failure deserves a
 *   retry on the next open, and an error state must never be reused as if it
 *   were a complete answer);
 * - a remote WRITE happened since the build (see `api.ts`), which is exactly
 *   when the path set can change.
 */
export declare function indexNeedsRebuild(state: IndexState, alias: string, root: string, writeSeq: number): boolean;
/**
 * Enter the loading phase for `alias` + `root`.
 *
 * An index for the SAME target is kept while it is being replaced, so the list
 * keeps answering (from a snapshot that may be one write old) instead of
 * blanking on every reopen. A different target's index is dropped: its paths
 * are wrong for the new workspace.
 */
export declare function beginIndexBuild(state: IndexState, alias: string, root: string): IndexState;
/**
 * Publish one finished build — but only for the workspace that is current NOW.
 *
 * A build can outlive its workspace: 50k paths over a thin link takes seconds,
 * and switching while it runs is normal use. Publishing that answer would put
 * workspace A's relative paths in front of workspace B, so a foreign result is
 * DISCARDED: whatever state is current stays exactly as it is (the current
 * workspace's own build, or its error).
 */
export declare function applyIndexResult(state: IndexState, index: FileIndex): IndexState;
/**
 * Record a FAILED build for `target`, with the same foreign-result guard.
 *
 * `phase` stays `error` — never `ready` with zero paths. That distinction is the
 * whole point: the modal prints the reason and does not claim "no matching
 * file". Any previously built index for the same target is preserved so the
 * list keeps showing something usable while the reason sits in the footer.
 */
export declare function applyIndexFailure(state: IndexState, reason: string, target: IndexTarget): IndexState;
/**
 * An immediately-known LOCAL failure (nothing remote ran, so there is no target
 * to guard and no build to drop): e.g. no workspace is selected.
 */
export declare function failIndexNow(reason: string): IndexState;
export declare function quickOpenIndexState(): IndexState;
/** Subscribe to cache changes (the modal's view of the index). */
export declare function subscribeQuickOpenIndex(listener: () => void): () => void;
/** Replace the cached state and notify every subscriber. */
export declare function replaceQuickOpenIndexState(next: IndexState): void;
/** The slice of one remote command result this feature needs. */
export interface IndexExecResult {
    success: boolean;
    exitCode: number | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    error?: string | undefined;
}
/** Injected I/O, so a gate can drive the whole build without a host. */
export interface FileIndexDeps {
    exec: (alias: string, command: string, timeoutMs: number) => Promise<IndexExecResult>;
    /** Monotonic remote-write counter (see `api.ts` `remoteWriteSequence`). */
    writeSequence: () => number;
}
/** One POSIX shell word, quoted. */
export declare function shellQuote(value: string): string;
/**
 * The remote listing command.
 *
 * Shape decisions, and what each one prevents:
 * - `cd` instead of passing the root to the tools: both paths are printed
 *   relative to the working directory, which is what the index wants.
 * - a failed `cd` exits 3 WITH a message on stderr. Listing nothing would turn
 *   "the workspace root is gone" into "this tree has no files".
 * - `rg` when the host has it, `find` otherwise, decided ON THE HOST in one
 *   command: no probe round trip and no per-alias cache to invalidate.
 * - `--no-ignore --hidden` keeps ignored and dotted files searchable (what the
 *   name search does); the exclusion globs only prune noise directories.
 * - both caps are applied remotely (`head -n cap+1`, then `head -c bytes`), so a
 *   million-line tree never crosses the wire just to be cut on this side.
 * - the sentinel after the listing is what makes a capped prefix observable
 *   (see {@link parseFileIndexOutput}).
 * - `LC_ALL=C`: byte-wise ordering from the tools, so the parser sees one
 *   canonical form no matter the host locale.
 */
export declare function fileIndexCommand(root: string, caps?: {
    entries?: number;
    bytes?: number;
}): string;
export interface FileIndexListing {
    paths: string[];
    truncated: boolean;
    /** The find fallback declared a depth bound (deeper files may be missing). */
    depthCapped: number | undefined;
}
/**
 * Turn one listing's stdout into sorted workspace-relative paths.
 *
 * Truncation is DERIVED, never assumed:
 * - the sentinel is missing → the prefix ended at a cap (or the transport cut
 *   it) → `truncated: true`, and the final line is dropped because it may be a
 *   half-written path;
 * - more than `maxEntries` lines survived → `truncated: true`, keep the prefix;
 * - the find fallback's depth marker survived → `depthCapped` (a THIRD, separate
 *   bound: more levels exist than were walked).
 *
 * The caller-visible promise is that a bounded listing NEVER looks complete:
 * every cap is its own reported fact.
 */
export declare function parseFileIndexOutput(stdout: string, options?: {
    root: string;
    maxEntries?: number;
}): FileIndexListing;
/**
 * Fetch and parse one listing.
 *
 * Rejects — loudly — whenever the run did not produce a trustworthy listing:
 * timed out, transport-broken, never entered the workspace root (exit 3), or the
 * listing tool failed AND listed nothing. A successful run with zero paths is a
 * legitimate empty index (a brand new repository) and resolves with `paths: []`;
 * a run whose tool listed some files and then reported errors resolves with the
 * usable prefix plus `toolStatus`/`warning` saying it is incomplete.
 *
 * The write counter is read BEFORE the command starts: a write that lands while
 * the listing is in flight must leave the index stale (its `writeSeq` is older),
 * otherwise the modal could show — and open — a path that no longer exists.
 */
export declare function buildFileIndex(deps: FileIndexDeps, target: {
    alias: string;
    root: string;
}, options?: {
    entries?: number;
    bytes?: number;
    timeoutMs?: number;
}): Promise<FileIndex>;
