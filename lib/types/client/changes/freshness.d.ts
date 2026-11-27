/**
 * 「回到页面/窗口时要不要强制刷新一次」的纯判定。
 *
 * 背景：宿主账本的自愈阈值是自适应的（`recorder.ts` 的 `selfHealMaxAge`，5–30s），
 * 而面板在页面隐藏期间不轮询。用户切走再回来时，屏幕上那份统计可能已经落后一个
 * 阈值；普通轮询读（`load(false)`）仍受阈值保护，所以"回来"这一刻要**强制刷新一次**
 * （等价于点 ⟳，`force` 会绕过节流并立刻重扫）。
 *
 * 但"回来"会连环触发事件：切回标签页同时有 `visibilitychange` 与 `focus`；在窗口
 * 之间点几下也会连续 `focus`。所以这里给三条门槛，任何一条不满足就不刷新：
 * - 页面必须真的可见（隐藏期间不轮询，也不该偷偷 force）；
 * - 距上一次强制刷新至少 {@link FORCE_REFRESH_DEBOUNCE_MS}（5s）；
 * - 没有同类的 `list` 请求在飞（它马上就会带回新数据）。
 *
 * 纯函数 + 显式时钟入参，`scripts/check-change-freshness.mjs` 直接驱动。
 */
/** 两次强制刷新之间的最小间隔（"点回窗口"的连环事件都落在这之内）。 */
export declare const FORCE_REFRESH_DEBOUNCE_MS = 5000;
/**
 * 一个 `list` 请求最多算"在飞"多久（60s）。
 *
 * 传输层理论上不会永远不 settle，但一次挂住的 fetch（半开连接、Host 卡死）会让
 * "在飞请求跳过"变成**永久**跳过——回到页面再也不强制刷新。超过这个时长就当作
 * 那次请求已经失败（迟到的响应仍会自己 setData，重发的这次不会破坏什么）。
 */
export declare const LOAD_IN_FLIGHT_MAX_MS = 60000;
/**
 * 这次 `list` 请求现在还算在飞吗？
 *
 * @param now - 当前时刻（毫秒）。
 * @param startedAt - 那次请求开始的时刻；没有在飞的请求为 `undefined`。
 */
export declare function loadStillInFlight(now: number, startedAt: number | undefined): boolean;
/** @see shouldForceRefresh */
export interface ForceRefreshInput {
    /** 当前时刻（毫秒；真实调用是 `Date.now()`，门禁注入假时钟）。 */
    now: number;
    /** 上一次强制刷新的时刻；从未刷新过为 `undefined`。 */
    lastForceAt: number | undefined;
    /** 页面当前是否可见（`document.hidden === false`）。 */
    visible: boolean;
    /** 是否已有 `list` 请求在飞（那一次请求会带回最新数据）。 */
    inFlight?: boolean;
}
/**
 * 这一刻要不要为了"用户回来了"强制刷新一次？
 *
 * @param input - 见 {@link ForceRefreshInput}。
 * @returns true = 调用方应立刻 `load(true)` 并记下 `now`。
 */
export declare function shouldForceRefresh(input: ForceRefreshInput): boolean;
