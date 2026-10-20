/**
 * Line-level diff for the session change ledger.
 *
 * The recorder gets *content* (see `status.ts`) and needs the same thing git
 * would have printed with `-U3`: hunks a reviewer can read, counts for the file
 * list, and a patch that can undo the change. Doing it here, on the host side,
 * means a file's before/after text is compared without another round trip to
 * the remote — and without teaching git about the session baseline.
 *
 * No dependency, no IO, on purpose. The algorithm is Myers' greedy edit script
 * (the one git's own xdiff implements): common prefix and suffix are stripped
 * first, then the middle is diffed, so the cost follows the size of the edit
 * rather than the size of the file.
 *
 * Line conventions, chosen to match `git diff` byte for byte:
 *
 * - a final `\n` does not produce an extra empty line;
 * - `\r` stays inside the line, so a CRLF file keeps its `\r` and a CRLF/LF
 *   mismatch shows up as changed lines instead of a phantom whole-file edit;
 * - a file that does not end in `\n` keeps its last line, and the hunk is
 *   flagged `oldNoEol` / `newNoEol` so {@link hunkPatch} can emit git's
 *   `\ No newline at end of file` marker — without it `git apply -R` refuses to
 *   touch such a file.
 */

/** One unified-diff hunk. Line numbers are 1-based, like git's. */
export interface TextHunk {
  /** First old-side line in the hunk; 0 when the hunk only adds lines. */
  oldStart: number
  /** Number of old-side lines the hunk covers (context + removed). */
  oldLines: number
  /** First new-side line in the hunk; 0 when the hunk only removes lines. */
  newStart: number
  /** Number of new-side lines the hunk covers (context + added). */
  newLines: number
  /**
   * Lines with their leading `' '`, `'-'` or `'+'`, and without the trailing
   * `\n` — the shape the client's diff view already consumes.
   */
  lines: string[]
  /** The hunk reaches the end of `before`, which does not end in a newline. */
  oldNoEol?: true
  /** The hunk reaches the end of `after`, which does not end in a newline. */
  newNoEol?: true
}

/** A whole text comparison: hunks plus the counts the file list shows. */
export interface TextDiff {
  hunks: TextHunk[]
  /** `'+'` lines, counted from {@link hunks} so the two can never disagree. */
  added: number
  /** `'-'` lines, counted from {@link hunks}. */
  deleted: number
}

/** How far Myers may wander before the comparison degrades to "all replaced". */
const MAX_EDIT_DISTANCE = 2_000

/** One edit-script step. */
type OpKind = '=' | '-' | '+'

interface Op {
  kind: OpKind
  text: string
}

/**
 * Split text into lines the way git does: `\n` is the separator, the last one
 * does not create an empty line, and `\r` stays part of the line.
 */
function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Diff two line arrays into an edit script; `undefined` when the cap was hit. */
function editScript(before: string[], after: string[]): Op[] | undefined {
  const prefix: Op[] = []
  let start = 0
  const shortest = Math.min(before.length, after.length)
  while (start < shortest && before[start] === after[start]) {
    prefix.push({ kind: '=', text: before[start] ?? '' })
    start += 1
  }
  const suffix: Op[] = []
  let beforeEnd = before.length - 1
  let afterEnd = after.length - 1
  while (beforeEnd >= start && afterEnd >= start && before[beforeEnd] === after[afterEnd]) {
    suffix.push({ kind: '=', text: before[beforeEnd] ?? '' })
    beforeEnd -= 1
    afterEnd -= 1
  }
  suffix.reverse()
  const middle = myers(before.slice(start, beforeEnd + 1), after.slice(start, afterEnd + 1))
  if (middle === undefined) return undefined
  return [...prefix, ...middle, ...suffix]
}

/**
 * Myers' greedy algorithm with a per-level trace, so the path can be walked back.
 *
 * `trace[d]` holds the furthest x per diagonal after `d - 1` steps, which is
 * exactly what the backtrack at distance `d` reads (`prevK` is always a
 * diagonal reachable in `d - 1` steps). Only the diagonals a level touches are
 * copied, which keeps the trace at O(d²) instead of O(d · (n + m)).
 */
function myers(before: string[], after: string[]): Op[] | undefined {
  const n = before.length
  const m = after.length
  if (n === 0) return after.map(text => ({ kind: '+' as OpKind, text }))
  if (m === 0) return before.map(text => ({ kind: '-' as OpKind, text }))
  const limit = Math.min(n + m, MAX_EDIT_DISTANCE)
  const offset = limit + 2
  const furthest = new Int32Array(2 * offset + 5).fill(-1)
  // The empty edit path lives on diagonal 1 (k = x - y).
  furthest[1 + offset] = 0
  const trace: Int32Array[] = []
  let distance = -1
  for (let d = 0; d <= limit && distance < 0; d += 1) {
    // Diagonals a level-d step may read: [-(d + 1), d + 1].
    const base = -(d + 1)
    const snapshot = new Int32Array(2 * d + 3)
    for (let k = base; k <= d + 1; k += 1) snapshot[k - base] = furthest[k + offset] ?? -1
    trace.push(snapshot)
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && (furthest[k - 1 + offset] ?? -1) < (furthest[k + 1 + offset] ?? -1))) {
        x = furthest[k + 1 + offset] ?? -1
      } else {
        x = (furthest[k - 1 + offset] ?? -1) + 1
      }
      let y = x - k
      while (x < n && y < m && before[x] === after[y]) {
        x += 1
        y += 1
      }
      furthest[k + offset] = x
      if (x >= n && y >= m) {
        distance = d
        break
      }
    }
  }
  if (distance < 0) return undefined
  return backtrack(trace, before, after, distance)
}

