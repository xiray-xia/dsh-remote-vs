/**
 * Turn a file's unified diff into what the editor needs to draw it.
 *
 * The recorder speaks git (`UnifiedHunk`: `@@` headers plus raw ` `/`+`/`-`
 * lines); the editor speaks line ranges (`ChangeMark`). This module is the one
 * place that translates, and it is deliberately pure so the mapping can be
 * asserted without a browser.
 *
 * Two kinds of information come out:
 * - `marks`: line ranges to paint (add / modified / deleted-anchor). A modified
 *   range may also carry the **inline** detail — which characters of a line
 *   actually changed (`mark.inline`) and which ones disappeared from it
 *   (`mark.removed`). "This whole line is blue" cannot answer "what did this
 *   edit do" for a one-word change, which is what the inline half is for.
 * - `hunks`: one entry per diff hunk, the line to jump to for "next change".
 *
 * The inline half is a **bounded heuristic**, not a diff library: pairs are
 * matched by position, the common prefix/suffix of a pair is stripped first
 * (that alone covers most real edits) and only what is left goes through a
 * character LCS. Every step has a cap (see the `MAX_*` constants below): a
 * pathological file must end up with a coarser highlight, never with a frozen
 * editor. Nothing here imports CodeMirror — the checks run it under plain Node.
 */

import type { UnifiedHunk } from '../../protocol.ts'
// One definition of the editor's mark vocabulary: the CodeMirror module owns
// it, this module only produces it. A type-only import keeps this file free of
// a CodeMirror runtime dependency, which is what lets the pure checks run it
// under plain Node.
import type { ChangeMark, ChangeSet, InlineRange, RemovedChip } from '../vsc/change-marks.ts'

export type { ChangeMark, ChangeSet, InlineRange, RemovedChip }

/** An empty set (a file that ended up unchanged). */
export const EMPTY_CHANGE_SET: ChangeSet = { marks: [], hunks: [], stamp: 'empty' }

/**
 * 行内计算的上限。四条都是"宁可少画，不可卡死"：
 *
 * - `MAX_INLINE_LINE`：单行超过这么长就不做字符级比较（压缩过的 bundle、base64
 *   常量都是这种行，LCS 的收益为零而代价是平方级的）。整行标记照旧。
 * - `MAX_PAIRS_PER_HUNK`：一个 hunk 里配对数超过这么多就整块跳过行内计算（生成
 *   代码被整体重排时，逐行 LCS 只会产出一屏噪声）。
 * - `MAX_REFINE_CHARS`：剥掉前后缀后两个中段的**长度之和**超过这么多，就不做
 *   LCS 求精，整个中段算一个区间。
 * - `MAX_CHIP_CHARS`：删除 chip 的文本上限，超出部分截掉（`truncated` 标记它）。
 */
const MAX_INLINE_LINE = 2000
const MAX_PAIRS_PER_HUNK = 200
const MAX_REFINE_CHARS = 200
const MAX_CHIP_CHARS = 60

/**
 * LCS 里连续匹配短于这么长就不算"这段没变"。
 *
 * 字符级 LCS 会把巧合的单字符当成未改动：`value` → `result` 的 LCS 里有 `u`、`l`
 * 两个孤立匹配，照它上色就得到 `res[ul]t` 这种"中间两个字没变"的假象 —— 恰好毁掉
 * 这个功能最该服务的场景（改了一个词）。所以只有成串的匹配才算未改动。
 */
const MIN_MATCH_RUN = 2

/** One added line of a block: its 1-based number and its text (leading `+` gone). */
interface AddedLine {
  line: number
  text: string
}

/** How many lines of this hunk carry `sign` (an upper bound on the pair count). */
function countSigned(hunk: UnifiedHunk, sign: string): number {
  let count = 0
  for (const raw of hunk.lines) if (raw[0] === sign) count += 1
  return count
}

/**
 * Strip the common prefix/suffix of a pair, leaving the two middles.
 *
 * @param before - the deleted line's text.
 * @param after - the added line's text.
 * @returns the middles plus `head`, the column at which they start in the line.
 */
