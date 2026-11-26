/**
 * 「这一轮里这个文件的改动已经被撤销了」的客户端记账。
 *
 * 为什么要客户端自己记：`turnView` 是**轮次关闭时冻结**的 delta（宿主语义，本轮任务
 * 明确不动）。撤销是之后才发生的远端写，宿主不会回头改那份快照，所以撤销成功后本轮
 * 列表仍然列着该文件 —— 用户看到"已撤销，但列表还在"。这里补的是呈现层的账：
 * 撤销成功的 `(sessionId, turn, path)` 记在 `localStorage`，面板在本轮模式把它过滤掉，
 * **宿主照旧算它的冻结 delta**，两个视图的读数都不受影响。
 *
 * 只记「这一文件的这一轮改动已经全部没了」的两条确定路径（见 store 的调用点）：
 * - 悬浮「撤销这处改动」：仅当该 tab 的 ChangeSet 只有**一个 hunk**（撤掉它 = 全部）；
 *   多 hunk 的部分撤销**不记**，否则会把剩余改动一起藏掉，比现状更糟；
 * - 行菜单「撤销该文件的全部改动」且 `scope === 'turn'`：一定记。
 * 撤销失败不记；会话累计轴不读不写这个存储。
 *
 * 存储形状（按会话分键，键前缀与审阅标记/块确认同一套约定）：
 * ```
 * localStorage['rvs.changes.reverted.<sessionId>'] = { v: 1, turns: { [turn]: { [path]: at } } }
 * ```
 * 上限：每会话最多 {@link TURN_REVERTED_MAX_PATHS} 条路径、只保留最近
 * {@link TURN_REVERTED_MAX_TURNS} 个 turn（写入/读取时都收敛）。坏 JSON、坏结构、
 * storage 被禁用（私有模式）一律安全返回，绝不抛错 —— 这份状态只是"别把撤掉的行画
 * 回来"，读不出来最多多显示一行。
 *
 * 纯函数 + 注入式 storage（仿 `block-confirm.ts`），`scripts/check-turn-reverted.mjs`
 * 直接驱动真实判定。
 */

/** `localStorage` 键前缀（按会话分开）。 */
export const TURN_REVERTED_PREFIX = 'rvs.changes.reverted.'

/** 一个会话最多记住「最近这几轮」的撤销记录（更早的轮次已经不会显示在本轮视图里）。 */
export const TURN_REVERTED_MAX_TURNS = 3

/** 一个会话最多记住这么多条撤销路径（长命页面不能无限长）。 */
export const TURN_REVERTED_MAX_PATHS = 500

/** 只读存取的存储接口（真实实现是 `window.localStorage`；门禁用假表）。 */
export interface RevertedStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 落盘的形状：`v` 是版本号，`turns` 是 turn → (path → 标记时刻)。 */
export interface TurnRevertedState {
  v: 1
  turns: Record<string, Record<string, number>>
}

/** 空状态（只读共享，模块内部使用，调用方不得修改）。 */
const EMPTY_TURN_REVERTED: TurnRevertedState = { v: 1, turns: {} }

/** 这一会话的存储键。 */
export function turnRevertedStorageKey(sessionId: string): string {
  return `${TURN_REVERTED_PREFIX}${sessionId}`
}

/** turn 是否是能用的轮次号（正整数）。 */
function usableTurn(turn: number): boolean {
  return Number.isFinite(turn) && Number.isInteger(turn) && turn > 0
}

/**
 * 收敛一份状态：只留最近的 {@link TURN_REVERTED_MAX_TURNS} 个 turn、最多
 * {@link TURN_REVERTED_MAX_PATHS} 条路径。
 *
 * 路径超限时按 `at` 升序丢最旧的（同一时刻再按 turn/path 排，保证结果确定）——
 * 撤销记录是"刚发生的事"，保留最新的一批比拒绝新记录更符合直觉。
 *
 * @param state - 任意来源的状态（会被重建，不改入参）。
 */
