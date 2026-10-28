/**
 * Pure model behind the history panel's commit pane.
 *
 * The pane answers three questions about the selected commit — who/when/what
 * it says (`details`), which files it touched (`content`) and what changed
 * (`diff`). Only the last one needs the patch, so this module turns one
 * `git show --patch` text into the per-file blocks the view renders: file
 * header (path, rename source, status letter, +/− counts), hunk rows carrying
 * BOTH line numbers (a patch already narrates the pairing), and `skip` rows
 * where a hunk jumps ahead.
 *
 * Everything here is pure so `scripts/check-commit-pane.mjs` can pin it,
 * including a replay against a real repository's `git show --numstat`: a
 * hand-written expectation would only encode my idea of git's output.
 *
 * No full-file context is available: a commit patch is read-only and git only
 * ships the hunks. That is deliberate — building the two full revisions per
 * file would cost one `git show <rev>:<path>` per side per file just to paint
 * unchanged lines nobody asked for.
 */
import { parseUnifiedDiff } from '../../git-ops.ts'
import type { GitCommitFile } from '../../protocol.ts'

/** The pane's three views, in strip order. */
export const HISTORY_TABS = ['details', 'content', 'diff'] as const

export type HistoryTab = (typeof HISTORY_TABS)[number]

/** Guard for persisted values (`localStorage` may hold anything). */
export function isHistoryTab(value: unknown): value is HistoryTab {
  return typeof value === 'string' && (HISTORY_TABS as readonly string[]).includes(value)
}

/**
 * Keyboard navigation for the pane's tab strip: arrows cycle (wrapping, so the
 * last tab's → returns to the first), Home/End jump to the ends. `undefined`
 * means "not a navigation key" and the caller leaves the event alone.
 */
export function stepHistoryTab(current: HistoryTab, key: string): HistoryTab | undefined {
  const index = HISTORY_TABS.indexOf(current)
  if (key === 'Home') return HISTORY_TABS[0]
  if (key === 'End') return HISTORY_TABS[HISTORY_TABS.length - 1]
  if (key === 'ArrowLeft') return HISTORY_TABS[(index - 1 + HISTORY_TABS.length) % HISTORY_TABS.length]
  if (key === 'ArrowRight') return HISTORY_TABS[(index + 1) % HISTORY_TABS.length]
  return undefined
}

/** One rendered patch line. */
export interface PatchRow {
  kind: 'context' | 'add' | 'del' | 'skip'
  /** Old-revision line number; null on added lines and skip markers. */
  oldLine: number | null
  /** New-revision line number; null on deleted lines and skip markers. */
  newLine: number | null
  /** Line content without the leading ` ` / `+` / `-` marker. */
  text: string
}

/** One file block of a commit patch. */
export interface CommitPatchFile {
  /** Destination path (the source for deletions). */
  path: string
  /** Source path when the block is a rename/copy (equals `path` otherwise). */
  oldPath: string
  status: string
  binary: boolean
  added: number
  deleted: number
  rows: PatchRow[]
  /** True when the global row cap kept this block's rows (partly) out. */
  truncated: boolean
}

export interface CommitPatchModel {
  files: CommitPatchFile[]
  added: number
  deleted: number
  /** True when the row cap cut the model (later blocks may have no rows). */
  truncated: boolean
}

/**
 * Rendered-row ceiling for one commit patch.
 *
 * A commit that rewrites a generated file can carry hundreds of thousands of
 * lines; painting them all freezes the sidebar on a click. The header counts
 * stay exact (they come from the parsed hunks, not from the rendered rows), so
 * the truncation notice only claims what is actually missing: the paint.
 */
export const PATCH_ROW_CAP = 6000

