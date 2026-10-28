/**
 * Per-repository caches for the two views that live beside the change list:
 * the source-control panel's side lists (stash / branches / remotes) and the
 * history tab's commit log.
 *
 * Same reasoning as `git-cache.ts`, one level down: the git status snapshot
 * already makes the change list paint instantly when a workspace is selected
 * again, and these caches stop the second wave of blanks. The extras are three
 * more git commands per repository switch; the log is up to 200 commits (`git
 * log` on a deep monorepo is not free). Both are read-only views of state the
 * host already answered — keeping the last answer costs nothing and is what the
 * panels show while their background re-read runs.
 *
 * MEMORY ONLY, same contract as the git snapshots, and every entry is replaced
 * by a real read; nothing is ever synthesised here.
 */
import type { GitBranch, GitCommit, GitRemote, GitStash } from '../../protocol.ts';
/** Stash / branch / remote lists of one repository (one panel refresh). */
export interface ScmExtrasSnapshot {
    stashes: GitStash[];
    branches: GitBranch[];
    remotes: GitRemote[];
    /** `Date.now()` when the read finished. */
    at: number;
}
/** The history tab's commit list of one repository. */
export interface HistorySnapshot {
    commits: GitCommit[];
    /** `Date.now()` when the read finished. */
    at: number;
}
/** Cache key of one repository, as the git panel addresses it: alias + root. */
export declare function repoCacheKey(alias: string, repoRoot: string): string;
/** The cached side lists of one repository, if it was read before. */
export declare function readScmExtras(key: string): ScmExtrasSnapshot | undefined;
/** Remember one repository's side lists. */
export declare function writeScmExtras(key: string, snapshot: ScmExtrasSnapshot): void;
/** The cached commit log of one repository, if it was read before. */
export declare function readHistorySnapshot(key: string): HistorySnapshot | undefined;
/** Remember one repository's commit log. */
export declare function writeHistorySnapshot(key: string, snapshot: HistorySnapshot): void;
/** Test hook: forget both caches (the panel caches carry no other state). */
export declare function clearPanelCaches(): void;