function splitCommon(before: string, after: string): { head: number; oldMid: string; newMid: string } {
  const shortest = Math.min(before.length, after.length)
  let head = 0
  while (head < shortest && before[head] === after[head]) head += 1
  // The suffix may not eat into the prefix: in `aaa` → `aa` the prefix already
  // consumed the whole shorter line, and a suffix on top of it would produce a
  // negative middle.
  let tail = 0
  while (tail < shortest - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1
  return {
    head,
    oldMid: before.slice(head, before.length - tail),
    newMid: after.slice(head, after.length - tail),
  }
}

/**
 * Character LCS refinement: which columns of `after` really changed.
 *
 * @param before - the deleted middle (non-empty, length already capped).
 * @param after - the added middle (non-empty, length already capped).
 * @param offset - where the middles start in the line, added to every column.
 * @returns one range per run of changed columns, ascending, non-empty.
 */
function refineRanges(before: string, after: string, offset: number): InlineRange[] {
  const rows = before.length
  const columns = after.length
  // `table[i][j]` = length of the LCS of `before.slice(i)` and `after.slice(j)`.
  // The caller has capped `rows + columns`, so this table stays small.
  const table: number[][] = []
  for (let i = rows; i >= 0; i -= 1) {
    const row = new Array<number>(columns + 1).fill(0)
    table[i] = row
    if (i === rows) continue
    const next = table[i + 1]
    for (let j = columns - 1; j >= 0; j -= 1) {
      row[j] = before[i] === after[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1])
    }
  }
  // Walk the table to get one longest common subsequence (both indices strictly
  // increase), then keep only its runs of length >= MIN_MATCH_RUN.
  const kept: boolean[] = new Array<boolean>(columns).fill(false)
  let runStart = -1
  let runLength = 0
  const closeRun = (): void => {
    if (runLength >= MIN_MATCH_RUN) {
      for (let index = runStart; index < runStart + runLength; index += 1) kept[index] = true
    }
    runStart = -1
    runLength = 0
  }
  let i = 0
  let j = 0
  while (i < rows && j < columns) {
    if (before[i] === after[j]) {
      if (runLength === 0) runStart = j
      runLength += 1
      i += 1
      j += 1
      continue
    }
    closeRun()
    if (table[i + 1][j] >= table[i][j + 1]) i += 1
    else j += 1
  }
  closeRun()
  const ranges: InlineRange[] = []
  let start = -1
  for (let index = 0; index <= columns; index += 1) {
    const changed = index < columns && !kept[index]
    if (changed && start < 0) start = index
    else if (!changed && start >= 0) {
      ranges.push({ from: offset + start, to: offset + index })
      start = -1
    }
  }
  return ranges
}

/** A removed chip for `text` at column `at`, or undefined when there is nothing to show. */
function chipAt(at: number, text: string): RemovedChip | undefined {
  if (text === '') return undefined
  const truncated = text.length > MAX_CHIP_CHARS
  return { at, text: truncated ? text.slice(0, MAX_CHIP_CHARS) : text, truncated }
}

/**
 * How many lines of a collapsed deletion block travel as the tooltip preview.
 *
 * The pill only shows the COUNT, so the text is not on screen; it is still worth
 * carrying a bounded prefix for the hover — enough to recognize the block, never
 * enough to build a thousand-line title from a thousand-line removal.
 */
const MAX_BLOCK_PREVIEW_LINES = 20

/**
 * One chip for a run of deleted lines.
 *
 * A block deletion used to emit one chip PER line, every one of them at column 0
 * of the same anchor line: a ten-line removal became ten struck-through
 * fragments printed on top of each other, which says neither "ten lines" nor
 * what they were. A run longer than a single line now collapses into one chip
 * carrying the count (rendered as `−N 行已删除`) with a bounded preview in its
 * title; a one-line removal keeps the exact text at the cut, which is the case
 * where the struck-through words are genuinely readable.
 *
 * @param deleted - the run's deleted texts, in order.
 * @param line - the line the run belongs to.
 * @param anchor - the mark's anchor line (see {@link chipOnLine}).
 */
function deletedRunChip(deleted: readonly string[], line: number, anchor: number): RemovedChip | undefined {
  const [only] = deleted
  if (only === undefined) return undefined
  if (deleted.length === 1) {
    const chip = chipAt(0, only)
    return chip === undefined ? undefined : chipOnLine(chip, line, anchor)
  }
  const preview = deleted
    .slice(0, MAX_BLOCK_PREVIEW_LINES)
    .map(text => (text.length > MAX_CHIP_CHARS ? text.slice(0, MAX_CHIP_CHARS) : text))
    .join('\n')
  return chipOnLine(
    {
      at: 0,
      text: preview,
      // The preview was cut either by the line cap or by the line count.
      truncated: deleted.length > MAX_BLOCK_PREVIEW_LINES || deleted.some(text => text.length > MAX_CHIP_CHARS),
      count: deleted.length,
    },
    line,
    anchor,
  )
}

