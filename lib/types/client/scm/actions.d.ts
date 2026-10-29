/**
 * Remote git action layer: every SCM verb the UI can trigger, expressed as
 * one remote command through the existing exec route.
 *
 * Nothing here needs a host-side change: the command builders live in
 * `src/git-ops.ts` (asserted + single-quoted, so a file name can never escape
 * into shell syntax), the parsers are pure, and errors are translated to the
 * messages a user can act on (missing identity, no upstream, conflicts, ...).
 */
import { REMOTE_API } from '../../protocol.ts';
import type { GitBranch, GitCommitFile, GitRemote, GitStash, GitStatusDetail, RemoteExecResult, RemoteRead } from '../../protocol.ts';
import { type PushTarget } from '../exec-output.ts';
/** Error carrying a message already fit for the UI. */
export declare class GitOpError extends Error {
}
/** Join a remote directory with a repo-relative path. */
export declare function joinRemote(dir: string, rel: string): string;
/** The repository that encloses a workspace directory (undefined when none). */
export declare function resolveRepoRoot(alias: string, workspaceRoot: string): Promise<string | undefined>;
/**
 * The same probe, telling "not a repository" apart from "the probe failed".
 *
 * `git rev-parse --show-toplevel` exits non-zero BOTH when the directory is not
 * inside a work tree and for every way a remote command can fail (host gone,
 * budget blown, sshd refusing, no answer at all). `resolveRepoRoot` folds the two
 * into `undefined`, which is right for the workspace wizard — there "unknown" and
 * "none" both mean "nothing to offer". The SCM panel cannot take that shortcut:
 * treating a failed probe as "no repository" writes an EMPTY snapshot over the
 * cached change list and tells the user their workspace has no git repository.
 * That is exactly the blank state the snapshot cache exists to prevent, so this
 * variant asks a command that KEEPS the answer (`repoProbeDetailCommand`: exit
 * code + merged streams, `LC_ALL=C`) and reports the failure to the caller.
 */
export type RepoRootProbe = {
    kind: 'repo';
    root: string;
} | {
    kind: 'none';
} | {
    kind: 'failed';
    error: string;
};
/** The repository root, or WHY the probe could not answer. */
export declare function probeRepoRoot(alias: string, workspaceRoot: string): Promise<RepoRootProbe>;
/** Repositories under a workspace root (the workspace itself sorts first). */
export declare function findRepos(alias: string, workspaceRoot: string): Promise<string[]>;
/** Every changed path plus the ignored half. */
export declare function loadStatusDetail(alias: string, root: string): Promise<GitStatusDetail>;
/**
 * Pathspec-limited status probe: the raw `-z` stdout for JUST these paths.
 *
 * The verification half of a stage/unstage. It deliberately does not go through
 * `loadStatusDetail`: that command walks the whole repository (minutes on a
 * large one), while this one is bounded by the paths handed to it — which is
 * what lets the panel confirm an optimistic stage immediately.
 *
 * The budget is the read-path one (60 s), not the git budget: a probe that
 * hangs must not hold the panel for the full git timeout.
 *
 * @param alias - host alias.
 * @param root - absolute remote repository root (git runs here).
 * @param paths - repo-relative paths that were just staged/unstaged.
 * @returns the raw `-z` porcelain stdout ('' when nothing was asked).
 */
export declare function probeStatusPaths(alias: string, root: string, paths: readonly string[]): Promise<string>;
/**
 * Expand ONE untracked directory row: the raw `-z` stdout for what is inside.
 *
 * `-uall` is what makes the contents visible at all (the panel's own status call
 * uses `-u normal`, which collapses a directory into one row), and the pathspec
 * keeps the cost bounded by that directory — this must never become a
 * repository-wide walk.
 */
export declare function probeStatusDir(alias: string, root: string, dir: string): Promise<string>;
/** Current branch with its ahead/behind counters (detached HEAD tolerated). */
export declare function loadHead(alias: string, root: string): Promise<{
    branch: string;
    detached: boolean;
    ahead: number;
    behind: number;
}>;
/** Both sides of a diff plus the diff itself. */
export interface DiffPayload {
    diff: string;
    oldText: string;
    newText: string;
    /** True when either side is binary (the view refuses to render it). */
    unsupported: boolean;
}
/** Load a file's diff with both full revisions. */
export declare function loadDiff(alias: string, root: string, path: string, staged: boolean, untracked?: boolean): Promise<DiffPayload>;
/** Files touched by one commit. */
export declare function loadCommitFiles(alias: string, root: string, hash: string): Promise<GitCommitFile[]>;
/**
 * Diff of one path inside a commit (the editor drill-down).
 *
 * `origPath` is the rename source: `git show -M -- <old> <new>` needs BOTH
 * paths or git cannot pair them and a 100% rename renders as a fully-added
 * file. A root commit has no `^` revision — `git show <hash>` already diffs
 * against the empty tree, and the failed old-side read degrades to ''.
 */
export declare function loadCommitFileDiff(alias: string, root: string, hash: string, path: string, origPath?: string): Promise<DiffPayload>;
/** Raw message of one commit, split into its subject line and the body. */
export declare function loadCommitMessage(alias: string, root: string, hash: string): Promise<{
    subject: string;
    body: string;
}>;
/**
 * Whole patch of one commit (the commit header is stripped: starts at
 * `diff --git`).
 *
 * `truncated` answers whether the read hit `commitPatchCommand`'s BYTE cap.
 * The cap is applied with `head -c` (bytes) while the string length counts
 * UTF-16 code units, so the comparison must measure BYTES too — a CJK-heavy
 * patch capped at 2,000,000 bytes is only ~667k characters, and a char-length
 * check silently reported "complete" for a cut patch.
 */
