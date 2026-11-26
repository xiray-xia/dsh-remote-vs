/**
 * 点开一行时，Host 给的这份 diff 到底能画出什么 —— 以及必须当面说清的那几种情况。
 *
 * 面板原来只看 `kind === 'text'`：二进制与读不到的文件都落进"空标记集"，
 * 屏幕上什么也没有、也没说为什么（`changes/ChangesDock.tsx` 的旧写法）。
 *
 * 三种"不能画"的原因必须分开说，因为读法完全不同：
 * - `truncated`：Host 的读取被字节上限扣下。注意它**不是**"只给了前 N 处"：被扣的是
 *   文件的 after 文本，hunk 是拿 before 对**空文本**算出来的，等于整篇都算改动，而且
 *   `reverse` 为空、每个 hunk 的 patch 都是 ''（`recorder.ts` 394-407）—— 撤销不可
 *   能成功。所以这种 diff 一行标记都不建，只说"比较不完整、不能撤销"；
 * - `binary`：二进制/非 UTF-8，没有可画的文本行；
 * - `oversized`：文件超过行级比较上限（或字节被扣下），行数本身就不可信，不做行级比较；
 * - `missing`：Host 读不到那个文件（`kind: 'missing'`，或调用本身没拿到东西）；
 * - `empty`：两侧都读到了、也比较了，但**现在**没有差异（行还留在列表里，内容已被改回）。
 *
 * 这里把"这份 diff 属于哪种结局"收成一个纯判定，并顺手把 `ChangeSet` 建好，让
 * 面板只剩"显示哪句话"一件事。纯函数，`scripts/check-diff-outcome.mjs` 直接驱动。
 */
import type { RemoteChangesDiff } from '../../protocol.ts';
import { type ChangeSet } from './model.ts';
/**
 * 一份 diff 的可见结论。
 *
 * 顺序即判定优先级（见 {@link noticeOfDiff}）：读不到 → 二进制 → 过大/截断 → 空比较。
 */
export type DiffNotice = 'truncated' | 'oversized' | 'binary' | 'missing' | 'empty';
/** 一份结论对应的字典键。 */
export declare function diffNoticeKey(notice: DiffNotice): string;
/** 面板拿到的这份 diff 属于哪种结论；`undefined` = 正常文本差异。 */
export declare function noticeOfDiff(diff: RemoteChangesDiff | null): DiffNotice | undefined;
/** 建一批标记时调用方手头知道的那些事实。 */
export interface DiffMeta {
    /** 文件的远端绝对路径（块标识的前半段，见 `changes/block-confirm.ts`）。 */
    path?: string;
    /** 列表行的状态字母（`RemoteChangedFile.status`）。 */
    status?: string;
}
/** 一次"点开一行"的完整结果。 */
export interface ChangeSetFromDiffResult {
    set: ChangeSet;
    /** 必须显示给用户的结论；`undefined` = 一切正常，不必出提示。 */
    notice?: DiffNotice;
}
/**
 * 把一份 diff 结论同时翻成"要画的标记"与"要说的话"。
 *
 * **`truncated` 一行标记都不建**（M2）：那种 diff 的 hunk 是 before 对空文本算的
 * 整篇假差异，照着画会把每个改动点都标成删除，撤销更不可能成立（patch 全为空）。
 * 宁可不画，也不给一份"看着像真相"的假标记。
 *
 * @param diff - `api.changes.diff` 的答案（`null` = 没拿到）。
 * @param stamp - 这份数据的身份（文件 + 统计时刻 + 轮次）。
 * @param meta - 调用方手头知道的事实，见 {@link DiffMeta}。
 */
export declare function changeSetFromDiff(diff: RemoteChangesDiff | null, stamp: string, meta?: DiffMeta): ChangeSetFromDiffResult;
