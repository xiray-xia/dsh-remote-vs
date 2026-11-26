/**
 * 「把鼠标停在这一行上，对这里的改动做事」：一枚贴行的 `⋯` 按钮 + 它展开的小菜单。
 *
 * 为什么不直接用 `hoverTooltip`：它把浮层挂进 CodeMirror 自己的 `.cm-tooltip` 层，位置
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
 * 一行都会返回一个区间，那样悬浮在任何地方都会冒出按钮。
 *
 * ## 为什么是"一枚按钮 + 菜单"，而不是并排两枚按钮
 *
 * 动作有两个（撤销这处改动 / 确认保留），一开始做成并排两枚，但行尾放不下时只能把
 * 整组挪走 —— 挪到被悬停行的上方后，指针从那一行移向按钮必然经过上一行；上一行多半
 * 不是改动行，`mousemove` 一落到它就整组收起，按钮因此**永远点不到**（2026-11-26 复
 * 核实测）。现在只在行尾放一枚小的 `⋯`（与行同一垂直中线），点击后展开的菜单挂在它
 * 旁边：指针从行内水平移到按钮、再从按钮移到菜单，全程不进入别的行。
 *
 * 本模块只回答"用户要对哪一处改动做什么"：`onUndo(mark)` / `confirm.onToggle(mark)`
 * 收到的是 `marks` 里的那个对象，其中 `hunk` 是 `ChangeSet.patches` 的下标。真正的
 * 撤销（远端 `git apply -R`）由调用方完成，文案也由调用方的 i18n 决定。
 */
import type { Extension } from '@codemirror/state';
import { type ChangeMark } from '../vsc/change-marks.ts';
/** 默认按钮文案。真实调用方（`CodeEditor`）总会传自己 i18n 的那一条。 */
export declare const DEFAULT_UNDO_LABEL = "\u64A4\u9500\u8FD9\u5904\u6539\u52A8";
/** 「确认保留」的默认文案（同上是兜底：真实调用方传 i18n）。 */
export declare const DEFAULT_CONFIRM_LABEL = "\u786E\u8BA4\u4FDD\u7559";
/** 已确认态下的默认文案。 */
export declare const DEFAULT_CONFIRMED_LABEL = "\u5DF2\u786E\u8BA4\u4FDD\u7559";
/** `⋯` 按钮的默认说明（真实调用方传 i18n）。 */
export declare const DEFAULT_TRIGGER_LABEL = "\u6539\u52A8\u64CD\u4F5C";
/**
 * 菜单里的第二个动作：「这处改动我看过，保留」。
 *
 * 它是**纯本地记账**（见 `changes/block-confirm.ts`）：不写远端、不发请求、不动
 * `ChangeSet`。所以这里只把"这一块当前是什么状态"问出来、把点击交回去，存哪里、
 * 怎么持久化都由调用方决定 —— 编辑器组件不持有那份状态。
 */
export interface BlockConfirmOptions {
    /** 这一块现在是否已确认（每次点击后重新读取，状态在 React 之外变化）。 */
    isConfirmed: (mark: ChangeMark) => boolean;
    /** 用户点了切换：调用方负责落盘（本地存储），不得发起任何远端写。 */
    onToggle: (mark: ChangeMark) => void;
    /** 未确认时的文案。 */
    label: (mark: ChangeMark) => string;
    /** 已确认时的文案；省略则沿用 {@link label}。 */
    pressedLabel?: (mark: ChangeMark) => string;
}
export interface UndoAffordanceOptions {
    /**
     * 点了撤销：`mark` 就是 `ChangeSet.marks` 里的那个对象（`hunk` = `patches` 下标）。
     * 不给时整块扩展不安装（`[]`），行为与没有这个功能时完全一致。
     */
    onUndo?: (mark: ChangeMark) => void;
    /**
     * 撤销项的文案。默认只是兜底：真实调用方按 `kind` 给出自己的（i18n）说法，
     * 例如删除锚点说「撤销这处删除」。
     */
    label?: (mark: ChangeMark) => string;
    /** `⋯` 按钮的说明（title / aria-label）。 */
    triggerLabel?: () => string;
    /** 悬停延迟，缺省 300ms。 */
    hoverTime?: number;
    /** 「确认保留」这一级（省略 = 菜单里只有撤销一项）。 */
    confirm?: BlockConfirmOptions;
}
/**
 * 只读编辑器里不提供撤销（断线降级 / 超上限截断）。
 *
 * 撤销按钮点下去是一次远端写（`git apply -R`），所以只读时它必须消失：否则屏幕上
 * 「只读（不能保存）」与「可写的撤销」并存，且请求只会在远端失败。判据读编辑器自己的
 * `readOnly` facet —— 与 `CodeEditor` 的 readOnly Compartment 是同一个事实，不需要再传
 * 一个 prop（第二个真相源迟早会漂）。
 *
 * 导出是为了让门禁能钉住这个判定（渲染 CodeMirror 的 DOM 级证明成本高，而这里的
 * 语义只有"只读 ⇒ 不提供"一句话）。
 */
export declare function undoBlockedByReadOnly(view: {
    state: {
        readOnly: boolean;
    };
}): boolean;
/**
 * 装上「改动操作」浮层（`⋯` + 菜单）。
 *
 * 没有 `onUndo`（调用方没接这个动作）时返回空扩展：不是"装上了但点了没反应"，而是
 * 压根没有插件 —— 不留 DOM 监听、不留任何行为差异。
 */
export declare function undoAffordance(options?: UndoAffordanceOptions): Extension;