export declare function loadCommitPatch(alias: string, root: string, hash: string): Promise<{
    text: string;
    truncated: boolean;
}>;
/** Local + remote-tracking branches. */
export declare function loadBranches(alias: string, root: string, current: string): Promise<GitBranch[]>;
/** Configured remotes. */
export declare function loadRemotes(alias: string, root: string): Promise<GitRemote[]>;
/** The stash stack. */
export declare function loadStashes(alias: string, root: string): Promise<GitStash[]>;
/** Stage paths (additions, edits, deletions, renames). */
export declare function stagePaths(alias: string, root: string, paths: readonly string[]): Promise<void>;
/** Unstage paths without touching the worktree. */
export declare function unstagePaths(alias: string, root: string, paths: readonly string[]): Promise<void>;
/**
 * Discard worktree edits. Untracked paths are DELETED (the caller confirms
 * first); tracked paths are restored from the index.
 */
export declare function discardPaths(alias: string, root: string, tracked: readonly string[], untracked: readonly string[]): Promise<void>;
/**
 * Apply one hunk: into the index (`stage`), out of the index (`unstage`), or
 * out of the worktree (`revert`). The patch travels as a temp file because
 * the exec route has no stdin channel — which also keeps the patch text away
 * from shell quoting entirely.
 */
export declare function applyHunk(alias: string, root: string, patch: string, mode: 'stage' | 'unstage' | 'revert'): Promise<void>;
/** Create a commit. */
export declare function commitAll(alias: string, root: string, message: string, amend?: boolean): Promise<string>;
/** Last commit message (drives the amend flow). */
export declare function lastCommitMessage(alias: string, root: string): Promise<string>;
/** fetch / pull / push / sync. */
export declare function syncRepo(alias: string, root: string, kind: 'fetch' | 'pull' | 'push' | 'sync'): Promise<string>;
/**
 * Push to an explicit remote with an explicit refspec (Gerrit review flow:
 * `HEAD:refs/for/<branch>`). Same timeout budget as the other network verbs.
 */
export declare function pushWithRefspec(alias: string, root: string, remote: string, refspec: string): Promise<string>;
export interface NetworkStreamHandlers {
    onData?: (stream: 'out' | 'err', text: string) => void;
    signal?: AbortSignal;
}
/**
 * Run one network verb over the STREAMING exec route and accumulate its log.
 *
 * Stops at the first failing step (a sync whose pull failed must not push a
 * half-merged tree). The caller owns the live panel; this returns only once the
 * whole verb has settled, with `output` capped to its tail.
 */
export declare function streamNetworkVerb(alias: string, root: string, kind: 'fetch' | 'pull' | 'push' | 'sync', push: PushTarget, handlers?: NetworkStreamHandlers): Promise<{
    result: RemoteExecResult;
    output: string;
}>;
/** Branch verbs. */
export declare function branchOp(alias: string, root: string, op: {
    kind: 'checkout';
    ref: string;
} | {
    kind: 'create';
    name: string;
    from?: string;
} | {
    kind: 'delete';
    name: string;
    force: boolean;
} | {
    kind: 'rename';
    from: string;
    to: string;
} | {
    kind: 'merge';
    ref: string;
} | {
    kind: 'publish';
    name: string;
    remote: string;
}): Promise<string>;
/** Remote verbs. */
export declare function remoteOp(alias: string, root: string, op: {
    kind: 'add';
    name: string;
    url: string;
} | {
    kind: 'remove';
    name: string;
} | {
    kind: 'setUrl';
    name: string;
    url: string;
}): Promise<string>;
/** Stash verbs. */
export declare function stashOp(alias: string, root: string, op: {
    kind: 'save';
    message: string;
    includeUntracked: boolean;
} | {
    kind: 'apply';
    ref: string;
} | {
    kind: 'pop';
    ref: string;
} | {
    kind: 'drop';
    ref: string;
}): Promise<string>;
/** Check out one commit (detached HEAD; the UI warns first). */
export declare function checkoutCommit(alias: string, root: string, hash: string): Promise<string>;
/** One file-name search hit. */
export interface SearchHit {
    path: string;
    name: string;
    dir: string;
    isDir: boolean;
}
/**
 * Name search under a remote directory: `rg` when the host has it, `find` when
 * it does not — decided BY THE HOST inside one command, so there is no probe
 * round trip and no per-alias cache to invalidate.
 *
 * Why the fallback exists at all: the previous implementation was `find` with a
 * hard `-maxdepth 6`, and that cap silently hid real files — in a monorepo of a
 * few million files, a source file ten levels down is simply invisible to it.
 * Measured on such a tree: `find -maxdepth 6` → 0 hits (2.0 s), `find -maxdepth
 * 12` → the hit, but 13.5 s, an uncapped `find` → does not finish at all, and
 * `rg --files --iglob` → the hit in ~4 s with no depth limit, because it walks
 * the tree once with a prefiltered glob instead of stat-ing every entry.
 *
 * Coverage: `--no-ignore --hidden` keeps what `find` did — it never consulted
 * .gitignore — so a generated or ignored file is still findable by name. The
 * fallback keeps a cap (raised from 6 to 12) because an uncapped walk is not
 * viable on a tree that size.
 *
 * The query is a GLOB fragment (as it always was): `*.java` still works as a
 * pattern, and `--iglob` matches case-insensitively like `find -iname`.
 */
export declare function searchFiles(alias: string, root: string, query: string, limit?: number, depth?: number): Promise<{
    hits: SearchHit[];
    truncated: boolean;
}>;
/** Read a remote file as text/base64 (used by the previews). */
export declare function readRemoteFile(alias: string, fullPath: string): Promise<RemoteRead>;
/** The terminal API base (kept here so both halves agree on the route table). */
export { REMOTE_API };
