/**
 * 「会话累计 / 本轮」两种视图共用的判定（纯函数）。
 *
 * 面板默认还是**会话累计**——那是它一直以来的语义，也是会话改动账本的基线。
 * 「本轮」是同一份账本的另一条轴：Host 在每个轮次关闭时记下当时的内容，下一次
 * 关闭时求差，所以本轮的行数与撤销补丁都只描述**最近一个已完成轮次**。
 *
 * 这里只放三件不需要 React 的事，好让门禁脚本直接驱动真实判定：
 * 1. 作用域怎么解析（存档里那串文本 → `session` / `turn`）；
 * 2. 本轮视图是不是可用（没有关闭过轮次、或 Host 是老版本时就没有 `turnView`）；
 * 3. 本轮模式下点开一行会得到哪几种结局 —— 这是这一半最容易说谎的地方：
 *    Host 缓存的比较可能已经过期（本轮之后文件又变了），也可能因为内存预算只剩
 *    统计（`cached: false`）。每种结局都对应一句必须显示给用户的话，不能静默。
 */
import type { RemoteChangedFile, RemoteChangesDiff, RemoteChangesTurnView } from '../../protocol.ts';
/** 面板当前按哪条轴列出改动。 */
export type ChangeScope = 'session' | 'turn';
/**
 * 作用域存在 `localStorage` 的哪个键下。
 *
 * 与审阅标记（`rvs.changes.reviewed.<session>`）同一族：这是"我想怎么读"，
 * 不是远端事实，所以既不是协议字段，也不进账本。
 */
export declare const CHANGE_SCOPE_STORAGE_KEY = "rvs.changes.scope";
/** 存档里的作用域文本；任何认不出来的值都回到默认的会话累计。 */
export declare function parseChangeScope(raw: string | null | undefined): ChangeScope;
/** 反过来写存档（当前只有两种取值，不做编码）。 */
export declare function serializeChangeScope(scope: ChangeScope): string;
/**
 * 本轮视图是否可用。
 *
 * `turn === 0` 表示这份账本还没有关闭过任何轮次：此时 `turnView` 不该出现，
 * 出现了也没有「上一轮」可比，一律按不可用处理（面板停在会话累计）。
 */
export declare function turnScopeAvailable(view: RemoteChangesTurnView | undefined): boolean;
/**
 * 本轮模式下点开一行的结局。
 *
 * - `use`：拿到本轮 hunk，照常画标记；
 * - `binary`：二进制行，没有文本比较（面板已有那句说明）；
 * - `fallback`：Host 说 `stale`——文件在本轮关闭之后又被改过，缓存的行号已经不
 *   描述磁盘。**改取会话累计的比较**，并把作用域切回会话累计（否则用户看到的还是
 *   一份已经作废的本轮列表）；
 * - `closed`：没有可画的东西（内存预算只剩统计 / 没有缓存 / 比较为空 / 读不到），
 *   给一句话，不建标记。
 */
export type TurnOutcome = {
    action: 'use';
    diff: RemoteChangesDiff;
} | {
    action: 'binary';
} | {
    action: 'fallback';
    noteKey: string;
} | {
    action: 'closed';
    noteKey: string;
    detail?: string;
};
/**
 * 判定一次点击。
 *
 * @param diff - `api.changes.turnDiff` 的答案（`null` = 没拿到；本轮没缓存时
 *   调用方不必发请求，直接传 null）。
 * @param view - 当前 summary 里的 `turnView`；`cached: false` 时一切都只能"只有统计"。
 */
export declare function turnOutcomeOf(diff: RemoteChangesDiff | null, view: RemoteChangesTurnView | undefined): TurnOutcome;
/** 点完一行之后，作用域要不要动。 */
export interface ScopeAfterOutcome {
    scope: ChangeScope;
    /**
     * 切轴时是否**保留**那句提示。
     *
     * `stale` 的处置是"把视图切回会话累计"，而解释这件事的那句话如果被切轴顺手清掉，
     * 用户只会看到列表静默换了一套数字（审核 M1）。所以这一种结局必须保留提示。
     */
    keepNote: boolean;
}
/**
 * 一次点击之后作用域怎么变。
 *
 * 只有 `fallback`（文件在本轮之后又被修改）会切轴，并且切回会话累计时**必须留着
 * 提示**；其余结局不动作用域，也就没有"保留"可言。
 *
 * @param outcome - `turnOutcomeOf` 的判定。
 * @param current - 当前作用域（`fallback` 之外原样返回）。
 */
export declare function scopeAfterOutcome(outcome: TurnOutcome, current: ChangeScope): ScopeAfterOutcome;
/** 本轮列表过滤后的可见部分（面板头部/审阅计数/跳转都读这一份）。 */
export interface VisibleTurnRows {
    /** 过滤掉"本轮已撤销"的行之后剩下的行（保持宿主给的顺序）。 */
    visible: RemoteChangedFile[];
    /** 被过滤掉的行数（>0 时面板必须给一句说明）。 */
    hidden: number;
    /** 可见行的 `+` 合计（不用宿主冻结的那份，它会算进已撤销的文件）。 */
    added: number;
    /** 可见行的 `−` 合计。 */
    deleted: number;
}
/**
 * 把宿主冻结的本轮行过滤成"现在还能看到的"。
 *
 * 宿主不回头改 `turnView`（轮次关闭即冻结），所以撤销成功后那一行只有客户端能去掉；
 * 去掉之后**所有**对外数字都必须按可见行重算：文件数、`+a −b`、✓ 的
 * `已审阅 n/N` 分母、以及「下一个未审阅」的候选集。否则会出现"列表只剩一行、合计
 * 还写着三行"的残影。
 *
 * @param files - `turnView.files`（宿主冻结的行）。
 * @param reverted - 这一轮已撤销的路径集合（`loadTurnRevertedPaths` / 注入的假表）。
 */
export declare function visibleTurnRows(files: readonly RemoteChangedFile[], reverted: ReadonlySet<string>): VisibleTurnRows;
/**
 * 全部行都被隐藏时，能不能断言「本轮改动已全部撤销」？
 *
 * **不能**，除非这份本轮视图是完整的：`truncated`（文件上限 / 上一侧内容未知 /
 * 上一轮未校正，已有行被丢弃）或 `pending`（慢扫描还没落地，列表还会变长）时，
 * "当前可见行为 0"只说明"我看到的这些都被撤销了"，不说明"这一轮已经没有改动"——
 * 面板无法证明的话不能说，而且那会与同屏的「扫描还没落地 / 视图不完整」直接矛盾。
 * 这种时候仍用带 `{n}` 的那句（"已撤销 N 个，已隐藏"），只是不再断言"全部"。
 *
 * @param input.visible - 过滤后可见的行数。
 * @param input.hidden - 被隐藏的行数。
 * @param input.truncated - 宿主标了视图不完整。
 * @param input.pending - 宿主标了这一轮还在等慢扫描。
 */
export declare function turnFullyReverted(input: {
    visible: number;
    hidden: number;
    truncated?: true;
    pending?: true;
}): boolean;
