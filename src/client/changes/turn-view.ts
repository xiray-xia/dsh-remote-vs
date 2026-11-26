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

import type { RemoteChangesDiff, RemoteChangesTurnView } from '../../protocol.ts'

/** 面板当前按哪条轴列出改动。 */
export type ChangeScope = 'session' | 'turn'

/**
 * 作用域存在 `localStorage` 的哪个键下。
 *
 * 与审阅标记（`rvs.changes.reviewed.<session>`）同一族：这是"我想怎么读"，
 * 不是远端事实，所以既不是协议字段，也不进账本。
 */
export const CHANGE_SCOPE_STORAGE_KEY = 'rvs.changes.scope'

/** 存档里的作用域文本；任何认不出来的值都回到默认的会话累计。 */
export function parseChangeScope(raw: string | null | undefined): ChangeScope {
  return raw === 'turn' ? 'turn' : 'session'
}

/** 反过来写存档（当前只有两种取值，不做编码）。 */
export function serializeChangeScope(scope: ChangeScope): string {
  return scope
}

/**
 * 本轮视图是否可用。
 *
 * `turn === 0` 表示这份账本还没有关闭过任何轮次：此时 `turnView` 不该出现，
 * 出现了也没有「上一轮」可比，一律按不可用处理（面板停在会话累计）。
 */
export function turnScopeAvailable(view: RemoteChangesTurnView | undefined): boolean {
  return view !== undefined && view.turn > 0
}

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
export type TurnOutcome =
  | { action: 'use'; diff: RemoteChangesDiff }
  | { action: 'binary' }
  | { action: 'fallback'; noteKey: string }
  | { action: 'closed'; noteKey: string; detail?: string }

/** 这里给出的键都要在 `DYNAMIC_KEYS` 里登记（调用点传的是变量，扫描器看不见）。 */
const NOTE = {
  statsOnly: 'changes.turnStatsOnly',
  unavailable: 'changes.turnUnavailable',
  stale: 'changes.turnStaleFallback',
  missing: 'changes.diffMissing',
  truncated: 'changes.diffTruncated',
  empty: 'changes.diffEmpty',
} as const

/**
 * 判定一次点击。
 *
 * @param diff - `api.changes.turnDiff` 的答案（`null` = 没拿到；本轮没缓存时
 *   调用方不必发请求，直接传 null）。
 * @param view - 当前 summary 里的 `turnView`；`cached: false` 时一切都只能"只有统计"。
 */
export function turnOutcomeOf(
  diff: RemoteChangesDiff | null,
  view: RemoteChangesTurnView | undefined,
): TurnOutcome {
  if (view === undefined || view.cached !== true) {
    // The host published turn totals but no per-file contents (memory budget or
    // the file cap): nothing to paint, and the reason rides along for the panel.
    const detail = view?.reason
      ?? (diff !== null && diff.kind === 'unavailable' ? diff.reason : undefined)
    return { action: 'closed', noteKey: NOTE.statsOnly, ...(detail === undefined ? {} : { detail }) }
  }
  if (diff === null) return { action: 'closed', noteKey: NOTE.unavailable }
  if (diff.kind === 'stale') {
    return { action: 'fallback', noteKey: NOTE.stale }
  }
  if (diff.kind === 'unavailable') {
    return { action: 'closed', noteKey: NOTE.unavailable, ...(diff.reason === undefined ? {} : { detail: diff.reason }) }
  }
  if (diff.kind === 'binary') return { action: 'binary' }
  if (diff.kind === 'missing') return { action: 'closed', noteKey: NOTE.missing }
  if (diff.truncated === true) return { action: 'closed', noteKey: NOTE.truncated }
  if (diff.hunks.length === 0) return { action: 'closed', noteKey: NOTE.empty }
  return { action: 'use', diff }
}

/** 点完一行之后，作用域要不要动。 */
export interface ScopeAfterOutcome {
  scope: ChangeScope
  /**
   * 切轴时是否**保留**那句提示。
   *
   * `stale` 的处置是"把视图切回会话累计"，而解释这件事的那句话如果被切轴顺手清掉，
   * 用户只会看到列表静默换了一套数字（审核 M1）。所以这一种结局必须保留提示。
   */
  keepNote: boolean
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
export function scopeAfterOutcome(outcome: TurnOutcome, current: ChangeScope): ScopeAfterOutcome {
  if (outcome.action === 'fallback') return { scope: 'session', keepNote: true }
  return { scope: current, keepNote: false }
}
