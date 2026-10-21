/**
 * "What this session changed", painted into the file editor (Cursor style).
 *
 * 本模块只做四件事：把调用方算好的行号画成行背景、把行内片段画成"变了的字符"与
 * 删除 chip、在左侧 gutter 上打三种标记、以及在文档一旦被编辑时把整份标记作废。
 * 数据全部从 `setChangeSet` 这个 StateEffect 进来 —— 这里不发任何请求，也不自己
 * 算 diff（字符级比较在 `changes/model.ts`，那边是纯函数，能脱离浏览器断言）。
 *
 * 关键取舍（为什么编辑后是"清空"而不是"跟着映射"）：改动点的行号来自"磁盘上
 * 那一刻"的基线。`value.map(tr.changes)` 只保证装饰不崩、位置不乱序，但不保证
 * 语义还对：用户在改动点之前插入或删除几行，后面每一个改动点都整体平移，映射
 * 出来的边界不再等于真实改动边界，而且偏得越久越离谱。与其显示一份看起来仍准
 * 的假标记，不如立刻作废、让上层重新拉数据（`changeStaleField` 就是给上层的
 * 那个信号）。这与 landing 高亮（`reveal-line.ts`，一次性、2600ms 后自行熄灭）
 * 的处理方式不同，因为那里错了也无非闪一下，这里是长期驻留的视觉事实。
 *
 * 性能：装饰只用视口内的 `RangeSetBuilder` 构建（照 `fallback-highlight.ts` 的
 * 写法），所以 1 万行文件 + 500 个改动点的成本被视口钉死；gutter 标记同样是
 * 视口内构建，并且按"视口 + 当前数据"做了单条缓存，滚动时才重算。
 */
