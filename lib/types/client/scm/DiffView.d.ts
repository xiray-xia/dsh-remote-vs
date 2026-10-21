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
export declare function DiffView(props: {
    tab: EditorTab;
    visible: boolean;
}): ReactNode;