/** Walk a completed Myers trace back into an edit script, in file order. */
function backtrack(trace: Int32Array[], before: string[], after: string[], distance: number): Op[] {
  const ops: Op[] = []
  let x = before.length
  let y = after.length
  for (let d = distance; d > 0; d -= 1) {
    const snapshot = trace[d]
    if (snapshot === undefined) break
    const base = -(d + 1)
    const at = (k: number): number => snapshot[k - base] ?? -1
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ kind: '=', text: before[x - 1] ?? '' })
      x -= 1
      y -= 1
    }
    if (x === prevX) {
      ops.push({ kind: '+', text: after[y - 1] ?? '' })
      y -= 1
    } else {
      ops.push({ kind: '-', text: before[x - 1] ?? '' })
      x -= 1
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: '=', text: before[x - 1] ?? '' })
    x -= 1
    y -= 1
  }
  while (x > 0) {
    ops.push({ kind: '-', text: before[x - 1] ?? '' })
    x -= 1
  }
  while (y > 0) {
    ops.push({ kind: '+', text: after[y - 1] ?? '' })
    y -= 1
  }
  ops.reverse()
  return ops
}

/** Compare two texts into git-shaped hunks (default 3 lines of context). */
export function diffText(before: string, after: string, context = 3): TextDiff {
  const span = Number.isFinite(context) ? Math.max(0, Math.floor(context)) : 3
  if (before === after) return { hunks: [], added: 0, deleted: 0 }
  const oldLines = splitLines(before)
  const newLines = splitLines(after)
  const beforeNoEol = before !== '' && !before.endsWith('\n')
  const afterNoEol = after !== '' && !after.endsWith('\n')
  const script = editScript(oldLines, newLines)
  // Over the cap: report the region as replaced wholesale. The patch still
  // applies, the counts are still exact, only the hunks are coarse.
  const ops = script ?? [
    ...oldLines.map(text => ({ kind: '-' as OpKind, text })),
    ...newLines.map(text => ({ kind: '+' as OpKind, text })),
  ]
  markTrailingNewline(ops, beforeNoEol, afterNoEol)
  return buildHunks(ops, span, beforeNoEol, afterNoEol)
}

/**
 * Make "this line's final newline changed" visible to the diff.
 *
 * `splitLines` drops the terminator, so a line without one is indistinguishable
 * from the same line with one — yet to git they are different lines, and it
 * prints such a pair once removed (with the marker) and once added:
 *
 * ```
 * before "a"          after "a\nb\n"      =>  -a (no eol),  +a, +b
 * before "a\nb\n"     after "a\nb"        =>   a,  -b, +b (no eol)
 * ```
 *
 * The old file's final line can only be byte-equal to a new-side line when that
 * line is the new file's final line too *and* both sides agree about the EOL, so
 * any other match against it must be broken into a removal plus an addition.
 */
function markTrailingNewline(ops: Op[], beforeNoEol: boolean, afterNoEol: boolean): void {
  if (!beforeNoEol && !afterNoEol) return
  const oldLast = lastIndexOfKind(ops, kind => kind !== '+')
  const newLast = lastIndexOfKind(ops, kind => kind !== '-')
  const oldOp = ops[oldLast]
  if (oldOp !== undefined && oldOp.kind === '=' && beforeNoEol && !(oldLast === newLast && afterNoEol)) {
    ops.splice(oldLast, 1, { kind: '-', text: oldOp.text }, { kind: '+', text: oldOp.text })
    return
  }
  const newOp = ops[newLast]
  if (newOp !== undefined && newOp.kind === '=' && afterNoEol && !(newLast === oldLast && beforeNoEol)) {
    ops.splice(newLast, 1, { kind: '-', text: newOp.text }, { kind: '+', text: newOp.text })
  }
}

