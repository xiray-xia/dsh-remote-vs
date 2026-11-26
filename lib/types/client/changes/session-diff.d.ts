/**
 * 面板一行 → 一份**只读**的并排 diff（数据来源是会话账本，不是 git 工作区）。
 *
 * 面板原来只能"打开文件 + 就地画标记"：看这一处改动的上下文，得先打开文件、再靠
 * 行背景去读。SCM 的并排 diff（`scm/DiffView.tsx`）能给出"改前 / 改后"两栏，但它
 * 读的是 `git diff`（工作区对索引/HEAD），与会话账本**不是同一个基线**：账本比的是
 * 会话起点，工作区里可能还有会话开始之前就存在的未提交改动。
 *
 * 于是这里补的是账本这一侧的两块材料，让并排渲染器能直接复用：
 * 1. **改前全文**：Host 只给 hunk（`RemoteChangesDiff.hunks`），不给基线内容。但
 *    "改后"全文能读（`fileOp.read`），而 unified hunk 已经说清了每一次删除/新增 ——
 *    把删除行填回去、把新增行跳过，就**精确**还原出改前全文（纯函数，可断言）；
 * 2. **一份完整的 unified patch 文本**：hunk 里带着 `@@` 头与逐行内容，拼起来就是
 *    `parseUnifiedDiff` / `buildDiffModel` 要的输入。**不**用 `diff.patch`：整文件
 *    反向补丁在"新建文件"和"字节截断"两种情况下是空的，而 hunk 永远在。
 *
 * 两栏都只能**看**：这是会话的历史比较，不是可编辑的工作区副本（DiffView 按
 * `EditorTab.sessionDiff` 关掉编辑与 hunk 写操作）。
 */
import type { RemoteChangedFile, RemoteChangesDiff, UnifiedHunk } from '../../protocol.ts';
import type { DiffPayload } from '../scm/actions.ts';
import { type DiffNotice } from './diff-outcome.ts';
/**
 * 这一行能不能给出会话 diff。
 *
 * 二进制/非 UTF-8 文件没有可读的文本 hunk，超大文件连字节都被 Host 扣下 —— 这两种
 * 行"查看差异"只会得到一个空视图，所以菜单项直接不出现（回到"打开文件"）。
 */
export declare function canShowChangeDiff(file: Pick<RemoteChangedFile, 'binary' | 'oversized'>): boolean;
/**
 * 由"改后全文"与 hunk 还原"改前全文"。
 *
 * 依据是 unified diff 的定义：hunk 之外两侧相同，hunk 内 `-` 行只存在于改前、`+` 行
 * 只存在于改后、` ` 行两边都有。所以沿改后文件走一遍，遇到 `-` 就把该行填进改前，
 * 遇到 `+` 就跳过，其余照抄即可 —— 不需要基线内容，也不需要浏览器端再算一次 diff。
 *
 * 防御：hunk 头给出的 `newStart` 若落后于游标（重叠 / 乱序的坏数据），按游标继续，
 * 绝不回退（回退会重复输出行，把并排视图整体错位）。
 *
 * @param newText - 改后全文（远端当前内容；读不到时传 ''）。
 * @param hunks - Host 给的 hunk（按行号升序）。
 * @returns 改前全文（行之间用 `\n`，末尾不带换行；`''` = 改前没有内容）。
 */
export declare function beforeTextOf(newText: string, hunks: readonly UnifiedHunk[]): string;
/**
 * 把 hunk 拼成一份完整的 unified patch 文本（`buildDiffModel` 的输入）。
 *
 * 用 `diff --git` 开头：`parseUnifiedDiff` 以它为文件块的起点，缺了就一个 hunk 都
 * 解析不出来（面板会显示"没有差异"）。hunk 头按 Host 给的四个数字原样写回。
 *
 * @param display - 文件显示路径（写进 `a/` `b/` 两行；只用于展示与解析配对）。
 * @param hunks - Host 给的 hunk。
 * @returns patch 文本；没有 hunk 时 `''`。
 */
export declare function unifiedPatchOf(display: string, hunks: readonly UnifiedHunk[]): string;
/**
 * 会话 diff 的完整载荷（`DiffPayload`，`scm/DiffView.tsx` 的入参）。
 *
 * 没有 hunk、或连路径都拼不出来时返回 `undefined`（调用方据此说"没有可显示的差异"），
 * 而不是给一张会被渲染成"整篇都改了"的空表。
 *
 * @param diff - 账本给出的这份文件比较（必须是 `kind: 'text'`）。
 * @param newText - 远端当前内容（读不到时传 ''：改后一栏为空，仍然能看改前）。
 * @param display - 面板给的显示路径（用来在 `diff.display` 为空时兜底）。
 * @returns 载荷；没有 hunk / 没有可用路径时 `undefined`。
 */
export declare function sessionDiffPayload(diff: RemoteChangesDiff, newText: string, display?: string): DiffPayload | undefined;
/**
 * 账本 diff + 一次"改后"读取的**可见结论**。
 *
 * 为什么需要它（审核 M2/S4）：两种"数据不全"会让并排视图变成假的：
 * 1. `diff.truncated` —— Host 的 after 文本被字节上限扣下，hunk 是 before 对空文本
 *    算出来的（整篇假差异），撤销也不可能成立；
 * 2. `read.truncated` —— 改后一栏的读取本身被截断（8 MiB 上限），`beforeTextOf`
 *    会拿"完整基线"去对"前缀正文"，两栏整体错位。
 * 两种情形都不打开，只给一句说明。二进制读取同理（没有可读文本可比）。
 */
export interface SessionDiffRead {
    /** 远端当前内容（读失败时传 ''，改后一栏空着、改前仍可看）。 */
    text: string;
    /** 读取撞上了 8 MiB 上限：`text` 只是前缀。 */
    truncated?: true;
    /** 读取判定为二进制。 */
    binary?: true;
}
export type SessionDiffOutcome = {
    ok: true;
    payload: DiffPayload;
} | {
    ok: false;
    notice: DiffNotice;
};
/**
 * 把"账本 diff + 改后读取"翻成"能打开的两栏"或"必须说明的结论"。
 *
 * @param diff - 账本给出的这份比较（`null` = 没拿到）。
 * @param read - 改后一栏的读取结果。
 * @param display - 面板给的显示路径（账本行偶尔给 ''）。
 */
export declare function sessionDiffOutcome(diff: RemoteChangesDiff | null, read: SessionDiffRead, display?: string): SessionDiffOutcome;
