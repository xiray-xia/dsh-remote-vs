/**
 * Pure status model: buckets the detailed porcelain status into the SCM
 * sections and derives the per-path / per-directory marks the file tree
 * paints.
 *
 * Directory marks come from the STATUS PATH SET, never from materialized
 * children: the remote tree is lazy (one SFTP listing per expanded folder),
 * so a collapsed folder holding changes must still light up. Ignored state is
 * inherited downward, because `git status --ignored=matching` reports an
 * ignored directory once, unexpanded.
 */
import type { GitPathStatus, GitStatusDetail } from '../../protocol.ts'

/** One changed path as the SCM panel shows it. */
export interface ChangeEntry {
  path: string
  /** Single letter (`M`, `A`, `D`, `R`, `C`, `U`, `T`, `?`). */
  status: string
  /** Rename/copy source. */
  oldPath?: string
  /** True when this entry belongs to the staged (index) half. */
  staged: boolean
}

/** The SCM sections: conflicts, changes (unstaged + untracked), staged. */
export interface StatusBuckets {
  conflicts: ChangeEntry[]
  changes: ChangeEntry[]
  staged: ChangeEntry[]
  untracked: ChangeEntry[]
  ignored: string[]
  /** Badge count: staged + unstaged + untracked (conflicts excluded). */
  total: number
}

/** True for a merge-conflict pair (UU/AA/DD/AU/UA/DU/UD). */
function isConflict(x: string, y: string): boolean {
  return x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')
}

/** The most descriptive letter for a path that has both halves changed. */
function pickLetter(staged: string, unstaged: string): string {
  const rank = (letter: string): number => {
    switch (letter) {
      case 'D': return 60
      case 'M': return 50
      case 'T': return 45
      case 'A': return 40
      case 'R': return 30
      case 'C': return 20
      default: return 10
    }
  }
  if (staged === '' || staged === ' ') return unstaged
  if (unstaged === '' || unstaged === ' ') return staged
  return rank(unstaged) >= rank(staged) ? unstaged : staged
}

/** Bucket the detailed status into the panel's sections. */
export function bucketStatus(detail: GitStatusDetail): StatusBuckets {
  const conflicts: ChangeEntry[] = []
  const changes: ChangeEntry[] = []
  const staged: ChangeEntry[] = []
  const untracked: ChangeEntry[] = []
  const stagedByPath = new Map<string, string>()
  const worktreeByPath = new Map<string, string>()

  for (const entry of detail.entries) {
    const { path, x, y, origPath } = entry
    if (x === '?' && y === '?') {
      const item: ChangeEntry = { path, status: '?', staged: false }
      untracked.push(item)
      changes.push(item)
      continue
    }
    if (isConflict(x, y)) {
      conflicts.push({ path, status: 'U', staged: false, ...(origPath === undefined ? {} : { oldPath: origPath }) })
      continue
    }
    if (x !== ' ' && x !== '?') {
      staged.push({ path, status: x, staged: true, ...(origPath === undefined ? {} : { oldPath: origPath }) })
      stagedByPath.set(path, x)
    }
    if (y !== ' ' && y !== '?') {
      changes.push({ path, status: y, staged: false, ...(origPath === undefined ? {} : { oldPath: origPath }) })
      worktreeByPath.set(path, y)
    }
  }

  // The panel lists changes with the worktree letter (VS Code semantics); the
  // tree uses the same precedence so both surfaces agree.
  const merged = changes.map(entry => {
    const stagedLetter = stagedByPath.get(entry.path)
    if (stagedLetter === undefined) return entry
    return { ...entry, status: pickLetter(stagedLetter, entry.status) }
  })

  return {
    conflicts,
    changes: merged,
    staged,
    untracked,
    ignored: detail.ignored,
    // `untracked` is a SUBSET view of `changes` (an untracked row is pushed to
    // both, see above), so adding it double-counted every untracked file: one
    // untracked file made the rail badge read 2 while the list showed 1. The
    // badge counts entries, and every entry is either staged, changed or
    // conflicted — exactly the three sections the panel renders.
    total: staged.length + merged.length + conflicts.length,
  }
}

/**
 * Whether one porcelain record counts as STAGED for the panel.
 *
 * Mirrors `bucketStatus` exactly, because a verification that disagreed with
 * the list would "correct" a change the user can see was applied: an untracked
 * record is not in the index at all, and a conflict pair lives in its own
 * section (never in "staged changes").
 */
export function isStagedStatus(x: string, y: string): boolean {
  if (x === '?' || y === '?') return false
  if (isConflict(x, y)) return false
  return x !== ' '
}

