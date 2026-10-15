/**
 * Pure diff model: turns one `git diff` plus both file revisions into the
 * side-by-side rows the diff view renders.
 *
 * The pairing comes from git, not from a browser-side diff algorithm: the
 * unified diff says which old line maps to which new line, and this module
 * re-projects that pairing onto the two FULL files, so the view shows the
 * whole file with unchanged context and real line numbers on both sides
 * (the same model the reference implementation uses). Every row also carries
 * its hunk index, which is what makes per-hunk stage / revert possible.
 */
import { parseUnifiedDiff } from '../../git-ops.ts'
import type { DiffHunkView, DiffModel, DiffRow } from '../../protocol.ts'

/** One `@@`-parsed line pair, before projection onto the full files. */
interface Pair {
  old: string
  new: string
  oldNum: number | null
  newNum: number | null
}

/** Split a document into lines, dropping the trailing empty element. */
function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Parse the unified diff body into old/new line pairs (git's pairing). */
export function parsePairs(diff: string): Pair[] {
  const pairs: Pair[] = []
  let oldLine = 0
  let newLine = 0
  for (const line of diff.split('\n')) {
    if (
      line.startsWith('diff ')
      || line.startsWith('index ')
      || line.startsWith('--- ')
      || line.startsWith('+++ ')
      || line.startsWith('new file mode')
      || line.startsWith('deleted file mode')
      || line.startsWith('old mode')
      || line.startsWith('new mode')
      || line.startsWith('similarity index')
      || line.startsWith('rename from')
      || line.startsWith('rename to')
      || line.startsWith('copy from')
      || line.startsWith('copy to')
      || line.startsWith('\\')
    ) continue
    if (line.startsWith('@@')) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (match !== null) {
        oldLine = Number(match[1])
        newLine = Number(match[2])
      }
      continue
    }
    if (line.startsWith('+')) {
      pairs.push({ old: '', new: line.slice(1), oldNum: null, newNum: newLine++ })
      continue
    }
    if (line.startsWith('-')) {
      pairs.push({ old: line.slice(1), new: '', oldNum: oldLine++, newNum: null })
      continue
    }
    if (line.startsWith(' ')) {
      pairs.push({ old: line.slice(1), new: line.slice(1), oldNum: oldLine++, newNum: newLine++ })
    }
  }
  return pairs
}

export interface DiffInput {
  /** The unified diff text (`git diff ... -- <path>`). */
  diff: string
  /** Left side (HEAD or index blob; '' for a new file). */
  oldText: string
  /** Right side (index blob or worktree; '' for a deleted file). */
  newText: string
}

/**
 * Build the render model. `rows` always covers both files completely, so a
 * one-line change in a 3000-line file still renders 3000 aligned rows.
 */
export function buildDiffModel(input: DiffInput): DiffModel {
  const files = parseUnifiedDiff(input.diff)
  const file = files[0]
  const binary = file?.binary === true || /^Binary files .* differ$/m.test(input.diff)
  if (binary) return { rows: [], hunks: [], binary: true, empty: false }

  const pairs = parsePairs(input.diff)
  const oldLines = splitLines(input.oldText)
  const newLines = splitLines(input.newText)

  const oldToNew = new Map<number, number | null>()
  for (const pair of pairs) {
    if (pair.oldNum !== null) oldToNew.set(pair.oldNum, pair.newNum)
  }

  const rows: DiffRow[] = []
  let id = 0
  let j = 1
  const push = (row: Omit<DiffRow, 'id' | 'hunk'>): void => {
    rows.push({ ...row, id: id++, hunk: -1 })
  }

  for (let i = 1; i <= oldLines.length; i++) {
    const oldText = oldLines[i - 1] as string
    const paired = oldToNew.has(i) ? oldToNew.get(i) : undefined
    if (paired === null) {
      // Deleted line: exists only on the left.
      push({ old: oldText, new: '', oldNum: i, newNum: null, inNew: false, oldDel: true, newAdd: false })
      continue
    }
    if (paired !== undefined) {
      // Pure insertions that sit before this anchor line.
      while (j < paired) {
        push({ old: '', new: newLines[j - 1] as string, oldNum: null, newNum: j, inNew: true, oldDel: false, newAdd: true })
        j += 1
      }
      const newText = newLines[paired - 1] as string
      const changed = oldText.replace(/\r$/, '') !== newText.replace(/\r$/, '')
      push({
        old: oldText,
        new: newText,
        oldNum: i,
        newNum: paired,
        inNew: true,
        oldDel: changed,
        newAdd: changed,
      })
      j = paired + 1
      continue
    }
    // A line git did not mention at all: align it positionally.
    const nextNew = j <= newLines.length ? (newLines[j - 1] as string) : ''
    const hasNew = j <= newLines.length
    const changed = hasNew && oldText.replace(/\r$/, '') !== nextNew.replace(/\r$/, '')
    push({
      old: oldText,
      new: nextNew,
      oldNum: i,
      newNum: hasNew ? j : null,
      inNew: hasNew,
      oldDel: changed,
      newAdd: changed,
    })
    if (hasNew) j += 1
  }
  while (j <= newLines.length) {
    push({ old: '', new: newLines[j - 1] as string, oldNum: null, newNum: j, inNew: true, oldDel: false, newAdd: true })
    j += 1
  }

  // Hunk attribution by line-number range (context rows belong to a hunk too).
  const hunks: DiffHunkView[] = []
  for (const [index, hunk] of (file?.hunks ?? []).entries()) {
    hunks.push({
      index,
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      oldCount: hunk.oldCount,
      newCount: hunk.newCount,
      heading: hunk.heading,
      startRow: -1,
      patch: hunk.patch,
    })
  }
  const hunkOf = (oldNum: number | null, newNum: number | null): number => {
    for (const hunk of hunks) {
      if (oldNum !== null && oldNum >= hunk.oldStart && oldNum < hunk.oldStart + hunk.oldCount) return hunk.index
      if (newNum !== null && newNum >= hunk.newStart && newNum < hunk.newStart + hunk.newCount) return hunk.index
    }
    return -1
  }
  for (const row of rows) {
    row.hunk = hunkOf(row.oldNum, row.newNum)
    if (row.hunk < 0) continue
    const hunk = hunks[row.hunk]
    if (hunk !== undefined && hunk.startRow < 0 && (row.oldDel || row.newAdd)) hunk.startRow = row.id
  }
  for (const hunk of hunks) {
    if (hunk.startRow < 0) {
      const row = rows.find(r => r.hunk === hunk.index)
      hunk.startRow = row?.id ?? 0
    }
  }

  const empty = rows.every(row => !row.oldDel && !row.newAdd)
  return { rows, hunks, binary: false, empty }
}

/** Added / removed line counts for the diff toolbar. */
export function diffCounts(model: DiffModel): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const row of model.rows) {
    if (row.newAdd) added += 1
    if (row.oldDel) removed += 1
  }
  return { added, removed }
}