export function pruneTurnReverted(state: TurnRevertedState): TurnRevertedState {
  const turns: Array<[number, Record<string, number>]> = []
  for (const [key, paths] of Object.entries(state.turns)) {
    const turn = Number(key)
    if (!usableTurn(turn) || paths === null || typeof paths !== 'object' || Array.isArray(paths)) continue
    const clean: Record<string, number> = {}
    for (const [path, at] of Object.entries(paths)) {
      if (path === '' || typeof at !== 'number' || !Number.isFinite(at)) continue
      clean[path] = at
    }
    if (Object.keys(clean).length === 0) continue
    turns.push([turn, clean])
  }
  turns.sort((left, right) => left[0] - right[0])
  const kept = turns.slice(Math.max(0, turns.length - TURN_REVERTED_MAX_TURNS))
  // Flatten, keep the newest entries, regroup.
  const entries: Array<{ turn: number; path: string; at: number }> = []
  for (const [turn, paths] of kept) {
    for (const [path, at] of Object.entries(paths)) entries.push({ turn, path, at })
  }
  entries.sort((left, right) => left.at - right.at || left.turn - right.turn || left.path.localeCompare(right.path))
  const trimmed = entries.slice(Math.max(0, entries.length - TURN_REVERTED_MAX_PATHS))
  const next: TurnRevertedState = { v: 1, turns: {} }
  for (const entry of trimmed) {
    const bucket = next.turns[String(entry.turn)] ?? (next.turns[String(entry.turn)] = {})
    bucket[entry.path] = entry.at
  }
  return next
}

/**
 * 解析持久化的一串 JSON。
 *
 * 任何畸形输入都给空状态而不是抛错；只接受 `v: 1`（未来换形状时旧数据自然作废，
 * 不会把两种含义混着读），其余交给 {@link pruneTurnReverted} 清洗与收敛。
 */
export function parseTurnReverted(raw: string | null | undefined): TurnRevertedState {
  if (typeof raw !== 'string' || raw === '') return EMPTY_TURN_REVERTED
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY_TURN_REVERTED
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY_TURN_REVERTED
  const record = parsed as { v?: unknown; turns?: unknown }
  const turns = record.turns
  if (turns === null || typeof turns !== 'object' || Array.isArray(turns)) return EMPTY_TURN_REVERTED
  // `v` is tolerated as missing (an older write), but a DIFFERENT version is refused.
  if (record.v !== undefined && record.v !== 1) return EMPTY_TURN_REVERTED
  return pruneTurnReverted({ v: 1, turns: turns as Record<string, Record<string, number>> })
}

/** 序列化（条数已受上限约束，所以这串不会无限长）。 */
function serializeTurnReverted(state: TurnRevertedState): string {
  return JSON.stringify(state)
}

/** 记一条（不碰存储；返回新状态）。 */
function markTurnRevertedIn(
  state: TurnRevertedState,
  turn: number,
  path: string,
  at: number,
): TurnRevertedState {
  if (!usableTurn(turn) || path === '') return state
  const turns: Record<string, Record<string, number>> = {}
  for (const [key, paths] of Object.entries(state.turns)) turns[key] = { ...paths }
  const bucket = turns[String(turn)] ?? (turns[String(turn)] = {})
  bucket[path] = Number.isFinite(at) && at > 0 ? at : Date.now()
  return pruneTurnReverted({ v: 1, turns })
}

/** 这一轮里这个路径是否已被撤销。 */
function isTurnRevertedIn(state: TurnRevertedState, turn: number, path: string): boolean {
  if (!usableTurn(turn) || path === '') return false
  const bucket = state.turns[String(turn)]
  return bucket !== undefined && bucket[path] !== undefined
}

/** 这一轮被撤销过的全部路径（面板过滤用一次读，避免逐行读存储）。 */
function turnRevertedPathsIn(state: TurnRevertedState, turn: number): ReadonlySet<string> {
  if (!usableTurn(turn)) return EMPTY_PATHS
  const bucket = state.turns[String(turn)]
  return bucket === undefined ? EMPTY_PATHS : new Set(Object.keys(bucket))
}

const EMPTY_PATHS: ReadonlySet<string> = new Set()

