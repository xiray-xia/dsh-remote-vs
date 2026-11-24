/**
 * Side-by-side diff: full file on both sides, real line numbers, added /
 * removed tinting and per-hunk stage / revert.
 *
 * The pairing comes from git (see `scm/diff-model`), so the two panes are
 * always aligned row for row. Hunk buttons are only rendered where a patch
 * can legally be applied: a worktree diff can be staged or reverted, an
 * already-staged diff can only be un-staged. 变更后 switches to a real
 * CodeMirror buffer so the file can be edited in place.
 *
 * The row count is the WHOLE file, so every pane is windowed (see
 * `useScrollWindow`): before that, a 3000-line file put 9000 line containers and
 * ~2N tokenized lines in the DOM at once, and every store publish rebuilt all of
 * them — the "变更前 / 变更后" panes mounted every line of one side as well. In
 * the split mode note which element scrolls: the two panes only own their
 * HORIZONTAL scroll (`.rvs-diff-col`), while vertical scrolling belongs to
 * `.rvs-diff-grid` outside them — so ONE window serves all three columns and no
 * column can drift out of lockstep with another. The whole-file panes scroll
 * their own `.rvs-code` box and take the same window from the same hook.
 */
import { type ReactNode } from 'react';
import type { EditorTab } from '../store.tsx';
/** The half-open line range a windowed pane paints, plus what it leaves blank. */
export interface LineWindow {
    /** First rendered line index. */
    from: number;
    /** One past the last rendered line index. */
    to: number;
    /** Height of the lines above `from`, in px. */
    before: number;
    /** Height of the lines below `to`, in px. */
    after: number;
}
/**
 * The lines to paint for one scroll offset — arithmetic, not measurement,
 * because every windowed row is a hard `ROW_HEIGHT`.
 *
 * `total` is the number of lines the FULL pane would have rendered, which is
 * what the scroll range has to cover: `before + painted + after` is exactly
 * `total * ROW_HEIGHT`, so the scrollbar behaves as it did when every line was
 * mounted.
 *
 * `offset` is the scroller's own top padding (`CODE_PAD_TOP` on `.rvs-code`, 0
 * on `.rvs-diff-grid`).
 *
 * The offset is clamped to the LAST line, not merely guarded against negatives:
 * a reload can replace a 3000-line side with a 40-line one while the browser
 * still holds the old offset (it re-clamps the scroller only once the new
 * spacer height is in the DOM). An unclamped slice would ask for lines that no
 * longer exist, `from` would exceed the text, and the two spacers would then add
 * up to less than the file — the bottom of the new text would be unreachable.
 * Clamping keeps `before + painted + after` exactly equal to
 * `total * ROW_HEIGHT`, which is what the scroller's range was before this
 * window existed.
 *
 * Pure and exported so a probe can pin the boundaries without a browser.
 */
export declare function computeLineWindow(total: number, scrollTop: number, height: number, offset?: number, overscan?: number): LineWindow;
/** Why one hunk action (stage / unstage / revert) cannot run for this tab. */
export type HunkBlockReason = 'offline' | 'truncated';
/**
 * Whether a hunk action is refused, and why.
 *
 * A hunk action ships `model.hunks[].patch` to `git apply` on the host, and that
 * patch was parsed out of a `git diff` the host caps (`GIT_CAP`, 2 MB): on a
 * capped read the last hunk can be a HALF patch, which git refuses as corrupt
 * and the user sees git's raw error instead of "the file is too big". The pane
 * is already read-only for a capped read (the `truncated` tab flag, D3); hunk
 * writes have to obey that same promise instead of being the one exception.
 *
 * Pure and exported so the gate can pin both halves (offline and truncated)
 * without rendering CodeMirror.
 */
export declare function hunkBlockReason(tab: Pick<EditorTab, 'truncated'>, offline: boolean): HunkBlockReason | undefined;
/**
 * The text the editable "after" pane must mount with.
 *
 * Three sources, in order, and each exists for a different unmount:
 *  - `editBuffer` — this component's own handoff. A MODE switch (split/before/
 *    after) unmounts only the `CodeEditor`, so the pane keeps its state.
 *  - `tab.text` — a PREVIOUS mount's handoff, written by `onBuffer` when a tab
 *    switch or a surface flip unmounted the whole pane. Only trusted while the
 *    tab is dirty: once saved, the disk bytes are the truth (and a later reload
 *    must be able to show them).
 *  - the disk bytes — first mount, or a clean tab.
 *
 * Pure and exported for the same reason as `hunkBlockReason`: the handoff is
 * exactly the kind of thing that looks right in review and silently drops text
 * in practice.
 */
export declare function diffAfterInitialText(editBuffer: string | undefined, tab: Pick<EditorTab, 'text' | 'dirty'>, newText: string | undefined): string;
export declare function DiffView(props: {
    tab: EditorTab;
    visible: boolean;
    offline?: boolean;
}): ReactNode;
