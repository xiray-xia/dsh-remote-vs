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
import type { GitStatusDetail } from '../../protocol.ts'

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