/**
 * The staged-ness of one path in a PATH-LIMITED status probe
 * (`git status --porcelain -z -uno -- <paths>`).
 *
 * The probe runs with `--untracked-files=no`, so a path that is not in the
 * index has no record at all: absence means "not staged" (measured against
 * real git — untracked → no record, staged → `A `/`M `).
 *
 * A trailing slash is an untracked DIRECTORY row (`-u normal` reports the
 * directory once): `git add -- dir/` puts every file inside into the index and
 * the probe then reports those files individually, never `dir/` itself — so a
 * directory path is answered by prefix (also measured).
 */
export function stagedStateOf(detail: GitStatusDetail, path: string): boolean {
  if (path.endsWith('/')) {
    return detail.entries.some(entry => entry.path.startsWith(path) && isStagedStatus(entry.x, entry.y))
  }
  const hit = detail.entries.find(entry => entry.path === path || entry.origPath === path)
  return hit === undefined ? false : isStagedStatus(hit.x, hit.y)
}

/**
 * The local (optimistic) projection of one stage/unstage: what the detailed
 * status looks like the moment the user clicks, before the host answers.
 *
 * The transform mirrors what git does to the two halves of a porcelain record
 * (`git add` clears the worktree half, `git restore --staged` clears the index
 * half) and was checked against real git for the cases that are not obvious:
 *   - staging an untracked path (`??`) makes it `A `;
 *   - unstaging a staged NEW file returns it to `??` (untracked rows are listed
 *     under "changes", so the record stays in the model);
 *   - unstaging a staged RENAME leaves HEAD's path deleted in the INDEX — the
 *     old path becomes `D ` and the new one untracked (measured, not assumed);
 *   - staging a conflict resolves it into the index.
 *
 * Pure, so the panel's instant feedback is assertable without a host: the
 * caller decides WHEN to apply it (and when to apply the inverse).
 *
 * @param detail - the status the panel is showing.
 * @param paths - repo-relative paths that were just staged/unstaged.
 * @param staged - true for a stage, false for an unstage.
 * @returns the projected status (the same object when no path matched).
 */
export function optimisticStageDetail(
  detail: GitStatusDetail,
  paths: readonly string[],
  staged: boolean,
): GitStatusDetail {
  if (paths.length === 0) return detail
  const wanted = new Set(paths)
  const entries: GitPathStatus[] = []
  let touched = false
  for (const entry of detail.entries) {
    if (!wanted.has(entry.path)) {
      entries.push(entry)
      continue
    }
    touched = true
    entries.push(...localStageEntry(entry, staged))
  }
  return touched ? { ...detail, entries } : detail
}

/** One record's local projection (a rename unstaged into two records). */
function localStageEntry(entry: GitPathStatus, staged: boolean): GitPathStatus[] {
  const { path, x, y, origPath } = entry
  const keep = origPath === undefined ? {} : { origPath }
  if (staged) {
    // The index half takes the most descriptive letter it can keep: what is
    // already staged, else what the worktree showed, else a plain add.
    const letter = x !== ' ' && x !== '?' ? x : (y !== ' ' && y !== '?' ? y : 'M')
    return [{ path, x: letter, y: ' ', ...keep }]
  }
  // Unmerged paths: `git restore --staged` refuses them, so the local model
  // shows nothing until the verb reports the failure.
  if (isConflict(x, y)) return [entry]
  // Unstage puts the index half back to HEAD. A path HEAD does not have — an
  // addition, a rename/copy destination, an untracked row — therefore has no
  // index entry left at all and becomes untracked again (measured against real
  // git: unstaging a staged rename leaves the new name untracked and HEAD's old
  // path deleted in the INDEX).
  if (x === '?' || x === 'A' || x === 'R' || x === 'C') {
    const out: GitPathStatus[] = [{ path, x: '?', y: '?' }]
    if (x === 'R' && origPath !== undefined) out.push({ path: origPath, x: 'D', y: ' ' })
    return out
  }
  // HEAD has the path: what is left of the record is the worktree half.
  const worktree = y !== ' ' && y !== '?' ? y : x
  return [{ path, x: ' ', y: worktree, ...keep }]
}

/** One local stage/unstage result a full status read may not have seen. */
export interface StageOverride {
  staged: boolean
  /** Monotonic sequence number of the local change. */
  at: number
}