/** Build the render model for one commit's `git show --patch` text. */
export function buildCommitPatch(text: string, rowCap = PATCH_ROW_CAP): CommitPatchModel {
  const files: CommitPatchFile[] = []
  let added = 0
  let deleted = 0
  let painted = 0
  let truncated = false

  for (const file of parseUnifiedDiff(text)) {
    const rows: PatchRow[] = []
    let fileAdded = 0
    let fileDeleted = 0
    let fileTruncated = false
    /** End of the previous hunk, so the next one can name its jump. */
    let oldEnd = 1
    let newEnd = 1
    for (const [index, hunk] of file.hunks.entries()) {
      // The unshown gap before a hunk: git itself prints nothing there, but a
      // reader of a unified patch needs to know the line numbers skipped.
      const gap = hunk.newStart - newEnd
      const oldGap = hunk.oldStart - oldEnd
      if (index === 0 ? hunk.oldStart > 1 || hunk.newStart > 1 : gap > 0 || oldGap > 0) {
        if (painted < rowCap) {
          rows.push({ kind: 'skip', oldLine: null, newLine: null, text: '' })
          painted += 1
        } else {
          fileTruncated = true
        }
      }
      let oldLine = hunk.oldStart
      let newLine = hunk.newStart
      for (const line of hunk.lines) {
        if (line.startsWith('\\')) continue
        const marker = line[0]
        if (marker === '+') {
          fileAdded += 1
          if (painted < rowCap) {
            rows.push({ kind: 'add', oldLine: null, newLine, text: line.slice(1) })
            painted += 1
          } else {
            fileTruncated = true
          }
          newLine += 1
          continue
        }
        if (marker === '-') {
          fileDeleted += 1
          if (painted < rowCap) {
            rows.push({ kind: 'del', oldLine, newLine: null, text: line.slice(1) })
            painted += 1
          } else {
            fileTruncated = true
          }
          oldLine += 1
          continue
        }
        if (painted < rowCap) {
          rows.push({ kind: 'context', oldLine, newLine, text: line.slice(1) })
          painted += 1
        } else {
          fileTruncated = true
        }
        oldLine += 1
        newLine += 1
      }
      oldEnd = oldLine
      newEnd = newLine
    }
    added += fileAdded
    deleted += fileDeleted
    if (fileTruncated) truncated = true
    files.push({
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      binary: file.binary,
      added: fileAdded,
      deleted: fileDeleted,
      rows,
      truncated: fileTruncated,
    })
  }

  return { files, added, deleted, truncated }
}

/** The file block a path selects in the diff view (rename-aware). */
export function blockForPath(model: CommitPatchModel, path: string): string | undefined {
  if (path === '') return undefined
  for (const file of model.files) {
    if (file.path === path || file.oldPath === path) return file.path
  }
  return undefined
}

/**
 * Split one commit patch into its per-file raw texts, in the SAME order
 * `buildCommitPatch` reports the files.
 *
 * Used by "copy this file's patch": the view still holds the original text, so
 * the exact bytes git produced are what lands on the clipboard — no
 * re-serialization from rows, which would drop headers a future git adds.
 */
export function splitCommitPatch(text: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current.length > 0) blocks.push(joinBlock(current))
      current = [line]
      continue
    }
    if (current.length > 0) current.push(line)
  }
  if (current.length > 0) blocks.push(joinBlock(current))
  return blocks
}

function joinBlock(lines: string[]): string {
  const text = lines.join('\n')
  return text.endsWith('\n') ? text : `${text}\n`
}

/** One directory of the 内容 tree ('' = repository root). */
export interface CommitFileGroup {
  dir: string
  files: GitCommitFile[]
}

/**
 * Group one commit's files by directory for the 内容 tree: a commit touching
 * 40 files in 6 folders is a wall of paths as a flat list, and the folder row
 * is also what lets a reader collapse the part they do not care about.
 * Root-level files come first; every level keeps git's own order by path.
 */
export function groupCommitFiles(files: readonly GitCommitFile[]): CommitFileGroup[] {
  const groups = new Map<string, GitCommitFile[]>()
  for (const file of files) {
    const slash = file.path.lastIndexOf('/')
    const dir = slash < 0 ? '' : file.path.slice(0, slash)
    const list = groups.get(dir)
    if (list === undefined) groups.set(dir, [file])
    else list.push(file)
  }
  return [...groups.entries()]
    .sort(([left], [right]) => {
      if (left === right) return 0
      if (left === '') return -1
      if (right === '') return 1
      return left.localeCompare(right)
    })
    .map(([dir, list]) => ({ dir, files: [...list].sort((a, b) => a.path.localeCompare(b.path)) }))
}

/**
 * The next path in `paths` from `current` (wrapping at both ends), the diff
 * toolbar's prev/next-file math. `current` unknown → the first/last path, so a
 * fresh pane steps into the list instead of doing nothing.
 */
export function stepPath(paths: readonly string[], current: string | undefined, direction: 1 | -1): string | undefined {
  if (paths.length === 0) return undefined
  const index = current === undefined ? -1 : paths.indexOf(current)
  if (index < 0) return direction === 1 ? paths[0] : paths[paths.length - 1]
  return paths[(index + direction + paths.length) % paths.length]
}

/**
 * Ref badge decoration for one `%D` entry (shared by the graph rows and the
 * commit card). Split for the same reason the history panel split them: the
 * CSS modifier and the display text are different jobs.
 */
export function refBadgeClass(ref: string): string {
  if (ref.startsWith('HEAD ->')) return ' head'
  if (ref.startsWith('tag:')) return ' tag'
  return ''
}

/** Display text of one `%D` entry (`HEAD -> main` → `main`, `tag: v1` → `v1`). */
export function refBadgeLabel(ref: string): string {
  if (ref.startsWith('HEAD -> ')) return ref.slice('HEAD -> '.length)
  return ref.replace(/^tag: /, '')
}
