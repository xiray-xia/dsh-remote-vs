import type { Context } from '@deepseek-ai/cordis';
/**
 * The bits of an editor's view state that must survive an unmount.
 *
 * Switching file tabs remounts `CodeEditor` (its `key` is the tab id, so an
 * identity change gets a fresh buffer rather than inheriting the previous
 * file's undo history). Without carrying this across, every tab switch threw
 * the reader back to line 1 with the caret at the start.
 */
export interface CodeEditorViewState {
    /** Scroll offset of the code scroller, in pixels. */
    scrollTop: number;
    /** Scroll offset of the code scroller, in pixels. */
    scrollLeft: number;
    /** Caret position as a document offset. */
    cursor: number;
    /** All selection ranges (multi-cursor survives a tab switch too). */
    ranges: {
        anchor: number;
        head: number;
    }[];
}
export interface CodeEditorHandle {
    getContent: () => string;
    isDirty: () => boolean;
    markSaved: () => void;
    /** Snapshot scroll + selection, for restoring after a remount. */
    getViewState: () => CodeEditorViewState | undefined;
    /** Scroll back and put the caret where it was. */
    applyViewState: (state: CodeEditorViewState) => void;
    /** 选中一个行区间（1-based 行号）并滚到视野中央。 */
    revealRange: (from: number, to: number) => void;
    /**
     * 改动标记是否已被编辑作废（true = 屏幕上不再画任何改动点）。
     *
     * 暴露成独立的一个布尔查询、而不是把 `EditorView` 交出去：外部唯一需要知道的
     * 就是"这份数据还准不准"，拿到了整个 view 则能改文档、改配置，是另一回事。
     */
    getChangeStale: () => boolean;
}
import { type ChangeMark, type ChangeSet } from './vsc/change-marks.ts';
/**
 * The editor surface is OPAQUE and scrolls in the editor's own palette
 * (`vsc/editor-theme.ts`): a code editor is not a translucent DSH panel, and
 * the VS Code theme is what gives the tokens their readable colors.
 */
export declare const CodeEditor: import("react").ForwardRefExoticComponent<{
    initial: string;
    path: string;
    readOnly?: boolean;
    /** Parent sub-tab visibility (views stay mounted; remeasure on show). */
    visible?: boolean;
    /** Chat-insert target: absent/disabled hides the selection popup. */
    ctx?: Context;
    sessionId?: string | undefined;
    remoteRoot?: string | undefined;
    chatEnabled?: boolean;
    addLabel?: string;
    /** 1-based line to reveal after mount (a content-search hit). */
    revealLine?: number;
    /** Bumped per reveal request, so the same line can be jumped to twice. */
    revealNonce?: number;
    /**
     * 本会话在这个文件里的改动（行号 1-based）。`undefined` = 不开启改动标记：
     * 不装扩展、不出现 gutter —— 没传这个 prop 的调用方（diff 面板等）行为与
     * 加入本功能之前完全一致。
     */
    changeSet?: ChangeSet | null;
    /**
     * 用户在某一处改动上按下「撤销这处改动」时回调。
     *
     * 收到的是 `changeSet.marks` 里的那个对象（`hunk` 是 `changeSet.patches` 的下标）。
     * 不传就不装悬浮撤销那一整套（`undoAffordance`），编辑器行为与没有这个功能时
     * 完全一致 —— 也就不会点出一个没人接的动作。
     */
    onUndoChange?: (mark: ChangeMark) => void;
    /** 悬浮按钮的文案（由调用方按 `kind` 给出它的 i18n 说法）。 */
    undoLabel?: (mark: ChangeMark) => string;
    /** 改动点跳转的目标行（1-based），配合 `revealHunkNonce` 重跳同一行。 */
    revealHunkLine?: number;
    /** 改动点跳转的 nonce（同 `revealNonce` 的道理）。 */
    revealHunkNonce?: number;
    /**
     * 用户按下「上一个/下一个改动点」快捷键时回调。
     *
     * 列表算在 store 那边（`gotoChange`），编辑器只转发方向：组件内自己维护一份
     * hunk 列表会与 tab 上的 `activeHunk` 漂成两份。
     */
    onStepHunk?: (dir: 1 | -1) => void;
    /**
     * 文档被编辑、改动标记已作废时回调一次（false→true 的跳变）。
     *
     * 用回调而不是让上层轮询 handle：这件事发生在一次按键里，轮询会漏。
     */
    onChangeStale?: () => void;
    /** Reports how many token spans the grammar produced (diagnostics). */
    onTokens?: (count: number) => void;
    /**
     * Reports this editor's scroll + caret as they change, and once more when it
     * unmounts. The FIRST argument is this editor's own tab id, so the consumer
     * never has to guess which tab a reading belongs to.
     *
     * The editor reports it, rather than the parent asking through the ref,
     * because the parent's ref is already `null` by the time its layout-effect
     * cleanup runs — React clears a child's ref before running the parent's
     * cleanup. Only this component still holds the `EditorView` at that moment.
     */
    onViewState?: (tabId: string, state: CodeEditorViewState) => void;
    /**
     * This editor's tab id, echoed back with every report (see `onViewState`).
     * Optional because the diff panes mount `CodeEditor` too and have no tab of
     * their own; they pass no `onViewState`, so nothing is reported for them.
     */
    tabId?: string;
    /**
     * Scroll + caret to restore after this instance mounts.
     *
     * Read ONCE on mount (through a ref, so a later change to the prop cannot
     * re-scroll a live editor out from under the reader). Used to come back to
     * where a file was when its tab is re-selected.
     */
    viewState?: CodeEditorViewState;
    onSave: () => void;
    onDirty: (dirty: boolean) => void;
} & import("react").RefAttributes<CodeEditorHandle>>;
