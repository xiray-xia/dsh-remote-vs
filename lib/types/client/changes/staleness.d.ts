/**
 * 已打开的标签页里那批改动标记，还配得上面板刚拿到的新列表吗？
 *
 * 标记只在三种时机重算：点开一行、保存成功、撤销成功。面板每 3 秒重新统计一次
 * （`RemoteChangesSummary`），远端/会话继续改同一个文件时，屏幕上那份行号与补丁
 * 描述的是**过去**的内容 —— 但编辑器自己不知道：`changeStale` 只由本地输入触发，
 * 所以旧标记会一直画着，看起来仍然准确。
 *
 * 这里补的就是那个判据，而且刻意做成纯函数：面板把新 summary 交进来，store 按
 * 结果给标签页打既有那张「位置已过期」的标记（不发起任何远端读 —— 重新读是用户
 * 点该行时的事，轮询不能自己发请求）。
 *
 * 比对什么：
 * - **行数**：这批标记当初代表多少增删行，记在 `ChangeSet.added/deleted` 里；
 * - **状态**：新建 / 删除 / 重命名是不同的事件（省略 = 当初没拿到，不比对）；
 * - **消失**：文件已经从列表里没了（生成的基线又合上了、或被排除目录吃掉）。
 *
 * 刻意不比对 `RemoteChangesDiff` / 补丁内容：那是每个文件一次远端读，轮询不做。
 */
/** 决策需要的一个标签页（`EditorTab` 的投影）。 */
export interface MarksTab {
    /** 标签页 id（`markChangeStale` 的入参）。 */
    id: string;
    /** 标签页的远端绝对路径 —— 与 `RemoteChangedFile.path` 同一个拼写。 */
    path: string;
    /** 这批标记当初代表的增删行数（`ChangeSet.added/deleted`；省略 = 不可比）。 */
    added?: number;
    /** 同上。 */
    deleted?: number;
    /** 建立标记时列表行的状态；省略 = 未知。 */
    status?: string;
    /** 已经标过过期：不必重复处理。 */
    stale?: boolean;
    /**
     * 这批标记是什么时候建的（`EditorTab.changeSetAt`，毫秒）。
     *
     * 与列表自己带的 `RemoteChangesSummary.at` 对照：标记比列表**新**时，列表是更早
     * 一台快照（例如保存后标记刚重读过、面板那份统计还没重算），此时行数不同不当证据。
     */
    at?: number;
}
/** 面板的一行（只取比对用到的字段，便于用纯数据驱动）。 */
export interface MarksRow {
    path: string;
    added: number;
    deleted: number;
    status?: string;
    /** 二进制：Host 把计数钉成 0/0，这个数字不代表真实行数。 */
    binary?: true;
    /** 过大（字节被扣下）：同上，计数不可信。 */
    oversized?: true;
}
/**
 * 这一页的标记是否已经不再描述当前列表了。
 *
 * @param tab - 一页的标记数据。
 * @param files - 面板刚拿到的行。
 * @param truncated - 列表自己被文件上限截断了（`RemoteChangesSummary.truncated`）。
 * @param listedAt - 这份列表是什么时候重算的（`RemoteChangesSummary.at`）；标记比它新
 *   时整条判定都跳过 —— 列表是更早的快照，"不一致"只说明我们手里的标记更新。
 * @returns true = 该给这一页打「位置已过期」。
 */
export declare function marksAreStale(tab: MarksTab, files: readonly MarksRow[], truncated?: boolean, listedAt?: number): boolean;
/**
 * 该被打上过期标记的标签页 id（按 `tabs` 顺序，已过期的跳过）。
 *
 * @param tabs - 已打开的标签页投影（只该包含**属于当前面板会话**的那些，见调用方）。
 * @param files - 面板刚拿到的行。
 * @param truncated - 列表自己被截断。
 * @param listedAt - 这份列表的重算时刻（见 {@link marksAreStale}）。
 */
export declare function tabsToMarkStale(tabs: readonly MarksTab[], files: readonly MarksRow[], truncated?: boolean, listedAt?: number): string[];
/** 本轮视图里跟过期判定有关的那几项（`RemoteChangesTurnView` 的投影）。 */
export interface TurnStalenessView {
    turn: number;
    files: readonly MarksRow[];
    truncated?: true;
}
/**
 * 本轮轴的标记还配得上当前这一轮吗？
 *
 * 与会话轴的两点不同，都是被实测打出来的（审核 S1）：
 *
 * 1. **不传 `listedAt`**。会话轴的"标记比列表新就不算过期"是为了兜住"保存后标记
 *    刚重读、面板那份统计还没重算"的一瞬；本轮轴正好反过来：`turnView.at` 是**轮次
 *    关闭**的时刻，而 `changeSetAt` 是用户**点行**的时刻，后者永远更晚 —— 传了
 *    `listedAt` 会让判据恒假，本轮标记于是永远不报过期。本轮 delta 在轮内不变，所以
 *    这个时间护栏在这里本就没有意义。
 * 2. **轮次翻篇即过期**。`turnView` 只保存最近一个已完成轮次；标记描述的那一轮一旦
 *    过去，它的行数就再没有可比的列表（Host 也不再保存），"无法证明仍准确"就等于
 *    过期。这正是原来 `origin.turn` 不更新的后果：旧轮标记会永久脱离校验。
 *
 * @param tab - 这一页的标记数据。
 * @param marksTurn - 这批标记当初属于哪一轮（provenance 的 `turn`）。
 * @param view - 当前 `turnView`；`undefined` = 这一轮已经不存在（Host 重启/老版本）。
 * @returns true = 该给这一页打「位置已过期」。
 */
export declare function turnMarksStale(tab: MarksTab, marksTurn: number | undefined, view: TurnStalenessView | undefined): boolean;