import { StateField, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
/** 改动点的三种形态。 */
export type ChangeKind = 'add' | 'mod' | 'del';
/**
 * 新增/修改行里"真正变化的字符区间"：相对所属行的列偏移，**0-based、半开区间**。
 *
 * 行背景回答"哪几行变了"，这个回答"那一行的哪几个字变了" —— 只改一个词的编辑在
 * 整行同色时根本看不出改了什么。
 */
export interface InlineRange {
    from: number;
    to: number;
    /**
     * 这个区间落在哪一行（1-based）。**省略 = 所属 mark 的 `from` 行**。
     *
     * 一个修改块是一条 mark 跨了它所有新增行，所以跨多行的块必须写出行号；单行改动
     * 是绝大多数情况，那里省掉它，数据形状与"区间就在这条 mark 的行上"一致。
     */
    line?: number;
}
/**
 * 被删掉、在新文件里已经不存在的内容：挂在某一行的某一列上，用 widget 显示。
 *
 * 行内被删短的片段（`const a = 1 + 2` → `const a = 1`）和整行被删的块都用它 ——
 * 新文件里没有这些字符，行背景画不出它们，只能把原文以"删除线 chip"钉在切口处。
 */
export interface RemovedChip {
    /** 列偏移（0-based），chips 落在这一列上。 */
    at: number;
    /** 被删文本（超过数据层的上限时已被截断，见 `truncated`）。 */
    text: string;
    /** `text` 是否是截断后的结果（原文更长）。 */
    truncated: boolean;
    /** 这个 chip 落在哪一行（1-based）。**省略 = 所属 mark 的 `from` 行**。 */
    line?: number;
}
/**
 * 一处改动：**1-based、闭区间**的行号。
 *
 * `del` 没有真实存在的行可画，用"删除位置锚点行"表示（`from === to`）——
 * CodeMirror 的文档里不存在"被删掉的那一行"，只能画在它原本所在的位置上。
 */
export interface ChangeMark {
    from: number;
    to: number;
    kind: ChangeKind;
    /**
     * 这块标记属于第几个 hunk（`ChangeSet.hunks` / `ChangeSet.patches` 的下标）。
     *
     * 悬浮撤销要精确到"这一处改动"，而行号会在 `spansOf` 里被裁切合并，所以归属
     * 只能由数据层在算 mark 时一起带下来。
     */
    hunk?: number;
    /**
     * 行内变化区间（字符级）。数据层算不出/不该算时（超长行、配对过多、纯新增块）
     * 就不带这个字段，此时只有整行标记 —— 这是**降级**，不是错误。
     */
    inline?: InlineRange[];
    /** 该改动里"新文件已不存在"的内容，渲染成删除 chip。 */
    removed?: RemovedChip[];
}
/** 一个文件的全部改动，由上层（会话改动数据层）算好送进来。 */
export interface ChangeSet {
    marks: ChangeMark[];
    /** 每处改动的起始行号（1-based、升序），供「上一个/下一个改动点」跳转。 */
    hunks: number[];
    /** 数据快照标识（例如 mtime + 大小）。仅用于判定"是不是同一份数据"。 */
    stamp: string;
    /**
     * 与 `hunks` 一一对应的 git hunk patch（`UnifiedHunk.patch`）。
     *
     * 「撤销这处改动」把它交给 `applyHunk(alias, root, patch, 'revert')`：反向应用
     * 由 `git apply -R` 完成，上下文不匹配时它自己就会拒绝——这正是我们要的冲突
     * 护栏，比在浏览器里重算一遍替换区间可靠。
     */
    patches?: string[];
}
/** 换一份改动标记；`null` = 清空（有改动数据，但没有任何要画的东西）。 */
export declare const setChangeSet: import("@codemirror/state").StateEffectType<ChangeSet | null>;
/**
 * 标记是否已经因为编辑而作废（true = 屏幕上不会再画任何改动点，上层该重新拉）。
 *
 * 独立成一个 StateField 而不是让调用方去比对 `marksField`：它要能被
 * `CodeEditor` 的 handle（`getChangeStale`）直接读，而且语义上就是"数据过期"这一
 * 个布尔事实。
 */
export declare const changeStaleField: StateField<boolean>;
/** 当前生效的改动数据（`null` = 没有 / 已被编辑作废）。 */
export declare function changeSetOf(state: EditorState): ChangeSet | null;
/**
 * `line`（1-based）所在的改动块，用作「跳到这个改动点」时选中的区间。
 *
 * 跳转只拿到一个起始行号（`ChangeSet.hunks`），选中整块才看得出这次改动有多大；
 * 该行不在任何 mark 里时退回单行，调用方永远拿到一个可用的区间。
 */
export declare function changeBlockAt(state: EditorState, line: number): {
    from: number;
    to: number;
};
/**
 * 只给视口内的行加装饰：行背景（`Decoration.line`）+ 行内字符区间
 * （`Decoration.mark`）+ 删除 chip（`Decoration.widget`）。
 *
 * 每次滚动都重算（`viewportChanged`），所以成本是 `O(log n + 视口行数)`：1 万行
 * 文件里 500 个改动点，在任何一屏上都只建几十个装饰。
 */
declare class ChangeMarkHighlighter {
    decorations: DecorationSet;
    private readonly view;
    constructor(view: EditorView);
    update(update: ViewUpdate): void;
    private rebuild;
}
/**
 * 视口内行装饰的 ViewPlugin。
 *
 * 导出是为了让自检脚本能直接读 `view.plugin(changeMarkPlugin).decorations.size`
 * —— "只装饰视口内的行"这件事在 DOM 上看不出来（CodeMirror 本来就让 DOM 只保留
 * 可见行），只有读这份 RangeSet 的条数才有判别力。
 */
export declare const changeMarkPlugin: ViewPlugin<ChangeMarkHighlighter, undefined>;
/**
 * 编辑器侧的完整扩展：数据字段 + 作废标记 + 左侧 gutter + 行背景。
 *
 * `CodeEditor` 只在调用方真的传了 `changeSet` 时把它装进编辑器（Compartment），
 * 没传时不装 —— 这样"没有会话改动"的文件连一条 gutter 都不会多出来。
 */
export declare const changeMarksExtension: Extension;
export {};
