import type { GitCommitFile, GitRemote, GitStash, GitStatusDetail, UnifiedDiffFile } from './protocol.ts';
/** Byte cap on captured output (protects one exec round trip). */
export declare const GIT_CAP = 2000000;
/** Assert a repo-relative path (no `..`, no leading `/`, no control chars). */
export declare function assertRepoPath(path: string): string;
/** Single-quote one or more asserted repo paths for the command line. */
export declare function relPaths(paths: readonly string[]): string;
/** Assert a `stash@{n}` reference (assertRef rejects braces by design). */
export declare function assertStashRef(ref: string): string;
/** Assert a branch name (same charset as a ref, plus the git branch rules we care about). */
export declare function assertBranchName(name: string): string;
/** Assert a remote name (`origin`, `upstream`, ...). */
export declare function assertRemoteName(name: string): string;
/** Assert a remote URL (anything printable without control characters). */
export declare function assertRemoteUrl(url: string): string;
/** Resolve the enclosing repository root (fails outside a work tree). */
export declare function repoProbeCommand(workdir: string): string;
/** Discover repositories under a workspace root (depth-capped). */
export declare function repoDiscoveryCommand(root: string): string;
/**
 * Branch + ahead/behind + every entry with its ignored half, NUL separated.
 *
 * `--untracked-files=normal` (not `all`) is deliberate: an untracked DIRECTORY
 * then arrives as a single `dir/` record instead of every file inside it,
 * which is what keeps this call fast on a remote tree that also contains
 * node_modules or a build output directory. `--ignored=matching` reports
 * ignored paths one level deep for the tree's greying, under the same bound.
 */
export declare function statusDetailCommand(workdir: string): string;
/**
 * Pathspec-limited porcelain status: the SAME `-z` record shape as
 * `statusDetailCommand`, restricted to the given paths.
 *
 * This is the cheap half of a stage/unstage. A full `git status` costs the
 * repository's whole index/worktree walk — minutes on the AOSP monorepo the
 * report came from — while a pathspec-limited call only visits the paths it was
 * given, so its cost tracks the touched paths instead of the repository size.
 * That is what makes it usable as an immediate verification of a local
 * (optimistic) stage.
 *
 * `--untracked-files=no` is deliberate: the untracked walk is the expensive
 * part, and it cannot answer the question this call exists for. Verified
 * against real git — an untracked path yields NO record, a path that just
 * entered the index is reported as `A ` (and a staged rename as `R  new\0old`)
 * — so absence means "not in the index", which is all the caller needs.
 */
export declare function statusPathsCommand(workdir: string, paths: readonly string[]): string;
/**
 * Pathspec-limited status INCLUDING untracked files, for ONE directory row.
 *
 * `-u normal` (the panel's performance mode) collapses an untracked directory
 * into a single `dir/` row, so the files inside it are invisible. This is the
 * command that opens it up: `-uall` lists those files individually (measured —
 * files in nested folders arrive as their own paths, never as `sub/` rows),
 * while the pathspec keeps the cost bounded by that directory instead of the
 * repository.
 *
 * The trailing slash is deliberate: it makes the pathspec name the directory
 * itself, so the call cannot match a sibling FILE that happens to share the
 * name.
 */