/**
 * Attach `line` only when the fragment is NOT on the mark's anchor line.
 *
 * Single-line changes are the common case, and there the fragment's line is
 * simply the mark's own line — writing it out would repeat the mark on every
 * entry. Multi-line blocks (a modified block is one mark spanning every added
 * line) do need it, because the mark alone cannot say which of its lines a
 * fragment belongs to.
 */
function rangeOnLine(range: InlineRange, line: number, anchor: number): InlineRange {
  return line === anchor ? range : { ...range, line }
}

/** {@link rangeOnLine} for a chip. */
function chipOnLine(chip: RemovedChip, line: number, anchor: number): RemovedChip {
  return line === anchor ? chip : { ...chip, line }
}

/**
 * Do these lines allow a character-level comparison at all?
 *
 * Both caps that are per line rather than per hunk live here.
 */
function shortEnough(deleted: readonly string[], added: readonly AddedLine[]): boolean {
  return deleted.every(text => text.length <= MAX_INLINE_LINE)
    && added.every(item => item.text.length <= MAX_INLINE_LINE)
}

/**
 * Fill in `mark.inline` / `mark.removed` for one modified block.
 *
 * Pairing happens in two phases, and the first one is what keeps the highlight
 * honest:
 *
 * 1. **Exact matches are consumed first, at any index.** A block that was merely
 *    REORDERED (`a`,`b` → `b`,`a`) has no character-level change in it, but
 *    positional pairing compares `a` against `b` and paints "these characters
 *    changed" on two lines that did not change at all. The same phase fixes the
 *    common "one line inserted inside an edited run" shape, where every line
 *    after the insertion used to be paired with the wrong neighbour. Lookup goes
 *    through a text → indices map, so the phase stays linear in the block rather
 *    than quadratic in its lines.
 * 2. **What is left pairs by position** — the i-th edited deletion with the i-th
 *    remaining addition. git puts every deletion of a block before its
 *    additions, and a block with unequal counts leaves the extras as pure
 *    additions/removals.
 *
 * @param mark - the block's mark (mutated).
 * @param deleted - the block's deleted texts, in order.
 * @param added - the block's added lines, in order.
 */
function attachInline(mark: ChangeMark, deleted: readonly string[], added: readonly AddedLine[]): void {
  // Phase 1 — consume lines that did not change, only moved.
  const pending = new Map<string, number[]>()
  added.forEach((item, index) => {
    const list = pending.get(item.text)
    if (list === undefined) pending.set(item.text, [index])
    else list.push(index)
  })
  const edited: string[] = []
  const used = new Array<boolean>(added.length).fill(false)
  for (const text of deleted) {
    const list = pending.get(text)
    if (list === undefined || list.length === 0) {
      edited.push(text)
      continue
    }
    const index = list.shift()
    if (index !== undefined) used[index] = true
  }
  const fresh = added.filter((_item, index) => !used[index])

  // Phase 2 — positional pairing over the survivors.
  const pairs = Math.min(edited.length, fresh.length)
  const inline: InlineRange[] = []
  const removed: RemovedChip[] = []
  for (let index = 0; index < pairs; index += 1) {
    const before = edited[index]
    const item = fresh[index]
    if (before === undefined || item === undefined) continue
    const after = item.text
    const line = item.line
    const { head, oldMid, newMid } = splitCommon(before, after)
    if (newMid.length === 0) {
      // The line was only shortened: there is no new character to paint, so the
      // removed text becomes a chip sitting exactly at the cut.
      const chip = chipAt(head, oldMid)
      if (chip !== undefined) removed.push(chipOnLine(chip, line, mark.from))
      continue
    }
    if (oldMid.length === 0 || oldMid.length + newMid.length > MAX_REFINE_CHARS) {
      // Pure insertion inside the line, or a middle too long to refine: the
      // whole middle counts as one range.
      inline.push(rangeOnLine({ from: head, to: head + newMid.length }, line, mark.from))
      continue
    }
    for (const range of refineRanges(oldMid, newMid, head)) inline.push(rangeOnLine(range, line, mark.from))
  }
  // Deleted lines with no added counterpart: their text no longer exists in the
  // new file, so it hangs on the anchor line's first column — as one collapsed
  // chip when the run is longer than a line (see `deletedRunChip`).
  const tailChip = deletedRunChip(edited.slice(pairs), mark.from, mark.from)
  if (tailChip !== undefined) removed.push(tailChip)
  if (inline.length > 0) mark.inline = inline
  if (removed.length > 0) mark.removed = removed
}

