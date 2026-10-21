/**
 * 「把鼠标停在这一行上，撤销这处改动」。
 *
 * 为什么不用 `hoverTooltip`：它把浮层挂进 CodeMirror 自己的 `.cm-tooltip` 层，位置
 * 由文本坐标算，形态只有"命中点正上方/正下方"两档。这对文字注释刚好，对一个**要点的
 * 按钮**有两个毛病：
 * 1. 落不到行的**右侧** —— 我们要按钮贴着行尾，不能盖住正在看的改动行；
 * 2. 浮层仍在编辑器的 DOM 树里，宿主容器（`.rvs-editor-host`）一旦 `overflow: hidden`
 *    就会被裁掉半截。
 * 所以这里用等价机制：一个 ViewPlugin 只负责"命中判定 + 悬停计时"，按钮则是
 * `position: fixed` 挂到 `document.body` 上去的元素 —— 与「添加到对话」那个浮层
 * （`selection-popup.ts` / `CodeEditor` 里的 portal）是同一种形态，天然不受任何
 * 滚动、`overflow`、`transform` 祖先影响。
 *
 * 命中规则与 CodeMirror 的装饰无关，只读 `changeSetOf(state).marks`（1-based 闭区间）：
 * **只有真的落在某个 mark 里才弹**。刻意不用 `changeBlockAt` —— 它带单行兜底，任何
 * 一行都会返回一个区间，那样悬浮在任何地方都会冒出撤销按钮。
 *
 * 本模块只回答"用户点了哪一处改动"：`onUndo(mark)` 收到的是 `marks` 里的那个对象，
 * 其中 `hunk` 是 `ChangeSet.patches` 的下标。真正的撤销（远端 `git apply -R`）由
 * 调用方完成，按钮文案也由调用方的 i18n 决定（扩展不写死文案，只把 `kind` 交出去，
 * 删除锚点因此可以有自己的说法）。
 */
import type { Extension } from '@codemirror/state';
import { type ChangeMark } from '../vsc/change-marks.ts';
/** 默认按钮文案。真实调用方（`CodeEditor`）总会传自己 i18n 的那一条。 */
export declare const DEFAULT_UNDO_LABEL = "\u64A4\u9500\u8FD9\u5904\u6539\u52A8";
export interface UndoAffordanceOptions {
    /**
     * 点了按钮：`mark` 就是 `ChangeSet.marks` 里的那个对象（`hunk` = `patches` 下标）。
     * 不给时整块扩展不安装（`[]`），行为与没有这个功能时完全一致。
     */
    onUndo?: (mark: ChangeMark) => void;
    /**
     * 按钮文案。默认只是兜底：真实调用方按 `kind` 给出自己的（i18n）说法，
     * 例如删除锚点说「撤销这处删除」。
     */
    label?: (mark: ChangeMark) => string;
    /** 悬停延迟，缺省 300ms。 */
    hoverTime?: number;
}
/**
 * 装上「悬浮撤销」。
 *
 * 没有 `onUndo`（调用方没接这个动作）时返回空扩展：不是"装上了但点了没反应"，而是
 * 压根没有插件 —— 不留 DOM 监听、不留任何行为差异。
 */
export declare function undoAffordance(options?: UndoAffordanceOptions): Extension;