/** Group an edit script into hunks of `context` lines around each change. */
function buildHunks(ops: Op[], context: number, beforeNoEol: boolean, afterNoEol: boolean): TextDiff {
  /** Old-side line number just before op `i`. */
  const oldBefore = new Array<number>(ops.length + 1).fill(0)
  /** New-side line number just before op `i`. */
  const newBefore = new Array<number>(ops.length + 1).fill(0)
  let oldCount = 0
  let newCount = 0
  for (let index = 0; index < ops.length; index += 1) {
    oldBefore[index] = oldCount
    newBefore[index] = newCount
    const kind = ops[index]?.kind
    if (kind !== '+') oldCount += 1
    if (kind !== '-') newCount += 1
  }
  oldBefore[ops.length] = oldCount
  newBefore[ops.length] = newCount

  const changes: number[] = []
  for (let index = 0; index < ops.length; index += 1) {
    if (ops[index]?.kind !== '=') changes.push(index)
  }
  if (changes.length === 0) return { hunks: [], added: 0, deleted: 0 }

  // Two change runs join when the unchanged gap between them is short enough for
  // their context to touch: git splits once the gap exceeds 2 × context.
  const groups: Array<[number, number]> = []
  let groupStart = changes[0] ?? 0
  let groupEnd = groupStart
  for (let index = 1; index < changes.length; index += 1) {
    const next = changes[index] ?? groupEnd
    if (next - groupEnd - 1 <= 2 * context) {
      groupEnd = next
      continue
    }
    groups.push([groupStart, groupEnd])
    groupStart = next
    groupEnd = next
  }
  groups.push([groupStart, groupEnd])

  // Which hunk owns the files' final line on each side, for the no-newline marker.
  const lastOldOp = lastIndexOfKind(ops, kind => kind !== '+')
  const lastNewOp = lastIndexOfKind(ops, kind => kind !== '-')

  const hunks: TextHunk[] = []
  let added = 0
  let deleted = 0
  for (const [from, to] of groups) {
    const start = Math.max(0, from - context)
    const end = Math.min(ops.length - 1, to + context)
    const oldStartIndex = oldBefore[start] ?? 0
    const newStartIndex = newBefore[start] ?? 0
    const oldLines = (oldBefore[end + 1] ?? 0) - oldStartIndex
    const newLines = (newBefore[end + 1] ?? 0) - newStartIndex
    const lines: string[] = []
    for (let index = start; index <= end; index += 1) {
      const op = ops[index]
      if (op === undefined) continue
      lines.push((op.kind === '=' ? ' ' : op.kind) + op.text)
      if (op.kind === '+') added += 1
      if (op.kind === '-') deleted += 1
    }
    const hunk: TextHunk = {
      // Git's convention: a side with no lines names the line *before* the hunk.
      oldStart: oldLines === 0 ? oldStartIndex : oldStartIndex + 1,
      oldLines,
      newStart: newLines === 0 ? newStartIndex : newStartIndex + 1,
      newLines,
      lines,
    }
    // The marker belongs to the hunk that actually contains the file's last
    // line on that side — with `context: 0` an earlier hunk may stop short of it.
    if (beforeNoEol && lastOldOp >= start && lastOldOp <= end) hunk.oldNoEol = true
    if (afterNoEol && lastNewOp >= start && lastNewOp <= end) hunk.newNoEol = true
    hunks.push(hunk)
  }
  return { hunks, added, deleted }
}

/** Index of the last op satisfying `predicate`, or -1. */
function lastIndexOfKind(ops: Op[], predicate: (kind: OpKind) => boolean): number {
  for (let index = ops.length - 1; index >= 0; index -= 1) {
    const kind = ops[index]?.kind
    if (kind !== undefined && predicate(kind)) return index
  }
  return -1
}

/**
 * Serialize one hunk as a patch `git apply` accepts (and `git apply -R` undoes).
 *
 * The `@@ -a,b +c,d @@` counts are always written out — git accepts the elided
 * `,1` and `,-0` spellings, but a reviewer reading a log is better served by the
 * explicit form, and one spelling means one code path to test.
 *
 * @param displayPath - repo-relative path, as the panel shows it.
 * @param hunk - one hunk of {@link diffText}.
 */
export function hunkPatch(displayPath: string, hunk: TextHunk): string {
  const out: string[] = [
    `--- a/${displayPath}`,
    `+++ b/${displayPath}`,
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
  ]
  // The marker follows the last line of the side that lacks a final newline; a
  // context line that ends both sides gets exactly one marker.
  const markers = new Set<number>()
  if (hunk.oldNoEol === true) {
    const at = lastLineOfSide(hunk.lines, '-')
    if (at >= 0) markers.add(at)
  }
  if (hunk.newNoEol === true) {
    const at = lastLineOfSide(hunk.lines, '+')
    if (at >= 0) markers.add(at)
  }
  for (let index = 0; index < hunk.lines.length; index += 1) {
    out.push(hunk.lines[index] ?? '')
    if (markers.has(index)) out.push('\\ No newline at end of file')
  }
  return `${out.join('\n')}\n`
}

/**
 * Index of the last line in `lines` that belongs to the old side (`tag` is `'-'`)
 * or the new side (`tag` is `'+'`); context lines belong to both.
 */
function lastLineOfSide(lines: string[], tag: '-' | '+'): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const head = lines[index]?.charAt(0)
    if (head === ' ' || head === tag) return index
  }
  return -1
}
