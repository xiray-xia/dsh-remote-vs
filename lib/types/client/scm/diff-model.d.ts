import type { DiffModel } from '../../protocol.ts';
/** One `@@`-parsed line pair, before projection onto the full files. */
interface Pair {
    old: string;
    new: string;
    oldNum: number | null;
    newNum: number | null;
}
/**
 * Parse the unified diff body into old/new line pairs (git's pairing).
 *
 * CONTEXT IS THE WHOLE POINT: a deleted SQL/Lua/Haskell comment line (`-- note`)
 * arrives as `--- note`, and an inserted C line `++ i;` arrives as `+++ i;` —
 * so a flat "skip anything starting with `--- ` / `+++ `" rule silently eats
 * real content lines. That dropped the line from the pairing, stopped the line
 * counters from advancing, and every row after it shifted: the deleted comment
 * was painted as a MODIFIED line, the rest of the file was flagged changed and
 * the `+/−` totals were wrong (measured on the shipped module before this fix).
 *
 * So the scan is not flat: it walks the hunk structure `parseUnifiedDiff`
 * already produced (`git-ops.ts`, the same context-aware parser the commit pane
 * trusts), where a line is content exactly when a hunk is open. File-block
 * headers can only appear BEFORE a hunk starts, which is why the ambiguity
 * disappears instead of being guessed at.
 */
export declare function parsePairs(diff: string): Pair[];
export interface DiffInput {
    /** The unified diff text (`git diff ... -- <path>`). */
    diff: string;
    /** Left side (HEAD or index blob; '' for a new file). */
    oldText: string;
    /** Right side (index blob or worktree; '' for a deleted file). */
    newText: string;
}
/**
 * Build the render model. `rows` always covers both files completely, so a
 * one-line change in a 3000-line file still renders 3000 aligned rows.
 */
export declare function buildDiffModel(input: DiffInput): DiffModel;
/** Added / removed line counts for the diff toolbar. */
export declare function diffCounts(model: DiffModel): {
    added: number;
    removed: number;
};
/**
 * Where a prev/next jump lands, as an index into the ordered hunk list.
 *
 * Wraps at both ends (the last change's "next" is the first change, and the
 * first one's "previous" is the last), because a diff toolbar button that does
 * nothing at the end reads as broken. `cursor < 0` means "nothing jumped yet":
 * the first `next` lands on the first hunk and the first `previous` on the last.
 *
 * Pure, so `scripts/check-diff-ui.mjs` can pin the wrapping without a browser.
 *
 * @param count - how many hunks the model has (0 → -1, i.e. nothing to jump to).
 * @param cursor - the hunk the toolbar currently reports, or -1.
 * @param direction - 1 for "next change", -1 for "previous change".
 * @returns the hunk index to scroll to, or -1 when the model has no hunks.
 */
export declare function stepHunk(count: number, cursor: number, direction: 1 | -1): number;
/**
 * The hunk the viewport is sitting in, derived from the top visible row.
 *
 * "Sitting in" = the last change whose first row is at or ABOVE the top row, so
 * scrolling into the middle of a change keeps reporting that change (and
 * scrolling above the first one reports -1). This is what keeps the toolbar's
 * `n / N` honest when the user scrolls by hand instead of using the buttons —
 * the jump math alone would report the last button press, not the screen.
 *
 * @param startRows - first row index of each hunk, ASCENDING.
 * @param topRow - the row index at the top of the viewport (may be fractional).
 * @returns the hunk index, or -1 when the viewport is above the first hunk.
 */
export declare function hunkAtRow(startRows: readonly number[], topRow: number): number;
export {};
