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
import type { UnifiedHunk } from '../../protocol.ts';
import type { ChangeMark, ChangeSet, InlineRange, RemovedChip } from '../vsc/change-marks.ts';
export type { ChangeMark, ChangeSet, InlineRange, RemovedChip };
/** An empty set (a file that ended up unchanged). */
export declare const EMPTY_CHANGE_SET: ChangeSet;
/**
 * Build the editable set for one file.
 *
 * @param hunks - served hunks for the whole session.
 * @param stamp - identity of the comparison (file + baseline + turn).
 * @returns the mark set the editor paints, or {@link EMPTY_CHANGE_SET}.
 */
export declare function changeSetFromHunks(hunks: readonly UnifiedHunk[], stamp: string): ChangeSet;