/**
 * Re-apply the local stage results a FULL status read could not have seen.
 *
 * Skipping the repository-wide refresh after a stage is what makes the click
 * instant, but another verb (a save, a discard, a commit) can still have a full
 * `git status` in flight — and on a large repository that read started minutes
 * ago. Landing it as-is would flip the row the user just staged back into
 * "changes", i.e. the panel would contradict itself for as long as it takes to
 * run the next full read. A read that STARTED before a local change cannot have
 * seen it, so those paths keep the local value; a read that started after them
 * is authoritative and prunes them.
 *
 * @param detail - the freshly read status.
 * @param overrides - repo-relative path → local stage result (one repository).
 * @param startedAt - the sequence number when the read was issued.
 * @returns the detail with the newer local results re-applied.
 */
export function applyStageOverrides(
  detail: GitStatusDetail,
  overrides: ReadonlyMap<string, StageOverride>,
  startedAt: number,
): GitStatusDetail {
  let next = detail
  for (const [path, override] of overrides) {
    if (override.at <= startedAt) continue
    next = optimisticStageDetail(next, [path], override.staged)
  }
  return next
}

/** Per-path marks the tree paints: file letter, directory roll-up, ignored. */
export interface TreeMarks {
  /** Repo-relative path → single status letter (`M`, `A`, `D`, `U`, `?`). */
  files: Map<string, string>
  /** Repo-relative directory → `M` when any descendant changed. */
  dirs: Map<string, string>
  /** Repo-relative paths (files and directories) git ignores. */
  ignored: Set<string>
  /** Directory prefixes implied by the ignored set, for deep paths. */
  ignoredDirs: Set<string>
}

/** Strip a trailing slash and a leading `./` so status paths match tree paths. */
function normalize(path: string): string {
  return path.replace(/^\.\//, '').replace(/\/+$/, '')
}

/**
 * Build tree marks from the detailed status.
 *
 * `buckets` may be supplied when the caller has already bucketed the same
 * status. The marks need the same four lists, and recomputing them meant every
 * store publish walked the whole change list twice.
 */
export function buildTreeMarks(detail: GitStatusDetail, buckets: StatusBuckets = bucketStatus(detail)): TreeMarks {
  const files = new Map<string, string>()
  const dirs = new Map<string, string>()
  const stagedLetters = new Map<string, string>()
  const worktreeLetters = new Map<string, string>()

  const put = (rawPath: string, letter: string): void => {
    const path = normalize(rawPath)
    if (path === '') return
    // `-u normal` reports an untracked DIRECTORY as one `dir/` record: strip
    // the slash and it becomes a directory mark, not a phantom file.
    if (rawPath.endsWith('/')) dirs.set(path, letter === '?' ? 'M' : letter)
    else files.set(path, letter)
  }
  for (const entry of buckets.staged) stagedLetters.set(normalize(entry.path), entry.status)
  for (const entry of buckets.changes) worktreeLetters.set(normalize(entry.path), entry.status)
  for (const entry of buckets.untracked) put(entry.path, '?')
  for (const entry of buckets.conflicts) put(entry.path, 'U')

  const all = new Set<string>([...stagedLetters.keys(), ...worktreeLetters.keys()])
  for (const path of all) {
    const stagedLetter = stagedLetters.get(path)
    const worktreeLetter = worktreeLetters.get(path)
    if (files.has(path) || dirs.has(path)) continue
    files.set(path, stagedLetter === undefined
      ? (worktreeLetter as string)
      : worktreeLetter === undefined
        ? stagedLetter
        : pickLetter(stagedLetter, worktreeLetter))
  }

  // Every directory on the way to a changed path is itself changed.
  const markParents = (path: string): void => {
    const segments = path.split('/')
    let acc = ''
    for (let i = 0; i < segments.length - 1; i++) {
      acc = acc === '' ? (segments[i] as string) : `${acc}/${segments[i]}`
      if (dirs.get(acc) === 'M') continue
      dirs.set(acc, 'M')
    }
  }
  for (const path of [...files.keys()]) markParents(path)
  for (const path of [...dirs.keys()]) markParents(path)

  const ignored = new Set<string>()
  const ignoredDirs = new Set<string>()
  for (const raw of buckets.ignored) {
    const path = normalize(raw)
    if (path === '') continue
    if (raw.endsWith('/')) ignoredDirs.add(path)
    else ignored.add(path)
    const segments = path.split('/')
    let acc = ''
    for (let i = 0; i < segments.length - 1; i++) {
      acc = acc === '' ? (segments[i] as string) : `${acc}/${segments[i]}`
      ignoredDirs.add(acc)
    }
  }

  return { files, dirs, ignored, ignoredDirs }
}