/**
 * 默认存储：`window.localStorage`，取不到（无 DOM / 私有模式抛错）就返回 undefined。
 *
 * 每次现取而不是模块加载时取：测试与非浏览器环境里 `localStorage` 可能后出现或抛错。
 */
function defaultStorage(): RevertedStorage | undefined {
  try {
    const storage = (globalThis as { localStorage?: RevertedStorage }).localStorage
    return storage !== undefined && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
      ? storage
      : undefined
  } catch {
    return undefined
  }
}

/** 读一个会话的状态；storage 拒绝回答时给空状态。 */
function loadTurnReverted(
  sessionId: string,
  storage: RevertedStorage | undefined = defaultStorage(),
): TurnRevertedState {
  if (sessionId === '' || storage === undefined) return EMPTY_TURN_REVERTED
  try {
    return parseTurnReverted(storage.getItem(turnRevertedStorageKey(sessionId)))
  } catch {
    return EMPTY_TURN_REVERTED
  }
}

/**
 * 写一个会话的状态；存不下就算了（最多多显示一行，绝不能打断撤销流程）。
 *
 * @returns 是否真的写进去了 —— 调用方（`markTurnReverted`）据它回答"记下了"，而不是
 *   把"心里记下了"当成"存下了"（私有模式下一次刷新就没了）。
 */
function saveTurnReverted(
  sessionId: string,
  state: TurnRevertedState,
  storage: RevertedStorage | undefined = defaultStorage(),
): boolean {
  if (sessionId === '' || storage === undefined) return false
  try {
    storage.setItem(turnRevertedStorageKey(sessionId), serializeTurnReverted(state))
    return true
  } catch {
    // 私有模式 / 配额满：见上。
    return false
  }
}

/**
 * 记一条撤销（读 → 记 → 写，一次完成）。
 *
 * @returns 是否真的写进了存储（无 session / 无 turn / 无 storage 时为 false）。
 */
export function markTurnReverted(
  sessionId: string,
  turn: number | undefined,
  path: string,
  storage: RevertedStorage | undefined = defaultStorage(),
  at: number = Date.now(),
): boolean {
  if (sessionId === '' || path === '' || turn === undefined || !usableTurn(turn) || storage === undefined) return false
  const next = markTurnRevertedIn(loadTurnReverted(sessionId, storage), turn, path, at)
  // Both must hold: the mark is in the state AND it reached the storage. A storage
  // that refuses (private mode) must not answer "remembered" — the next reload
  // would show the row again.
  return saveTurnReverted(sessionId, next, storage) && isTurnRevertedIn(next, turn, path)
}

/** 这一轮被撤销过的全部路径（面板每次渲染读一次，见调用方的注释）。 */
export function loadTurnRevertedPaths(
  sessionId: string,
  turn: number | undefined,
  storage: RevertedStorage | undefined = defaultStorage(),
): ReadonlySet<string> {
  if (turn === undefined) return EMPTY_PATHS
  return turnRevertedPathsIn(loadTurnReverted(sessionId, storage), turn)
}

/**
 * 撤销**一处**改动之后，这个文件在本轮是否已经没有任何剩余改动（因而可以从列表隐藏）？
 *
 * 判据只有两条，缺一不可（审核补充的易错点）：
 * - 这批标记必须来自**本轮轴**（会话累计轴不参与，否则会把一个文件整轮的历史藏掉）；
 * - 该文件的 ChangeSet 必须**只有一个 hunk** —— 撤掉这一处就等于撤掉了这一轮对它的
 *   全部改动。多 hunk 的部分撤销不隐藏：那会把剩下的改动一起藏掉，比现状更糟。
 *
 * @param scope - 标记来源轴（`ChangeOrigin.scope`）。
 * @param hunkCount - 该文件 ChangeSet 里的 hunk 数（`patches.length`）。
 */
export function hunkRevertClearsTurn(scope: 'session' | 'turn' | undefined, hunkCount: number): boolean {
  return scope === 'turn' && Number.isFinite(hunkCount) && hunkCount === 1
}
