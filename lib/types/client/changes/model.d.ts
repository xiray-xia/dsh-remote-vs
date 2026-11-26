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
 * 建立这批标记时随数据一起带下来的元信息（都可省略）。
 *
 * 两者各自服务一个上层判断，而且都**只能在这一层算**：块标识要用 hunk 头的四个
 * 数字 + 文件身份；状态来自列表行。行数统计也在这里算（面板的过期判定要用）。
 */
export interface ChangeSetMeta {
    /**
     * 文件的**远端绝对路径**（块标识的前半段，见 `changes/block-confirm.ts`）。
     *
     * 用绝对路径而不是显示路径：显示路径是相对会话根的，两个绑定/两个仓库子目录
     * 可以有相同的显示路径 + 相同的 hunk 头，那样它们的块会被认成同一块。
     */
    path?: string;
    /** 列表行的状态字母（`RemoteChangedFile.status`）。 */
    status?: string;
}
/**
 * Build the editable set for one file.
 *
 * @param hunks - served hunks for the whole session.
 * @param stamp - identity of the comparison (file + baseline + turn).
 * @param filePatch - the host's whole-file reverse patch, when it served one
 *   (see `ChangeSet.filePatch`); '' / missing = nothing to revert as a whole.
 * @param meta - 行数 / 状态 / 块标识的来处（见 {@link ChangeSetMeta}）。
 * @returns the mark set the editor paints, or {@link EMPTY_CHANGE_SET}.
 */
export declare function changeSetFromHunks(hunks: readonly UnifiedHunk[], stamp: string, filePatch?: string, meta?: ChangeSetMeta): ChangeSet;
