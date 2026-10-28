/**
 * Last-read git state, remembered per workspace AND per repository directory.
 *
 * The complaint this module answers: switching between two remote workspaces
 * blanked the source-control panel. The store dropped `status` / `head` /
 * `repoRoot` on the switch and started a full `git status` again — minutes of
 * "Loading…" on a large repository — even though BOTH workspaces had just been
 * read, so the very data the panel needed was already in memory. It simply had
 * no home: the store keeps one git slice, describing whatever is on screen.
 *
 * A snapshot is that home. It holds everything the panel paints from, keyed by
 * the binding id AND the workspace-relative directory git ran in, because one
 * workspace can carry several repositories and their states must never
 * overwrite each other (the repo picker switches between them). The store
 * hydrates a snapshot the moment a workspace is selected — in the same frame as
 * the dropdown change — and refreshes it in the background; the read replaces
 * the snapshot and repaints only when it is still the current binding's answer.
 *
 * MEMORY ONLY, on purpose: a `-u normal -z --ignored=matching` status of a
 * monorepo is hundreds of kilobytes, and after a page reload it would describe
 * a tree that may have moved on. The cache is an accelerator for switching, not
 * a second source of truth — every value in it was read by a real command.
 */
import type { GitStatusDetail } from '../../protocol.ts'
import type { DirExpansions } from './untracked-dirs.ts'

/**
 * Branch header, structurally identical to the store's `HeadInfo`.
 *
 * Declared here instead of imported from `store.tsx` so this module stays a
 * standalone leaf: `store` imports it, and a type-only back-import would pull
 * the whole store into the module graph of every gate that touches the cache.
 */
export interface GitHead {
  branch: string
  detached: boolean
  ahead: number
  behind: number
}

/** Everything one git read answered, as the panels need it. */
export interface GitSnapshot {
  /** Enclosing repository root, or undefined when the directory is no repo. */
  repoRoot: string | undefined
  /** Workspace-relative directory git ran in (the settled one). */
  repoSubdir: string
  status: GitStatusDetail
  head: GitHead | undefined
  /** git answered "not a repository" — a fact, not a failure. */
  repoMissing: boolean
  /** Expanded untracked directories, repository-relative. */
  untrackedDirs: DirExpansions
  /** `Date.now()` when the read that produced this snapshot finished. */
  at: number
}

/**
 * Separator between the binding id and the repository directory.
 *
 * NUL cannot appear in either half: a binding id comes from the host's table
 * and a workspace-relative sub-directory is a path. The key must be reversible
 * because `retainGitSnapshots` deletes everything whose binding is gone.
 */
const KEY_SEP = '\u0000'

/** Cache key for one (workspace, repository directory) pair. */
export function gitCacheKey(bindingId: string, repoSubdir: string): string {
  return `${bindingId}${KEY_SEP}${repoSubdir}`
}

/** Split a cache key back into its two halves (undefined when it is not one). */
export function parseGitCacheKey(key: string): { bindingId: string; repoSubdir: string } | undefined {
  const at = key.indexOf(KEY_SEP)
  if (at < 0) return undefined
  return { bindingId: key.slice(0, at), repoSubdir: key.slice(at + 1) }
}

/**
 * How many (workspace, repository) pairs stay cached.
 *
 * Bindings are few (the workspace table is hand-managed) and each snapshot is
 * the panel's whole change list, so a small bound is plenty; the LRU trim only
 * exists so a long-lived page cannot grow without limit.
 */
const SNAPSHOT_LIMIT = 12

/** Snapshots by cache key, in recency order (oldest insertion first). */
const snapshots = new Map<string, GitSnapshot>()

/** The cached read for one (workspace, repository directory), if any. */
export function readGitSnapshot(key: string): GitSnapshot | undefined {
  const snapshot = snapshots.get(key)
  if (snapshot === undefined) return undefined
  // Touch: keep the LRU honest without changing the snapshot's own `at`.
  snapshots.delete(key)
  snapshots.set(key, snapshot)
  return snapshot
}

/**
 * Remember one read.
 *
 * Called even when the read is no longer the binding on screen: the walk has
 * already been paid for, and caching it is what makes the NEXT switch back
 * instant instead of another minutes-long wait.
 *
 * An answer OLDER than the one already cached is dropped. Two reads of one
 * workspace can overlap when the repo picker changes the directory mid-read (the
 * settled directory is a second key, see the store's `readGit`), and the older
 * walk may finish last — letting it win would hand the user a change list that
 * predates the one already shown.
 */
export function writeGitSnapshot(key: string, snapshot: GitSnapshot): void {
  const previous = snapshots.get(key)
  if (previous !== undefined && previous.at > snapshot.at) return
  snapshots.delete(key)
  snapshots.set(key, snapshot)
  while (snapshots.size > SNAPSHOT_LIMIT) {
    const oldest = snapshots.keys().next()
    if (oldest.done === true) break
    snapshots.delete(oldest.value)
  }
}

/** Drop every snapshot whose workspace left the binding table. */
export function retainGitSnapshots(bindingIds: ReadonlySet<string>): void {
  for (const key of [...snapshots.keys()]) {
    const parsed = parseGitCacheKey(key)
    if (parsed === undefined || !bindingIds.has(parsed.bindingId)) snapshots.delete(key)
  }
}

/**
 * Write a locally-known status into a cached snapshot.
 *
 * The plotted stage/unstage move is applied to the store's status WITHOUT a
 * repository-wide read (see `applyLocalStage`). Without this write-through the
 * cache would keep the pre-click list, so switching away and back would flip
 * the row back — the panel would show a change the user already staged.
 * A different `repoRoot` means the snapshot is not that repository: refusing is
 * what keeps one workspace's rows out of another's cache.
 */
export function patchCachedGitStatus(key: string, repoRoot: string | undefined, status: GitStatusDetail): void {
  const snapshot = snapshots.get(key)
  if (snapshot === undefined || snapshot.repoRoot !== repoRoot) return
  snapshots.set(key, { ...snapshot, status })
}

/** Same write-through for the expanded untracked directories. */
export function patchCachedUntrackedDirs(key: string, repoRoot: string | undefined, dirs: DirExpansions): void {
  const snapshot = snapshots.get(key)
  if (snapshot === undefined || snapshot.repoRoot !== repoRoot) return
  snapshots.set(key, { ...snapshot, untrackedDirs: dirs })
}

/** Test hook: forget every snapshot (the cache gate drives this module alone). */
export function clearGitSnapshots(): void {
  snapshots.clear()
}
