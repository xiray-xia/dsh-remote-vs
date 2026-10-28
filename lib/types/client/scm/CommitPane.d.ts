/**
 * The history panel's commit pane: the selected commit in the three views the
 * DSH-better-sidebar changes pane exposes — `提交详情` (the card), `内容` (the
 * files the commit touched) and `差异` (its patch).
 *
 * Deliberately better than the reference pane in the places a narrow sidebar
 * hurts most:
 *  - a sticky patch toolbar (previous/next file, current file, wrap toggle,
 *    copy) so a long diff never loses the reader's position or the controls;
 *  - sticky file headers per block, because "which file am I looking at" was
 *    the reference's biggest scroll cost;
 *  - `内容` groups files by directory with collapsible folders and a path
 *    filter, instead of a flat wall of paths;
 *  - right-click opens a real menu on every changed file (open in the editor,
 *    show in the diff, copy the path / the file patch) — the editor's own
 *    gesture, not a second mental model;
 *  - expand/restore the pane to full height, and copy the commit message,
 *    without leaving the panel.
 *
 * Frameless by design: the split, the frame and the pane height belong to the
 * history panel, so this fills whatever box it is handed and scrolls itself.
 * Read-only: a commit's patch is history, so the only mutations are "check this
 * commit out" (confirmed) and copying — staging/reverting lives on worktree
 * diffs.
 *
 * The patch is loaded lazily: a reader of 提交详情 must not pay a `git show
 * --patch` round trip per clicked commit, and the pane asks for it only while
 * the 差异 tab is on screen.
 */
import { type ReactNode } from 'react';
import type { GitCommit, GitCommitFile } from '../../protocol.ts';
import type { Lang } from '../i18n.ts';
import { type HistoryTab } from './commit-model.ts';
/** Translator shape shared by every view (`makeT` returns the same). */
type Translate = (key: string) => string;
export interface CommitPaneProps {
    commit: GitCommit;
    tab: HistoryTab;
    onTab: (next: HistoryTab) => void;
    onClose: () => void;
    /** True while the pane covers the whole panel instead of its usual split. */
    expanded: boolean;
    onToggleExpand: () => void;
    /** Message text below the subject line ('' = none, or the read failed). */
    body: string;
    /** `git show --name-status` rows; undefined while the read is in flight. */
    files: GitCommitFile[] | undefined;
    /** Set when the file-list read failed (the 内容 tab shows it). */
    filesError: string | undefined;
    /** Raw `git show --patch` text; undefined until the 差异 tab asks for it. */
    patch: string | undefined;
    /** The remote read hit its byte cap: the parsed prefix is NOT the whole diff. */
    patchTruncated: boolean;
    patchLoading: boolean;
    patchError: string | undefined;
    /** A file selected in 内容 (or a patch header), highlighted in 差异. */
    focusPath: string | undefined;
    onFocusPath: (path: string) => void;
    onOpenFile: (path: string) => void;
    onCheckout: () => void;
    onReload: () => void;
    t: Translate;
    lang: Lang;
}
export declare function CommitPane(props: CommitPaneProps): ReactNode;
export {};
