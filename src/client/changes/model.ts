/**
 * Turn a file's unified diff into what the editor needs to draw it.
 *
 * The recorder speaks git (`UnifiedHunk`: `@@` headers plus raw ` `/`+`/`-`
 * lines); the editor speaks line ranges (`ChangeMark`). This module is the one
 * place that translates, and it is deliberately pure so the mapping can be
 * asserted without a browser.
 *
 * Two kinds of information come out:
 * - `marks`: line ranges to paint (add / modified / deleted-anchor).
 * - `hunks`: one entry per diff hunk, the line to jump to for "next change".
 */

import type { UnifiedHunk } from '../../protocol.ts'
// One definition of the editor's mark vocabulary: the CodeMirror module owns
// it, this module only produces it. A type-only import keeps this file free of
// a CodeMirror runtime dependency, which is what lets the pure checks run it
// under plain Node.
import type { ChangeMark, ChangeSet } from '../vsc/change-marks.ts'

export type { ChangeMark, ChangeSet }

/** An empty set (a file that ended up unchanged). */
export const EMPTY_CHANGE_SET: ChangeSet = { marks: [], hunks: [], stamp: 'empty' }

/**
 * Walk one hunk and emit its marks.
 *
 * Deletions have no line of their own in the new file, so they anchor on the
 * line where they were removed — the same convention the editor's gutter uses
 * when it paints a "−" beside the surviving line.
 *
 * @param hunk - one served hunk.
 * @param marks - destination list (mutated).
 * @returns the hunk's first jumpable line, or undefined when it paints nothing.
 */
function collectHunk(hunk: UnifiedHunk, marks: ChangeMark[]): number | undefined {
  let line = hunk.newStart
  let first: number | undefined
  // A run of consecutive +/- lines is one block: a block with both signs is a
  // modification, a block with only additions is an insertion, and a block with
  // only deletions is a removal anchored where it used to be.
  let added: number[] = []
  let deleted = false

  const flush = (): void => {
    if (added.length > 0) {
      const from = added[0]
      const to = added[added.length - 1]
      marks.push({ from, to, kind: deleted ? 'mod' : 'add' })
      first ??= from
    } else if (deleted) {
      const anchor = Math.max(1, line)
      marks.push({ from: anchor, to: anchor, kind: 'del' })
      first ??= anchor
    }
    added = []
    deleted = false
  }

  for (const raw of hunk.lines) {
    const sign = raw[0]
    if (sign === '+') {
      added.push(line)
      line += 1
      continue
    }
    if (sign === '-') {
      deleted = true
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
 * @returns the mark set the editor paints, or {@link EMPTY_CHANGE_SET}.
 */
export function changeSetFromHunks(hunks: readonly UnifiedHunk[], stamp: string): ChangeSet {
  if (hunks.length === 0) return { marks: [], hunks: [], stamp }
  const marks: ChangeMark[] = []
  const anchors: number[] = []
  for (const hunk of hunks) {
    const first = collectHunk(hunk, marks)
    if (first !== undefined) anchors.push(first)
  }
  marks.sort((left, right) => left.from - right.from)
  anchors.sort((left, right) => left - right)
  // A hunk pair can collapse onto the same anchor line; the jump list only
  // needs each line once.
  return { marks, hunks: [...new Set(anchors)], stamp }
}