/**
 * Walk one hunk and emit its marks.
 *
 * Deletions have no line of their own in the new file, so they anchor on the
 * line where they were removed — the same convention the editor's gutter uses
 * when it paints a "−" beside the surviving line.
 *
 * @param hunk - one served hunk.
 * @param marks - destination list (mutated).
 * @param index - this hunk's position in the served list (stamped onto每块).
 * @returns the hunk's first jumpable line, or undefined when it paints nothing.
 */
function collectHunk(hunk: UnifiedHunk, marks: ChangeMark[], index: number): number | undefined {
  let line = hunk.newStart
  let first: number | undefined
  // A run of consecutive +/- lines is one block: a block with both signs is a
  // modification, a block with only additions is an insertion, and a block with
  // only deletions is a removal anchored where it used to be.
  let added: AddedLine[] = []
  let deleted: string[] = []
  // Per-hunk cap: too many pairs and the whole hunk keeps line-level marks only.
  const inlineAllowed = Math.min(countSigned(hunk, '+'), countSigned(hunk, '-')) <= MAX_PAIRS_PER_HUNK

  const flush = (): void => {
    if (added.length > 0) {
      const from = added[0].line
      const to = added[added.length - 1].line
      const kind = deleted.length > 0 ? 'mod' : 'add'
      const mark: ChangeMark = { from, to, kind, hunk: index }
      // A pure insertion is skipped on purpose: every character of those lines
      // is new, which the line background already says — painting the whole line
      // again would only make it a darker green than its neighbours.
      if (deleted.length > 0 && inlineAllowed && shortEnough(deleted, added)) {
        attachInline(mark, deleted, added)
      }
      marks.push(mark)
      first ??= from
    } else if (deleted.length > 0) {
      const anchor = Math.max(1, line)
      const mark: ChangeMark = { from: anchor, to: anchor, kind: 'del', hunk: index }
      // A collapsed block pill carries a bounded preview only, so the per-line
      // length cap (which exists to keep character-level work bounded) does not
      // apply to it; a single deleted line still has to fit before its text is
      // put on screen.
      const printable = deleted.length > 1 || deleted.every(text => text.length <= MAX_INLINE_LINE)
      if (inlineAllowed && printable) {
        const chip = deletedRunChip(deleted, anchor, anchor)
        if (chip !== undefined) mark.removed = [chip]
      }
      marks.push(mark)
      first ??= anchor
    }
    added = []
    deleted = []
  }

  for (const raw of hunk.lines) {
    const sign = raw[0]
    if (sign === '+') {
      added.push({ line, text: raw.slice(1) })
      line += 1
      continue
    }
    if (sign === '-') {
      deleted.push(raw.slice(1))
      continue
    }
    // Context (or the "\ No newline at end of file" marker) closes the block.
    flush()
    if (sign === ' ' || raw === '') line += 1
  }
  flush()
  return first
}

/**
 * Build the editable set for one file.
 *
 * @param hunks - served hunks for the whole session.
 * @param stamp - identity of the comparison (file + baseline + turn).
 * @param filePatch - the host's whole-file reverse patch, when it served one
 *   (see `ChangeSet.filePatch`); '' / missing = nothing to revert as a whole.
 * @returns the mark set the editor paints, or {@link EMPTY_CHANGE_SET}.
 */
export function changeSetFromHunks(hunks: readonly UnifiedHunk[], stamp: string, filePatch?: string): ChangeSet {
  if (hunks.length === 0) return { marks: [], hunks: [], stamp, patches: [] }
  const marks: ChangeMark[] = []
  // `hunks[i]` / `patches[i]` must stay in step with the mark's `hunk` index, so
  // order is preserved: `hunks` is the jump order (ascending line), while
  // `patches` keeps the served order the marks point into.
  const anchors: { line: number; served: number }[] = []
  const patches: string[] = []
  hunks.forEach((hunk, served) => {
    patches.push(hunk.patch)
    const first = collectHunk(hunk, marks, served)
    if (first !== undefined) anchors.push({ line: first, served })
  })
  marks.sort((left, right) => left.from - right.from)
  // Jump order is ascending by line; the mark's `hunk` is a key into `patches`,
  // never into this list — that indirection is what keeps both orderings right.
  const order = [...anchors].sort((left, right) => left.line - right.line)
  return {
    marks,
    hunks: [...new Set(order.map(anchor => anchor.line))],
    stamp,
    patches,
    ...(filePatch === undefined || filePatch === '' ? {} : { filePatch }),
  }
}
