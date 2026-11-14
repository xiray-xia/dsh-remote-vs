/**
 * 「这个文件我看过了」的本地标记。
 *
 * 会话改动面板原本只能看、不能收敛：一次三十个文件的重构，没有任何地方记得"这个我
 * 已经审过"，列表和游标每次都从头上开始。这里补的是**纯客户端**的审阅状态 —— 它不
 * 写远端、不进账本、不影响任何一次 `git` 调用，因此是这条路线上唯一零风险的收敛手段
 * （"接受改动"的另一半语义是真正的 `git apply --cached`，那要求基线等于索引，属于另一
 * 个决定，**不在本模块**里）。
 *
 * ## 为什么键里带计数
 *
 * 键 = 路径 + 增删行数 + 状态。会话又改了同一批行（行数随之变化）时，旧标记自然失效，
 * 文件重新变成"未审阅"——这正是想要的效果，而且不需要监听任何事件。行数完全没变的
 * 二次编辑仍会被当成"已审阅"，这是这套方案的已知盲点：它与"审阅的是哪一版"这个事实
 * 相比，代价远小于为每个文件拉一次 diff 去算指纹。
 *
 * 纯函数 + 一个带上限的表，`scripts/check-review-state.mjs` 直接驱动真实的判定。
 */
/** 面板能给的一行（`RemoteChangedFile` 的投影）。 */
export interface ReviewSubject {
    /** 远端绝对路径（唯一标识）。 */
    path: string;
    added: number;
    deleted: number;
    status?: string;
}
/** 已审阅集合：键 → 1（用对象是为了能直接 JSON 往返）。 */
export type ReviewedMap = Readonly<Record<string, 1>>;
/** 一个会话最多记住这么多条（长命页面不能无限长）。 */
export declare const REVIEW_CAP = 1000;
/**
 * 一行的审阅键。
 *
 * 计数进键里是刻意的：见文件头。`status` 也进键，因为"删掉了又加回来"和"一直在改"
 * 是两件不同的事，标签变了就该重新看一遍。
 *
 * @param file - 面板的一行。
 * @returns 稳定的键（路径里可能有任意字符，用 NUL 分隔不会与计数撞）。
 */
export declare function reviewKeyOf(file: ReviewSubject): string;
/** 这一行是否已被标为审阅。 */
export declare function isReviewed(file: ReviewSubject, reviewed: ReviewedMap): boolean;
/** 已审阅的行数（只数当前列表里的，所以它永远 ≤ 列表长度）。 */
export declare function reviewedCount(files: readonly ReviewSubject[], reviewed: ReviewedMap): number;
/** 切换一行的标记，返回新表（输入不被修改）。 */
export declare function toggleReviewed(files: readonly ReviewSubject[], reviewed: ReviewedMap, file: ReviewSubject): Record<string, 1>;
/** 全标或全清。 */
export declare function setAllReviewed(files: readonly ReviewSubject[], on: boolean): Record<string, 1>;
/**
 * 丢掉不属于当前列表的键。
 *
 * 列表每 3 秒重建一次，一条被删掉（或计数变了）的键如果留着，下次同一路径回到列表
 * 时会被当成"已审阅"——那是凭空出现的勾。清理放在每次写入与每次加载后都做，代价是
 * O(列表长度)。
 */
export declare function pruneReviewed(files: readonly ReviewSubject[], reviewed: ReviewedMap): Record<string, 1>;
/**
 * 解析持久化的一串 JSON。
 *
 * 任何畸形输入都给空表而不是抛错：这份状态是"看过没看过"，读不出来最多重看一遍，
 * 不值得让面板崩掉。键必须是字符串、值必须是 1，且受 {@link REVIEW_CAP} 限制。
 *
 * @param raw - `localStorage` 里存着的那串文本（可能为 null）。
 */
export declare function parseReviewed(raw: string | null | undefined): Record<string, 1>;
/** 序列化（键数量已受上限约束，所以这串不会无限长）。 */
export declare function serializeReviewed(reviewed: ReviewedMap): string;
