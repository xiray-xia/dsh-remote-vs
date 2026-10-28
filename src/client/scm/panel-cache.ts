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
import type { GitBranch, GitCommit, GitRemote, GitStash } from '../../protocol.ts'

/** Stash / branch / remote lists of one repository (one panel refresh). */
export interface ScmExtrasSnapshot {
  stashes: GitStash[]
  branches: GitBranch[]
  remotes: GitRemote[]
  /** `Date.now()` when the read finished. */
  at: number
}

/** The history tab's commit list of one repository. */
export interface HistorySnapshot {
  commits: GitCommit[]
  /** `Date.now()` when the read finished. */
  at: number
}

/** Separator for the composite key (cannot appear in an alias or a POSIX path). */
const KEY_SEP = '\u0000'

/** How many repositories each cache keeps; the LRU trim is only a bound. */
const ENTRY_LIMIT = 12

/** Cache key of one repository, as the git panel addresses it: alias + root. */
export function repoCacheKey(alias: string, repoRoot: string): string {
  return `${alias}${KEY_SEP}${repoRoot}`
}

/** Insert-or-touch one entry, then trim the oldest beyond the bound. */
function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > ENTRY_LIMIT) {
    const oldest = cache.keys().next()
    if (oldest.done === true) break
    cache.delete(oldest.value)
  }
}

/** Read-or-touch one entry (LRU order without changing the value). */
function recall<T>(cache: Map<string, T>, key: string): T | undefined {
  const value = cache.get(key)
  if (value === undefined) return undefined
  cache.delete(key)
  cache.set(key, value)
  return value
}

const extrasCache = new Map<string, ScmExtrasSnapshot>()
const historyCache = new Map<string, HistorySnapshot>()

/** The cached side lists of one repository, if it was read before. */
export function readScmExtras(key: string): ScmExtrasSnapshot | undefined {
  return recall(extrasCache, key)
}

/** Remember one repository's side lists. */
export function writeScmExtras(key: string, snapshot: ScmExtrasSnapshot): void {
  remember(extrasCache, key, snapshot)
}

/** The cached commit log of one repository, if it was read before. */
export function readHistorySnapshot(key: string): HistorySnapshot | undefined {
  return recall(historyCache, key)
}

/** Remember one repository's commit log. */
export function writeHistorySnapshot(key: string, snapshot: HistorySnapshot): void {
  remember(historyCache, key, snapshot)
}

/** Test hook: forget both caches (the panel caches carry no other state). */
export function clearPanelCaches(): void {
  extrasCache.clear()
  historyCache.clear()
}
