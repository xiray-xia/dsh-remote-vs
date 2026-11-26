/**
 * 编辑器里「这处改动我看过，保留」的块级本地笔记。
 *
 * 面板那一行上的 ✓ 是**文件级**人工标记（`review-state.ts`），回答的是"这个文件我
 * 审过了"。但一处三十行的重构里，真正需要收敛的是"这**一块**我看过了、同意保留" ——
 * 文件级 ✓ 要么在看完第一块时就被打上，要么看到最后才敢打。
 *
 * 所以这里补第二级：鼠标停在改动行上弹出的那条悬浮栏里，除了「撤销这处改动」，还有
 * 一个切换式的「确认保留」。它**什么也不写**：不写远端、不发请求、不动 diff 数据
 * （撤销是远端 `git apply -R`，确认只是给自己留个记号），状态存在 `localStorage`，
 * 按会话分开 —— 它描述的是"我读到哪儿了"，不是远端的任何事实。
 *
 * 块的身份用 `${远端绝对路径}|${oldStart}:${oldLines}:${newStart}:${newLines}`：行号
 * 会随远端改动漂移，而 hunk 头的四个数字 + 文件的远端绝对路径才代表"同一处改动"
 * （用绝对路径而不是会话相对的显示路径：两个仓库子目录可以给出同一个显示路径）。
 * 文件被重新统计后 hunk 头变了，旧笔记自然不再命中 —— 这正是想要的（内容变过，值得
 * 再看一眼），而且不需要监听任何事件。
 *
 * **已知限制（审核 N3）**：身份里没有**轴**也没有轮次号。同一文件的同一坐标若在
 * 「会话累计」与「本轮」两份数据里都出现（例如同一轮就是首次改动、两份 hunk 头恰好
 * 相同），那一处块确认是**共用的**；同理，隔着新一轮但 hunk 头四个数字完全没变的
 * 另一处改动也会沿用旧笔记。不把轴/轮号并进身份是刻意的取舍：身份串会随轮次变化，
 * 已确认状态在每次轮次关闭后全部失效；而"同一坐标、内容未变"沿用确认，正是这套
 * 记号想要的收敛效果。真要区分只能连内容指纹一起入键，那需要为每块算一次哈希。
 *
 * 两级语义**不联动**：块确认不会自动打文件级 ✓，文件级 ✓ 也不代表每一块都点过。
 * 纯函数 + 一个有上限的表，`scripts/check-block-confirm.mjs` 直接驱动真实判定，
 * 并用 jsdom 里的真 CodeMirror 点一次真正的按钮。
 */
/** 一个会话最多记住这么多块（长命页面不能无限长）。 */
export declare const BLOCK_CONFIRM_CAP = 2000;
/** `localStorage` 键前缀（按会话分开；与面板的审阅标记同一套约定）。 */
export declare const BLOCK_CONFIRM_PREFIX = "rvs.changes.confirmed.";
/** 已确认的块：键 → 1（用对象是为了能直接 JSON 往返）。 */
export type ConfirmedBlocks = Readonly<Record<string, 1>>;
/** 只读存取的存储接口（真实实现是 `window.localStorage`；门禁用假表）。 */
export interface ConfirmStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}
/** 一个 hunk 头里参与块身份的那四个数字。 */
export interface BlockHeader {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
}
/**
 * 块标识（见文件头；字段用 `|` 与 `:` 分隔，数字不会包含这两个字符）。
 *
 * @param path - 文件的**远端绝对路径**（不是显示路径）。
 * @param hunk - 这个 hunk 头里的四个数字。
 */
export declare function blockIdOf(path: string, hunk: BlockHeader): string;
/**
 * 一处改动（`ChangeMark`）对应的块标识。
 *
 * `mark.hunk` 是 `ChangeSet.patches` 的下标，`ChangeSet.blocks` 与它同序，所以这里
 * 只是换个名字；没有大括号（`blocks` 省略、或 `hunk` 缺失）时返回 `undefined` ——
 * 调用方据此不提供「确认保留」。
 */
export declare function blockIdForMark(blocks: readonly string[] | undefined, mark: {
    hunk?: number;
}): string | undefined;
/** 这一块是否已被确认。 */
export declare function isBlockConfirmed(blocks: ConfirmedBlocks, id: string): boolean;
/**
 * 切换一块的确认状态，返回新表（输入不被修改；超过上限时丢掉最早的那条）。
 *
 * 上限按 `Object.keys` 顺序（插入顺序）丢最旧的一条：块笔记是"我最近看过的"，
 * 丢掉最早看过的那条比拒绝新笔记更符合直觉。
 */
export declare function toggleConfirmedBlock(blocks: ConfirmedBlocks, id: string): Record<string, 1>;
/**
 * 解析持久化的一串 JSON。
 *
 * 任何畸形输入都给空表而不是抛错：这份状态只是"看过没看过"，读不出来最多重看一遍，
 * 不值得让编辑器崩掉。键必须非空、值必须是 1，且受 {@link BLOCK_CONFIRM_CAP} 限制。
 */
export declare function parseConfirmedBlocks(raw: string | null | undefined): Record<string, 1>;
/** 序列化（键数量已受上限约束，所以这串不会无限长）。 */
export declare function serializeConfirmedBlocks(blocks: ConfirmedBlocks): string;
/** 这一会话的存储键。 */
export declare function confirmedStorageKey(sessionId: string): string;
/** 读一个会话的块笔记（存储拒绝回答时给空表：私有模式最多是不持久化）。 */
export declare function loadConfirmedBlocks(storage: ConfirmStorage, sessionId: string): Record<string, 1>;
/** 写一个会话的块笔记（存不下就算了，绝不能因此打断编辑）。 */
export declare function saveConfirmedBlocks(storage: ConfirmStorage, sessionId: string, blocks: ConfirmedBlocks): void;
/**
 * 切换并落盘一块，返回切换后的状态。
 *
 * 一次调用完成"读 → 切 → 写"：编辑器里的按钮可能连点，中间隔着一次 React 渲染，
 * 拿旧表覆盖会把连点丢一半。
 */
export declare function toggleStoredBlock(storage: ConfirmStorage, sessionId: string, id: string): boolean;
/** 读一块的当前状态（每次现读：切换发生在 React 之外）。 */
export declare function isStoredBlockConfirmed(storage: ConfirmStorage, sessionId: string, id: string): boolean;
