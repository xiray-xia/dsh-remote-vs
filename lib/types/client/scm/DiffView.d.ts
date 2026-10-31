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
 * The row count is the WHOLE file, so the split mode is windowed (see
 * `useRowWindow`): before that, a 3000-line file put 9000 line containers and
 * ~2N tokenized lines in the DOM at once, and every store publish rebuilt all
 * of them. Note which element scrolls: the two panes only own their HORIZONTAL
 * scroll (`.rvs-diff-col`), while vertical scrolling belongs to `.rvs-diff-grid`
 * outside them — so ONE window serves all three columns and no column can
 * drift out of lockstep with another.
 */
import { type ReactNode } from 'react';
import type { EditorTab } from '../store.tsx';
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