export declare function statusDirCommand(workdir: string, dir: string): string;
/** Branch header only (`## branch...upstream [ahead N, behind M]`), NUL safe. */
export declare function branchHeaderCommand(workdir: string): string;
/** Full message of the current HEAD commit. */
export declare function headMessageCommand(workdir: string): string;
export interface DiffRequest {
    /** Diff the index against HEAD instead of the worktree against the index. */
    staged?: boolean;
    /** Diff this revision instead of HEAD/index. */
    ref?: string;
    /** Restrict to one repo-relative path. */
    path?: string;
    /** Context lines (default git's 3). */
    context?: number;
    /** `--stat` instead of a patch. */
    stat?: boolean;
}
/** Unified diff (or a diffstat) for one side of the working tree. */
export declare function diffCommand(workdir: string, request?: DiffRequest): string;
/** Files touched by one commit (`--name-status`, no patch body). */
export declare function commitFilesCommand(workdir: string, ref: string): string;
/** One file's content at a revision (`rev` may also be `:0` for the index). */
export declare function fileAtRevCommand(workdir: string, rev: string, path: string): string;
/** Local + remote-tracking branches with their upstream and tip. */
export declare function allBranchesCommand(workdir: string): string;
/** Every configured remote with its URLs. */
export declare function remotesCommand(workdir: string): string;
/** Stash stack, newest first. */
export declare function stashListCommand(workdir: string): string;
/** Stage paths (additions, modifications, deletions and renames). */
export declare function stageCommand(workdir: string, paths: readonly string[]): string;
/** Unstage paths (index back to HEAD, worktree untouched). */
export declare function unstageCommand(workdir: string, paths: readonly string[]): string;
/** Discard worktree edits for tracked paths (irreversible). */
export declare function restoreWorktreeCommand(workdir: string, paths: readonly string[]): string;
/** Delete untracked paths from disk (irreversible; the UI confirms first). */
export declare function cleanUntrackedCommand(workdir: string, paths: readonly string[]): string;
export interface CommitRequest {
    /** Commit message (multi-line through a single -m is fine). */
    message: string;
    /** Amend the previous commit instead of adding one. */
    amend?: boolean;
    /** Skip hooks (the UI never uses this; kept for parity). */
    noVerify?: boolean;
}
/** Create a commit with the given message. */
export declare function commitCommand(workdir: string, request: CommitRequest): string;
/** Check out an existing ref (branch, tag or hash). */
export declare function checkoutCommand(workdir: string, ref: string): string;
/** Create (and check out) a branch, optionally from a start point. */
export declare function createBranchCommand(workdir: string, name: string, from?: string): string;
/** Delete a branch (`force` maps to -D). */
export declare function deleteBranchCommand(workdir: string, name: string, force: boolean): string;
/** Rename a branch. */
export declare function renameBranchCommand(workdir: string, from: string, to: string): string;
/** Merge a ref into the current branch (no editor prompt). */
export declare function mergeCommand(workdir: string, ref: string): string;
/** Publish a branch to a remote and set its upstream. */
export declare function publishBranchCommand(workdir: string, branch: string, remote: string): string;
/** Fetch every remote, pruning deleted tracking refs. */
export declare function fetchCommand(workdir: string): string;
/** Pull the current branch (merge, no editor prompt). */
export declare function pullCommand(workdir: string): string;
/** Push the current branch. */
export declare function pushCommand(workdir: string): string;
/** Stash the working tree (optionally including untracked files). */
export declare function stashSaveCommand(workdir: string, message: string, includeUntracked: boolean): string;
/** Apply (and keep) a stash entry. */
export declare function stashApplyCommand(workdir: string, ref: string): string;
/** Apply and drop a stash entry. */
export declare function stashPopCommand(workdir: string, ref: string): string;
/** Drop a stash entry (irreversible). */
export declare function stashDropCommand(workdir: string, ref: string): string;
/** Register a remote. */
export declare function addRemoteCommand(workdir: string, name: string, url: string): string;
/** Remove a remote. */
export declare function removeRemoteCommand(workdir: string, name: string): string;
/** Point an existing remote at a new URL. */
export declare function setRemoteUrlCommand(workdir: string, name: string, url: string): string;
/** Initialize a repository in place. */
export declare function initCommand(workdir: string): string;
export declare function applyPatchCommand(workdir: string, patchPath: string, mode: 'stage' | 'unstage' | 'revert'): string;
/** Enclosing repository root from `rev-parse --show-toplevel`. */
export declare function parseRepoRoot(stdout: string): string | undefined;
/** Repository dirs found under a workspace root. */
export declare function parseRepoDiscovery(stdout: string): string[];
/**
 * Normalize a workspace-relative repository directory. `''` means "the workspace
 * root itself", which is what a workspace whose root IS the repository uses.
 *
 * Pure and host-free so the client can persist exactly what the host will later
 * resolve: leading/trailing separators drop, `.` segments drop, and a `..`
 * segment pops its parent — so a picker can never address anything above the
 * workspace root (a leading `..` pops nothing).
 */
export declare function normalizeRepoSubdir(input: string): string;
/** The absolute directory git commands run in for one workspace + subdir. */
export declare function repoWorkdir(workspaceRoot: string, subdir: string): string;
/**
 * A directory expressed relative to a workspace root, or undefined when it sits
 * outside it. Turns a probed repository root back into the stored subdir, so
 * choosing a directory INSIDE a repository settles on that repository's root.
 */
export declare function repoSubdirOf(workspaceRoot: string, dir: string): string | undefined;
/**
 * Porcelain v1 in `-z` form: `XY PATH\0` records, rename/copy records carry
 * `XY NEW\0OLD\0` (the field order is reversed versus the arrow form), and
 * ignored entries arrive as `!! PATH`.
 */
export declare function parseStatusDetail(stdout: string): GitStatusDetail;
/** Split one unified diff into per-file blocks. */
export declare function parseUnifiedDiff(text: string): UnifiedDiffFile[];
/** `git show --name-status` body → per-file rows (status letters + paths). */
export declare function parseCommitFiles(stdout: string): GitCommitFile[];
/** `git remote -v` → one row per URL (fetch/push). */
export declare function parseRemotes(stdout: string): GitRemote[];
/** `stash list --pretty=format:'%gd%x1f%gs%x1f%ct%x1e'` → entries. */
export declare function parseStashList(stdout: string): GitStash[];
/** `for-each-ref refs/heads refs/remotes` → branches (remote ones flagged). */
export declare function parseAllBranches(stdout: string, current: string): import('./protocol.ts').GitBranch[];
/** Friendly text for the git failures the UI can explain better than git does. */
export declare function gitErrorHint(stderr: string): string | undefined;
