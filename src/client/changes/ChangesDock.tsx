/**
 * The session change panel above the composer (the Cursor-style review list).
 *
 * Placement is the point: `conversation.input.dock` is the one full-width seat
 * the shell renders directly above the composer card — the todo, goal and queue
 * panels already live there — so the list is visible while the user types the
 * next instruction instead of being scrolled away in the conversation.
 *
 * Data comes from the plugin's own ledger (`/api/dsh-remote/changes`), not from
 * DSH's `workspaceChanges`: that recorder cannot see a routed session at all
 * (its git baseline is parsed with host path semantics and its scratch index is
 * written with `node:fs`), which the probe measured as 58 remote sessions with
 * zero change events.
 *
 * Three things happen here, and they are deliberately different in kind:
 * - a row's LEFT click opens the file and hands the editor the same hunks, so the
 *   changed lines are painted in place;
 * - a row's RIGHT click offers the writes ("revert everything this session did to
 *   this file", "undo a tracked creation") plus the navigation shortcuts. The
 *   host decides which of those exist (`RemoteChangedFile.revert`), because only
 *   git knows whether a creation has a copy to fall back on;
 * - the ✓ on a row is a LOCAL review note (`review-state.ts`): it writes nothing,
 *   it is what makes a thirty-file refactor converge.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.ts'
import {
  applyChangeSet,
  bootstrap,
  followSessionWorkspace,
  openChangeDiff,
  openRemoteFileInBinding,
  refreshAll,
  remoteOpenBindings,
  revertFileChanges,
  sessionRepoSubdir,
  setFollowSession,
  setView,
  syncChangeSetStaleness,
  useExplorer,
  workspaceMatchesSession,
} from '../store.tsx'
import { bindingForChangedFile } from '../remote-file-open-target.ts'
import { useRemoteChatTarget } from '../use-remote-chat-target.ts'
import type { RemoteChangedFile, RemoteChangesDiff, RemoteChangesSummary, RemoteChangesTurnView } from '../../protocol.ts'
import type { ChangeSet } from './model.ts'
import { canShowChangeDiff } from './session-diff.ts'
import { changeSetFromDiff, diffNoticeKey, type DiffNotice } from './diff-outcome.ts'
import {
  CHANGE_SCOPE_STORAGE_KEY,
  parseChangeScope,
  scopeAfterOutcome,
  serializeChangeScope,
  turnOutcomeOf,
  turnScopeAvailable,
  turnFullyReverted,
  visibleTurnRows,
  type ChangeScope,
} from './turn-view.ts'
import { loadTurnRevertedPaths } from './turn-reverted.ts'
import {
  isReviewed,
  nextUnreviewed,
  parseReviewed,
  pruneReviewed,
  reviewKeyOf,
  reviewedCount,
  serializeReviewed,
  setAllReviewed,
  toggleReviewed as toggleReviewedEntry,
} from './review-state.ts'
import { setUndoContext } from './undo-context.ts'
import { forgetChangeOrigin, publishableUndoOrigin, rememberChangeOrigin } from './undo-target.ts'
import { ContextMenu, FileIcon, copyText, useContextMenu } from '../vsc/kit.tsx'
import './changes.css'

/** How often an open panel re-reads the ledger (the host refreshes it per turn). */
const POLL_MS = 3000

/**
 * While the list is FOLDED, read the ledger only every Nth poll (15 s).
 *
 * The folded panel still shows its header (file count, +/− totals, the
 * "pending" badge), so the poll cannot simply stop: the header would then keep
 * describing an older turn. A fifth of the cadence keeps it honest without
 * paying a loopback POST (and, through the host's ledger `touch`, a tracked
 * git scan every 30 s) four times a second-old counter does not need.
 *
 * A HIDDEN page is different and skips the tick entirely: nothing on screen can
 * change, and `visibilitychange` catches up at once when it is shown again.
 * Manual ⟳ (`load(true)`) and the first read are never gated.
 */
const FOLDED_POLL_SKIP = 5

/**
 * While the panel renders NOTHING (`!visible` below and no error — no summary
 * yet, or none of files/pending/unavailable), patrol the ledger only every Nth
 * poll (60 s).
 *
 * It cannot simply stop: the panel's own visibility is DERIVED from the answer it
 * polls for, so a stopped poll would never discover the first change of the next
 * turn and the dock would never come back. The cadence is cut because a parked
 * dock (another view in the sidebar, a session with no changes) must not pay a
 * loopback POST plus the host's ledger touch every 15 s, while 60 s is still fast
 * enough to surface new work without a manual refresh. The first read, the manual
 * ⟳ and the fold/unfold re-read are not gated at all.
 */
/**
 * The dock is not rendered at all when there is nothing to show, but it must
 * still notice the next change: one read every 30 s is the compromise between
 * "a new change surfaces promptly" and "a hidden panel costs nothing".
 */
const INVISIBLE_POLL_SKIP = 10

/**
 * Where the review marks are remembered, per session.
 *
 * `localStorage`, like the port-forward rules: this is a note about the user's own
 * reading progress, not a fact about the remote tree, so it must survive a page
 * reload without becoming a protocol field nobody else needs.
 */
const REVIEW_STORAGE_PREFIX = 'rvs.changes.reviewed.'

/** 空集合：非本轮模式不该每次渲染都分配一个新的 Set（`visibleTurnRows` 只读它）。 */
const EMPTY_REVERTED_PATHS: ReadonlySet<string> = new Set()

/**
 * How many polls between two follow retries (5 × 3 s = one probe every 15 s).
 *
 * The follow is one cheap HTTP call and it is retried until it resolves, so it
 * must NOT ride the ledger's 3 s cadence: a session whose workspace cannot be
 * resolved would otherwise cost a probe per poll, forever.
 */
const FOLLOW_RETRY_TICKS = 5

/**
 * Props the composer dock hands us.
 *
 * Typed narrowly on purpose: the slot's full owner/standard prop surface comes
 * from `dsh-client-ui-conversation`, and depending on that package for types
 * drags a second DSH chain into this repo (same reason `conversation.view` is
 * soft-typed in index.tsx). Everything else is read from the plugin's own store.
 */
export interface ChangesDockProps {
  /** `SessionSnapshot` (the client contract names it `sessionId`, not `id`). */
  session?: { sessionId?: string; id?: string }
  sessionId?: string
}

/** One row's status, spelled out for the tooltip (the row itself shows counts). */
function statusWord(file: RemoteChangedFile, t: (key: string) => string): string {
  if (file.status === 'A') return t('changes.statusAdded')
  if (file.status === 'D') return t('changes.statusDeleted')
  if (file.status === 'R') return t('changes.statusRenamed')
  return t('changes.statusModified')
}

/** Split a display path into its directory prefix and file name. */
function splitDisplay(display: string): { dir: string; name: string } {
  const at = display.lastIndexOf('/')
  return at < 0 ? { dir: '', name: display } : { dir: display.slice(0, at + 1), name: display.slice(at + 1) }
}

/** Read one session's review marks, tolerating a storage that refuses to answer. */
function loadReviewed(sessionId: string | undefined): Record<string, 1> {
  if (sessionId === undefined || sessionId === '') return {}
  try {
    return parseReviewed(window.localStorage.getItem(`${REVIEW_STORAGE_PREFIX}${sessionId}`))
  } catch {
    // Private mode / disabled storage: the marks simply do not persist.
    return {}
  }
}

/** 读上次选择的作用域；读不出来就是默认的会话累计。 */
function loadScope(): ChangeScope {
  try {
    return parseChangeScope(window.localStorage.getItem(CHANGE_SCOPE_STORAGE_KEY))
  } catch {
    // Private mode / disabled storage: the choice simply does not persist.
    return 'session'
  }
}

function saveScope(scope: ChangeScope): void {
  try {
    window.localStorage.setItem(CHANGE_SCOPE_STORAGE_KEY, serializeChangeScope(scope))
  } catch {
    // Same trade as the review marks: persistence is the only thing lost.
  }
}

/**
 * 「本轮 #N · HH:MM」——时间用本机时区的时:分，标签短到能和文件数并排。
 *
 * 带上 `#N` 是刻意的：`turnView` 描述的是**最近一个已完成轮次**，而面板的
 * `summary.turn` 可能已经翻到下一轮（那一轮还没结束）。数字不一致时用户看到的是
 * "本轮还在跑"，而不是一份被悄悄标错的列表。
 */
function turnTitle(t: (key: string) => string, view: RemoteChangesTurnView): string {
  const at = new Date(view.at)
  const time = Number.isNaN(at.getTime())
    ? ''
    : `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return t('changes.turnTitle').replace('{turn}', String(view.turn)).replace('{time}', time)
}

export function ChangesDock(props: ChangesDockProps): React.ReactNode {
  const explorer = useExplorer()
  // The dock is a second surface of the same store as the explorer, and it can
  // mount without the explorer ever being opened — without this the workspace
  // list would be empty and a click could not resolve its binding.
  useEffect(() => {
    if (explorer.ctx !== undefined) bootstrap(explorer.ctx)
  }, [explorer.ctx])
  const t = explorer.t
  const sessionId = props.sessionId ?? props.session?.sessionId ?? props.session?.id
  /**
   * The last answer, TAGGED with the session it belongs to.
   *
   * One panel serves whichever session is on screen, so an untagged summary
   * survives a session switch and keeps describing the previous conversation —
   * which is exactly how a stale "computing…" from another session appeared in
   * a session whose own ledger had not even been created yet.
   */
  const [data, setData] = useState<{ id: string; summary: RemoteChangesSummary | null } | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  // Collapsed by default: the header already carries the file count and the totals,
  // and the list is one click away — a turn that touched twenty files should not
  // push the composer off the screen.
  const [collapsed, setCollapsed] = useState(true)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  /**
   * 上一次点行留下的"这份 diff 是哪一种结局"的说明（二进制 / 读不到 / 已被改回 /
   * 只给了前缀）。一次只留一条：它描述的就是刚才那一次点击，换一行就该换说法。
   */
  const [diffNotice, setDiffNotice] = useState<{ path: string; notice: DiffNotice } | undefined>(undefined)
  /**
   * 面板按哪条轴列改动：会话累计（默认）还是最近一个已完成轮次。
   *
   * 选择存在浏览器本地（`CHANGE_SCOPE_STORAGE_KEY`）：它描述的是"我想怎么看"，
   * 不是远端事实。默认必须是 `session` —— 那是这个面板一直以来的语义。
   */
  const [scope, setScope] = useState<ChangeScope>(loadScope)
  /** 本轮模式下这次点击"为什么没画标记 / 为什么回退"的那句话（不静默）。 */
  const [scopeNote, setScopeNote] = useState<{ key: string; detail?: string } | undefined>(undefined)
  /** This session's local review marks (see `review-state.ts`). */
  const [reviewed, setReviewed] = useState<Record<string, 1>>(() => loadReviewed(sessionId))
  /**
   * 「只看未审阅」的过滤开关（纯组件状态）。
   *
   * It is a reading posture for THIS pass ("I only care about what is left"),
   * not a fact about the remote tree, so it is neither persisted nor sent: a
   * freshly mounted panel starts by showing the whole list.
   */
  const [onlyUnreviewed, setOnlyUnreviewed] = useState(false)
  /** 审阅游标：最近一次打开/跳到的行（`reviewKeyOf` 的键）。 */
  const [cursorKey, setCursorKey] = useState<string | undefined>(undefined)
  /** 行元素（键同游标），供「跳到下一个未审阅」把目标滚进视野。 */
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const alive = useRef(true)
  // Mirrors "the panel renders something" for the poll tick: adding that as an
  // effect dependency would rebuild the interval (and pay a re-read) every time
  // the panel appears or disappears, which is not what the cadence is about.
  const visibleRef = useRef(false)
  const currentSession = useRef(sessionId)
  currentSession.current = sessionId
  const rowMenu = useContextMenu()
  const reviewMenu = useContextMenu()
  // The Source Control panel's repository directory, resolved at call time: it is
  // the user's explicit answer to "which repository in this workspace", and it
  // outranks the host's one-level guess. A ref (not a value) so a change made
  // while this panel is open is picked up by the next poll.
  //
  // It is stored PER BINDING, so it may only be sent while the sidebar's
  // selection can be PROVEN to be THIS session's binding (see the store's
  // `sessionRepoSubdir`). Otherwise the host is told to `cd` into
  // `session root + another workspace's sub-directory`, answers `session
  // directory is missing on the host` (exit 90), the panel never gets a summary
  // and repeats the same wrong guess on the next poll — the reported loop. `''`
  // is always a truthful instruction (session root + the host's own
  // unique-candidate probe); a foreign directory never is.
  const repoSubdirOf = (): string => sessionRepoSubdir(sessionId)

  const load = useCallback(async (force = false): Promise<void> => {
    if (sessionId === undefined || sessionId === '') return
    const asked = sessionId
    try {
      const next = await api.changes.list(asked, force, repoSubdirOf())
      // Two guards: the panel may be gone, and the user may have switched
      // sessions while this was in flight — a late answer for the old session
      // must not be filed under the new one.
      if (!alive.current || currentSession.current !== asked) return
      setData({ id: asked, summary: next })
      setError(undefined)
      // 新的统计列表是"屏幕上那批标记还算不算数"的唯一证据：行数/状态变了或文件
      // 从列表消失，就给对应标签页打既有那张「位置已过期」。不发起远端读。
      if (next !== null) {
        syncChangeSetStaleness(asked, next.files, next.truncated === true, next.at, next.turnView)
      }
    } catch (problem) {
      if (!alive.current || currentSession.current !== asked) return
      setError(problem instanceof Error ? problem.message : String(problem))
    }
  }, [sessionId])
  const summary = data !== null && data.id === sessionId ? data.summary : null

  useEffect(() => {
    alive.current = true
    // The first read (and the manual ⟳, which calls `load(true)` directly) is
    // deliberately NOT gated: it is what paints the panel after a session
    // switch or a cold page.
    void load()
    let ticks = 0
    const timer = window.setInterval(() => {
      // A background tab costs a loopback POST every 3 s without any possible
      // visible change; skip the tick outright. The listener below is what makes
      // the panel catch up the moment it is shown again.
      if (document.hidden) return
      ticks += 1
      // An unrendered panel is slower than a folded one: it still has to look for
      // the next turn's changes (see INVISIBLE_POLL_SKIP), just not at the folded
      // cadence. The first read, the fold re-read and the manual ⟳ stay outside
      // this tick.
      const skip = visibleRef.current ? (collapsed ? FOLDED_POLL_SKIP : 1) : INVISIBLE_POLL_SKIP
      if (skip > 1 && ticks % skip !== 0) return
      void load()
    }, POLL_MS)
    // Shown again, or unfolded: read at once instead of waiting for the next
    // tick (a folded panel may be up to 15 s stale by design). `collapsed` is a
    // dependency, so folding/unfolding also re-runs this effect and reloads.
    const wake = (): void => { if (!document.hidden) void load() }
    document.addEventListener('visibilitychange', wake)
    return () => {
      alive.current = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [load, collapsed])

  // A different conversation has different marks (and its own place in the
  // list): reload instead of carrying one session's ✓ / cursor onto another's
  // files.
  useEffect(() => {
    setReviewed(loadReviewed(sessionId))
    setCursorKey(undefined)
  }, [sessionId])

  /**
   * Publish the revert coordinates for the tab the user is LOOKING AT.
   *
   * The marks belong to one tab and one binding; the revert is the only user
   * action that writes to the remote, so the slot must never be "whatever this
   * panel last saw". `publishableUndoOrigin` re-checks the marks' session against
   * this panel's session, the binding identity (alias alone is not one: two
   * bindings can share a host alias) and the path against the recorded ledger
   * root, and answers `undefined` when anything fails — the store's undo path
   * then refuses instead of guessing.
   *
   * Runs on every store snapshot (tabs included) and on active-tab changes, so a
   * tab switch republishes before a click can reach the button.
   */
  useEffect(() => {
    const tab = explorer.tabs.find(candidate => candidate.id === explorer.activeTabId)
    setUndoContext(publishableUndoOrigin({
      tabId: explorer.activeTabId,
      tabPath: tab?.fullPath,
      panelSessionId: sessionId,
      bindings: remoteOpenBindings().bindings,
    }))
  }, [sessionId, explorer.activeTabId, explorer.tabs, explorer.workspaces])

  useEffect(() => () => { setUndoContext(undefined) }, [])

  /**
   * Register this session and start the follow — with no help from the sidebar.
   *
   * The follow used to be driven only by surfaces that already HELD evidence
   * (the sidebar's workspace membership, this panel's own summary). Before the
   * panel's FIRST successful scan neither exists, so the session's workspace
   * stayed unknown while the panel still had to name a repository directory:
   * it sent the selected workspace's sub-directory, the host answered exit 90,
   * no summary arrived, and the next poll repeated it. The store now resolves
   * the session's own cwd (available from the first paint) and the panel
   * retries on a SLOW timer, so a resolution that needs the workspace table to
   * land is picked up without a probe per poll.
   */
  useEffect(() => {
    setFollowSession(sessionId)
    if (sessionId === undefined || sessionId === '') return
    void followSessionWorkspace({ sessionId })
    let ticks = 0
    const timer = window.setInterval(() => {
      ticks += 1
      if (ticks % FOLLOW_RETRY_TICKS !== 0) return
      // Resolved — or the user picked a workspace by hand, which stands: stop
      // probing entirely rather than re-asking a settled question.
      if (workspaceMatchesSession()) {
        window.clearInterval(timer)
        return
      }
      void followSessionWorkspace({ sessionId })
    }, POLL_MS)
    return () => { window.clearInterval(timer) }
  }, [sessionId])

  // The binding table arrives asynchronously (the bootstrap above), and a follow
  // attempted before it landed resolves nothing. Retry the moment it does,
  // instead of waiting out the slow timer.
  useEffect(() => {
    if (sessionId === undefined || sessionId === '') return
    void followSessionWorkspace({ sessionId })
  }, [sessionId, explorer.ready, explorer.workspaces, explorer.aliasPaths])

  /**
   * Follow the session's workspace from the panel's own evidence.
   *
   * The panel holds the host's alias + remote root for THIS session, so it can
   * point the sidebar (and the editor's workspace selector, which reads the same
   * store) at the right binding even when the cwd probe found nothing — and it
   * is the surface that is mounted whenever a conversation is. Only the session
   * actually on screen may steer the selector, and only once per session (the
   * store's policy), so a parked dock cannot move it.
   */
  const chatTarget = useRemoteChatTarget(explorer.ctx)
  useEffect(() => {
    if (sessionId === undefined || summary === null || summary.root === '') return
    if (chatTarget.sessionId === undefined || chatTarget.sessionId !== sessionId) return
    void followSessionWorkspace({ sessionId, alias: summary.alias, remoteRoot: summary.root })
  }, [sessionId, summary, chatTarget.sessionId])

  /**
   * 会话累计的行永远是这份 summary 的 `files`；本轮是 `turnView.files`。
   *
   * `turnMode` 还要求 Host 真的给了可用的一轮（`turn > 0`）：没关闭过轮次、或者
   * 客户端连的是更老的 Host 时，作用域选择自动退回会话累计 —— 面板不能因为一个
   * 存下来的偏好就空着。
   */
  const sessionFiles = useMemo(() => summary?.files ?? [], [summary])
  const turnView = summary?.turnView
  const turnFiles = useMemo(() => turnView?.files ?? [], [turnView])
  const turnMode = scope === 'turn' && turnScopeAvailable(turnView)
  /**
   * 「本轮里这个文件已被撤销」的客户端记账（见 `changes/turn-reverted.ts`）。
   *
   * 每次渲染**现读**（读操作，不写）：撤销发生在 store 里，store 一定会 patch 快照让
   * 面板重渲染，所以这里不需要额外的订阅/事件，重渲染时就能看到最新记录；宿主冻结的
   * `turnView` 本身永远不变。会话累计模式不读这个存储。
   */
  const revertedPaths = turnMode && turnView !== undefined && sessionId !== undefined
    ? loadTurnRevertedPaths(sessionId, turnView.turn)
    : EMPTY_REVERTED_PATHS
  /**
   * 可见行：宿主冻结的行里去掉"本轮已撤销"的那些。文件数、`+a −b`、✓ 的分母、
   * 「下一个未审阅」都必须用这一份，否则会留下"列表只剩一行、合计还是三行"的残影。
   */
  const turnRows = turnMode ? visibleTurnRows(turnFiles, revertedPaths) : undefined
  const files = turnMode ? (turnRows?.visible ?? []) : sessionFiles
  /** 被隐藏的行数（仅本轮模式；>0 时面板给一句说明）。 */
  const hiddenRows = turnRows?.hidden ?? 0
  /**
   * 「本轮改动已全部撤销」只有在视图完整时才成立：`truncated`（有行因上限/未知侧/
   * 未校正被丢弃）或 `pending`（慢扫描还没落地）时，"可见行为 0"只证明"看到的都撤了"，
   * 不证明"这一轮已经没有改动"——说出口会与同屏的「视图不完整 / 还在等扫描」矛盾。
   */
  const allReverted = turnMode && turnView !== undefined && turnFullyReverted({
    visible: files.length,
    hidden: hiddenRows,
    ...(turnView.truncated === true ? { truncated: true as const } : {}),
    ...(turnView.pending === true ? { pending: true as const } : {}),
  })
  /**
   * 审阅标记是按"行数 + 状态"建键的，两种视图对同一文件给出的数字按定义不同。
   *
   * 清理/切换标记时按**两份列表的并集**来判：只用当前视图那张表，切一次作用域就会
   * 把另一边的 ✓ 全删掉，而它们描述的是另一条轴上仍然有效的审阅。
   */
  const reviewable = useMemo(
    () => (turnFiles.length === 0 ? sessionFiles : [...sessionFiles, ...turnFiles]),
    [sessionFiles, turnFiles],
  )

  /**
   * 切换作用域。
   *
   * @param keepNote - `stale` 回退时保留那句解释（见 `scopeAfterOutcome`）：否则
   *   用户只会看到列表静默换轴（审核 M1）。其余切换照常清掉上一条"为什么没标记"的
   *   说明，它描述的是上一次点击、且属于另一个轴。
   */
  const switchScope = useCallback((next: ChangeScope, keepNote = false): void => {
    setScope(next)
    saveScope(next)
    if (!keepNote) setScopeNote(undefined)
    setDiffNotice(undefined)
    setCursorKey(undefined)
  }, [])

  /**
   * Resolve the binding a row belongs to, with one refresh for a cold page.
   *
   * The store may still be loading its workspace table on a cold page, so a miss
   * is worth one refresh before giving up.
   */
  const bindingOf = useCallback(async (file: RemoteChangedFile) => {
    if (summary === null) return undefined
    let binding = bindingForChangedFile(remoteOpenBindings(), summary, file.path)
    if (binding === undefined) {
      refreshAll()
      await new Promise(resolve => { window.setTimeout(resolve, 300) })
      binding = bindingForChangedFile(remoteOpenBindings(), summary, file.path)
    }
    return binding
  }, [summary])

  /**
   * Paint one row's comparison into the editor (both scopes end up here).
   *
   * Everything after `diff` is scope-agnostic on purpose: the editor only ever
   * receives hunks, the review marks only ever carry counts, and the revert
   * coordinates are the ones the comparison came from — so the two axes differ in
   * WHICH comparison is fetched, not in how it is shown.
   *
   * @param notice - a conclusion the panel must state although no marks will be
   *   painted (`oversized` / `binary` rows: the comparison was not even fetched).
   * @param quiet - 调用方已经用 `scopeNote` 说清了这次点击的处置（例如「本轮只有统计」），
   *   不要再叠一句 `diff-outcome` 的结论：两句会互相拆台（"没有块标记" vs "远端读不到"）。
   */
  const attachMarks = useCallback(async (
    file: RemoteChangedFile,
    diff: RemoteChangesDiff | null,
    stamp: string,
    origin: { scope: ChangeScope; turn?: number },
    notice?: DiffNotice,
    quiet = false,
  ): Promise<void> => {
    if (sessionId === undefined || summary === null) return
    // 行数/状态/块标识一起带下去：面板的轮询要用行数判断这批标记是否过期
    // （`syncChangeSetStaleness`），编辑器要用**远端绝对路径**命名「确认保留」
    // 的块。被字节上限扣下的 diff 不建标记（审核 M2），只给结论。
    const built = changeSetFromDiff(diff, stamp, {
      path: file.path,
      ...(file.status === undefined ? {} : { status: file.status }),
    })
    const set: ChangeSet = built.set
    // 二进制 / 过大 / 读不到 / 已被改回 / 截断：屏幕上不会出现标记，必须当面说清
    // 是哪一种，而不是留下一片空白让人以为"没改动"。
    if (notice !== undefined) setDiffNotice({ path: file.path, notice })
    else if (!quiet && built.notice !== undefined) setDiffNotice({ path: file.path, notice: built.notice })
    // Resolved by the session's REMOTE root, never by the alias alone: one
    // alias carries several bindings (two workspaces can live on one alias),
    // and the alias-only form picked whichever came first —
    // the file opened while the tree and the selector stayed on the other
    // workspace. That was the reported bug.
    const binding = await bindingOf(file)
    if (binding === undefined) {
      explorer.info(t('changes.noWorkspace'))
      return
    }
    openRemoteFileInBinding(binding.id, file.path, set.hunks[0] === undefined ? {} : { line: set.hunks[0] })
    // The tab id is deterministic (store.openFile builds it the same way), so
    // the marks can be attached without waiting for the file read to settle.
    const tabId = `file:${binding.alias}:${file.path}`
    applyChangeSet(tabId, set)
    // Remember WHERE these marks came from, once: the revert coordinates are
    // read back from here (`publishableUndoOrigin`) instead of from the last
    // summary this panel happened to render. No real hunk = no revert target,
    // so a binary/failed diff forgets the previous provenance instead of
    // leaving an older one around.
    // 被字节上限扣下的 diff 没有可撤销的补丁（每个 hunk patch 都是 ''）：既不能
    // 标标记，也不能留 provenance，否则悬浮撤销会指向一次注定失败的远端写。
    if (diff !== null && diff.kind === 'text' && diff.truncated !== true && diff.hunks.length > 0) {
      rememberChangeOrigin(tabId, {
        sessionId,
        bindingId: binding.id,
        alias: binding.alias,
        root: summary.root,
        scope: origin.scope,
        ...(origin.turn === undefined ? {} : { turn: origin.turn }),
      })
    } else {
      forgetChangeOrigin(tabId)
    }
  }, [bindingOf, explorer, sessionId, summary, t])

  /** Open one listed file in the remote editor with its change marks. */
  const openChanged = useCallback(async (file: RemoteChangedFile): Promise<void> => {
    if (sessionId === undefined || summary === null) return
    // Opening a row also moves the review cursor, so 「跳到下一个未审阅」continues
    // from whatever the user just looked at (a click, a menu entry or a jump)
    // instead of from wherever the last jump happened to stop.
    setCursorKey(reviewKeyOf(file))
    setBusy(file.path)
    setDiffNotice(undefined)
    setScopeNote(undefined)
    try {
      if (turnMode && turnView !== undefined) {
        const turnOrigin = { scope: 'turn' as const, turn: turnView.turn }
        // The stamp carries the axis and the turn: a saved turn comparison and a
        // session comparison of the same file are different data.
        const turnStamp = `${file.path}@turn${turnView.turn}@${turnView.at}`
        /**
         * 只有统计的一轮（内容超出内存预算 / 文件上限）：不发请求，打开文件并说明
         * 原因。列表行已经给出真实增删数，但没有可画的 hunk，也没有可撤销的补丁。
         */
        if (turnView.cached !== true) {
          setScopeNote({
            key: 'changes.turnStatsOnly',
            ...(turnView.reason === undefined ? {} : { detail: turnView.reason }),
          })
          await attachMarks(file, null, turnStamp, turnOrigin, undefined, true)
          return
        }
        /**
         * 二进制/过大行与会话视图同一套结论，连比较都不取（审核 M1/M2）：这类行的
         * 计数被 Host 钉成 0/0，取了行级比较只会得到一份永远对不上的数字。
         */
        if (file.binary === true) {
          await attachMarks(file, null, turnStamp, turnOrigin, 'binary')
          return
        }
        if (file.oversized === true) {
          await attachMarks(file, null, turnStamp, turnOrigin, 'oversized')
          return
        }
        const answer = await api.changes.turnDiff(sessionId, file.path, repoSubdirOf())
        if (!alive.current) return
        /**
         * 四种结局都在这里定：画本轮 hunk / 文件在本轮之后又变了（回退会话累计）/
         * 没有可画的内容（说明原因）/ 二进制。判定本身是纯函数（`turn-view.ts`）。
         */
        const outcome = turnOutcomeOf(answer, turnView)
        if (outcome.action === 'fallback') {
          // Switch FIRST and keep the note, then say why (review M1): the old
          // order cleared the very sentence that explains the switch.
          const next = scopeAfterOutcome(outcome, scope)
          switchScope(next.scope, next.keepNote)
          setScopeNote({ key: outcome.noteKey })
          // …and fall through to the session comparison below, in this same click.
        } else if (outcome.action === 'closed') {
          setScopeNote({
            key: outcome.noteKey,
            ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
          })
          await attachMarks(file, null, turnStamp, turnOrigin, undefined, true)
          return
        } else if (outcome.action === 'binary') {
          await attachMarks(file, null, turnStamp, turnOrigin, 'binary')
          return
        } else {
          await attachMarks(file, outcome.diff, turnStamp, turnOrigin)
          return
        }
      }
      /**
       * 过大的行（字节被增量扫描的上限扣下）**不做行级比较**（审核 M1）。
       *
       * 列表对这类行把计数钉成 0/0，而点开时 Host 走更大的读取预算、可能真的给出
       * 一份比较 —— 那份比较的计数与列表行的 0/0 永远对不上，会引起 3 秒一次的假
       * "位置已过期"；极端情况下 before 侧仍被扣下，得到的是"整篇删除/新增"的假
       * 差异。所以这里连 diff 都不取：不建标记、不说行数，只打开文件并说明原因。
       */
      const oversized = file.oversized === true
      const diff = oversized ? null : await api.changes.diff(sessionId, file.path, repoSubdirOf())
      if (!alive.current) return
      const stamp = `${file.path}@${summary.at}@${summary.turn}`
      await attachMarks(file, diff, stamp, { scope: 'session' }, oversized ? 'oversized' : undefined)
    } catch (problem) {
      if (alive.current) explorer.info(`${t('changes.diffFailed')}: ${problem instanceof Error ? problem.message : String(problem)}`)
    } finally {
      if (alive.current) setBusy(undefined)
    }
  }, [attachMarks, explorer, scope, sessionId, summary, switchScope, t, turnMode, turnView])

  /**
   * Revert EVERYTHING this session did to one listed file.
   *
   * The write itself (gates, patch, confirmation, refresh) lives in the store's
   * `revertFileChanges`: it is the same class of remote write as the hover-revert
   * and must obey the same rules. This callback only resolves the coordinates the
   * row stands for.
   */
  const revertRow = useCallback(async (file: RemoteChangedFile): Promise<void> => {
    if (sessionId === undefined || summary === null || file.revert === undefined) return
    const binding = await bindingOf(file)
    if (binding === undefined) {
      explorer.info(t('changes.noWorkspace'))
      return
    }
    setBusy(file.path)
    try {
      await revertFileChanges({
        sessionId,
        bindingId: binding.id,
        alias: binding.alias,
        root: summary.root,
        path: file.path,
        display: file.display,
        mode: file.revert,
        // 本轮行上的"撤销该文件的全部改动"= 撤到上一轮关闭时；补丁由 Host 从
        // 本轮缓存里给（`turnDiff`），不是会话基线那份。`turn` 让 store 在成功后把
        // 这一行记成"本轮已撤销"，面板据此隐藏它（宿主冻结的 delta 不动）。
        ...(turnMode
          ? { scope: 'turn' as const, ...(turnView === undefined ? {} : { turn: turnView.turn }) }
          : {}),
      })
    } finally {
      if (alive.current) setBusy(undefined)
    }
  }, [bindingOf, explorer, sessionId, summary, t, turnMode, turnView])

  const toggleReviewed = useCallback((file: RemoteChangedFile): void => {
    // 清理按两份列表的并集来（见 `reviewable`）：切作用域不该删掉另一边的 ✓。
    setReviewed(previous => toggleReviewedEntry(reviewable, previous, file))
  }, [reviewable])

  // Persist the marks whenever they change. A storage that refuses (private mode)
  // must cost nothing but persistence — never a broken panel.
  useEffect(() => {
    if (sessionId === undefined || sessionId === '') return
    try {
      window.localStorage.setItem(`${REVIEW_STORAGE_PREFIX}${sessionId}`, serializeReviewed(reviewed))
    } catch {
      // Ignore: see above.
    }
  }, [reviewed, sessionId])

  // Drop marks for rows that are gone (or whose counts changed). Without this a
  // path that leaves and comes back would show a ✓ nobody gave it.
  useEffect(() => {
    // `files` is EMPTY until the first summary lands — that is "not loaded yet",
    // not "the session changed nothing". Pruning on that frame wiped the marks
    // just restored from localStorage (and wrote the empty map back).
    if (summary === null) return
    setReviewed(previous => {
      const next = pruneReviewed(reviewable, previous)
      // A prune only ever removes entries, so equal length means "identical".
      return Object.keys(next).length === Object.keys(previous).length ? previous : next
    })
  }, [reviewable, summary])

  /**
   * Bring the cursor's row into view.
   *
   * The jump can be pressed while the list is FOLDED, where the row does not
   * exist yet in that commit: the effect runs after the unfold has landed, so
   * the ref map has the row by then. `block: 'nearest'` means an already visible
   * row does not move at all, which is what makes a plain row click (which also
   * moves the cursor) a no-op here. Optional call: a DOM without `scrollIntoView`
   * (tests) must cost only the scroll.
   */
  useEffect(() => {
    if (cursorKey === undefined || collapsed) return
    rowRefs.current.get(cursorKey)?.scrollIntoView?.({ block: 'nearest' })
  }, [cursorKey, collapsed])

  const done = reviewedCount(files, reviewed)
  /**
   * Rows the body renders: the whole list, or only the rows that are still
   * unreviewed. The header's counters keep describing the whole list — the
   * filter is a view, not a recount.
   */
  const listed = useMemo(
    () => (onlyUnreviewed ? files.filter(file => !isReviewed(file, reviewed)) : files),
    [files, onlyUnreviewed, reviewed],
  )
  /**
   * What 「跳到下一个未审阅」would open; `undefined` both when the list is empty
   * and when every row is reviewed, which is exactly the button's disabled
   * condition. `fromKey` is the cursor, so a second press continues the walk.
   */
  const nextFile = useMemo(
    () => nextUnreviewed(files, reviewed, cursorKey),
    [files, reviewed, cursorKey],
  )

  /**
   * 「查看差异」：把这一行打开成**只读并排 diff**（数据来自会话账本）。
   *
   * 与左键「打开」是两件事：打开是"进文件里看这一处"，这里是"先把改前改后并排
   * 看一遍"，不改变编辑器里的标签页内容、也不写任何东西。`notice` 是这次比较
   * 必须说清的话（截断/二进制/读不到/已无差异），由调用方渲染。
   */
  const viewDiff = useCallback(async (file: RemoteChangedFile): Promise<void> => {
    if (sessionId === undefined || summary === null) return
    setBusy(file.path)
    setDiffNotice(undefined)
    try {
      const binding = await bindingOf(file)
      if (binding === undefined) {
        explorer.info(t('changes.noWorkspace'))
        return
      }
      const result = await openChangeDiff({
        sessionId,
        alias: binding.alias,
        root: summary.root,
        path: file.path,
        display: file.display === '' ? file.path : file.display,
        repoSubdir: repoSubdirOf(),
      })
      if (!alive.current) return
      if (result.notice !== undefined) setDiffNotice({ path: file.path, notice: result.notice })
    } catch (problem) {
      if (alive.current) explorer.info(`${t('changes.diffFailed')}: ${problem instanceof Error ? problem.message : String(problem)}`)
    } finally {
      if (alive.current) setBusy(undefined)
    }
  }, [bindingOf, explorer, sessionId, summary, t])

  const openRowMenu = useCallback((event: React.MouseEvent, file: RemoteChangedFile): void => {
    event.preventDefault()
    event.stopPropagation()
    const cannotRevert = file.revert === undefined
    /**
     * 只有真的画得出两栏时才给这条：
     * - 二进制/超大文件打开只会得到空视图；
     * - **本轮视图只开文件**：「查看差异」读的是会话累计的账本，和行上的本轮行数
     *   不是同一份比较，摆在这里只会让人以为这一轮的差异就是那两栏。
     */
    const canDiff = canShowChangeDiff(file) && !turnMode
    rowMenu.open(event.clientX, event.clientY, [
      { label: t('changes.menuOpen'), onSelect: () => { void openChanged(file) } },
      {
        label: t('changes.menuViewDiff'),
        disabled: !canDiff,
        ...(canDiff ? {} : { hint: turnMode ? t('changes.turnDiffDisabled') : t('changes.diffNotPossible') }),
        onSelect: () => { void viewDiff(file) },
      },
      {
        label: file.revert === 'delete' ? t('changes.revertCreation') : t('changes.revertFile'),
        danger: true,
        disabled: cannotRevert,
        // 本轮只保留反向补丁：新建文件在本轮**没有**撤销项，原因要说到"用哪条路"
        // （切回会话累计或 SCM 面板），不是通用的"无法撤销"（审核 N2）。
        ...(cannotRevert ? { hint: turnMode ? t('changes.turnRevertNotPossible') : t('changes.revertNotPossible') } : {}),
        separated: true,
        onSelect: () => { void revertRow(file) },
      },
      { label: t('changes.openInScm'), separated: true, onSelect: () => { setView('scm') } },
      { label: t('changes.copyPath'), onSelect: () => { void copyText(file.path) } },
    ])
  }, [openChanged, revertRow, rowMenu, t, turnMode, viewDiff])

  /** The header counter doubles as the "mark all / clear all" menu. */
  const openReviewMenu = useCallback((event: React.MouseEvent): void => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    reviewMenu.open(rect.left, rect.bottom + 4, [
      { label: t('changes.reviewAll'), onSelect: () => { setReviewed(setAllReviewed(files, true)) } },
      { label: t('changes.reviewNone'), onSelect: () => { setReviewed(setAllReviewed(files, false)) } },
    ])
  }, [files, reviewMenu, t])

  /**
   * 「跳到下一个未审阅」：把下一行滚进视野并打开它。
   *
   * 这一跳不标记任何东西：打开就是它的全部动作，看过没有由用户按 ✓ 决定。折叠着
   * 的列表先展开，否则只是换了个看不见的游标。打开走 `openChanged`（改动内容、
   * 绑定解析与撤销来源都在那一条路上），它同时把游标移到目标行，所以连按两次是
   * 继续往下走，而不是原地打转。
   */
  const jumpToNextUnreviewed = useCallback((): void => {
    if (nextFile === undefined) return
    setCollapsed(false)
    void openChanged(nextFile)
  }, [nextFile, openChanged])

  const activeTab = explorer.tabs.find(candidate => candidate.id === explorer.activeTabId)
  const visible = useMemo(() => {
    if (summary === null) return false
    // Visibility is the SESSION surface's question: the panel exists while the
    // session has work in either view — a turn that changed nothing must not hide
    // the dock (that would also strand the user in a scope with no rows).
    return sessionFiles.length > 0
      || turnFiles.length > 0
      || summary.pending === true
      || summary.unavailable !== undefined
  }, [sessionFiles.length, turnFiles.length, summary])
  // Published for the tick (see `visibleRef`): read at tick time, not captured at
  // effect time, so the cadence follows the panel without restarting the timer.
  // "Rendered" mirrors the early return below: an error is shown even without a
  // summary, so a failed panel keeps the near cadence (its ⟳ is on screen).
  visibleRef.current = visible || error !== undefined

  if (sessionId === undefined || sessionId === '') return null
  if (!visible && error === undefined) return null

  const stale = activeTab?.changeStale === true
  /**
   * 标题跟着作用域走：累计视图还是「本次改动 · N」，本轮是无歧义的「本轮 #N · HH:MM」。
   * 带轮次号是必须的 —— `turnView` 只描述最近一个**已完成**轮次，画面上的
   * `summary.turn` 可能已经翻到还没结束的下一轮。
   */
  const title = turnMode && turnView !== undefined
    ? `${turnTitle(t, turnView)}${files.length > 0 ? ` · ${files.length}` : ''}`
    : files.length > 0 ? `${t('changes.title')} · ${files.length}` : t('changes.title')
  /**
   * 合计按**可见行**重算：宿主那份冻结合计会把已撤销的文件也算进去（列表已经没有它，
   * 数字却还算着，就是"残影"）。会话累计模式仍用宿主给的合计（语义不变）。
   */
  const shownAdded = turnMode ? (turnRows?.added ?? 0) : (summary?.added ?? 0)
  const shownDeleted = turnMode ? (turnRows?.deleted ?? 0) : (summary?.deleted ?? 0)
  // 本轮可见行全是二进制/超大（0/0）时不摆一对 `+0 −0`；会话累计保持原样。
  const showTotals = turnMode
    ? files.length > 0 && (shownAdded > 0 || shownDeleted > 0)
    : files.length > 0

  return (
    <div className="rvs-changes" data-collapsed={collapsed ? '1' : '0'}>
      <div className="rvs-changes-head">
        <button
          type="button"
          className="rvs-changes-toggle"
          aria-expanded={!collapsed}
          onClick={() => { setCollapsed(value => !value) }}
          title={t('changes.toggle')}
        >
          <span className="rvs-changes-chevron" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
          <span className="rvs-changes-title">{title}</span>
        </button>
        {showTotals && (
          <span className="rvs-changes-totals">
            <span className="rvs-chg-add">+{shownAdded}</span>
            <span className="rvs-chg-del">−{shownDeleted}</span>
          </span>
        )}
        {/*
          作用域切换只在 Host 真的给了一轮时出现：没有 `turnView` 的会话（老 Host、
          或还没关闭过轮次）保持原样，不给一个点了没有反应的选择。
        */}
        {turnScopeAvailable(turnView) && (
          <span className="rvs-changes-scope" role="group" aria-label={t('changes.scopeLabel')}>
            <button
              type="button"
              className="rvs-changes-scope-btn"
              aria-pressed={scope === 'session'}
              title={t('changes.scopeSessionHint')}
              onClick={() => { switchScope('session') }}
            >{t('changes.scopeSession')}</button>
            <button
              type="button"
              className="rvs-changes-scope-btn"
              aria-pressed={scope === 'turn'}
              title={t('changes.scopeTurnHint')}
              onClick={() => { switchScope('turn') }}
            >{t('changes.scopeTurn')}</button>
          </span>
        )}
        {done > 0 && (
          <button
            type="button"
            className="rvs-changes-reviewed"
            title={t('changes.reviewMenu')}
            onClick={openReviewMenu}
          >
            {t('changes.reviewCount').replace('{done}', String(done)).replace('{total}', String(files.length))}
          </button>
        )}
        {files.length > 0 && (
          <>
            {/*
              「只看未审阅」: the header's small-chip style (`rvs-changes-reviewed`)
              is the one text button this panel's palette already carries. Its
              "on" state is painted from the same two variables it reads, since
              that chip rule only describes the idle look.
            */}
            <button
              type="button"
              className="rvs-changes-reviewed"
              aria-pressed={onlyUnreviewed}
              title={t('changes.onlyUnreviewed')}
              onClick={() => { setOnlyUnreviewed(value => !value) }}
              style={onlyUnreviewed ? { backgroundColor: 'var(--rvs-chg-hover)', color: 'var(--rvs-chg-fg)' } : undefined}
            >
              {t('changes.onlyUnreviewed')}
            </button>
            {/* 跳到下一个未审阅: one glyph (the words live in the tooltip), disabled
                when nothing is left. */}
            <span className="rvs-changes-nav">
              <button
                type="button"
                title={nextFile === undefined ? t('changes.allReviewed') : t('changes.nextUnreviewed')}
                aria-label={t('changes.nextUnreviewed')}
                disabled={nextFile === undefined}
                onClick={jumpToNextUnreviewed}
                style={nextFile === undefined ? { cursor: 'default', opacity: 0.4 } : undefined}
              >↓</button>
            </span>
          </>
        )}
        {summary?.pending === true && <span className="rvs-changes-pending">{t('changes.pending')}</span>}
        <span className="rvs-changes-spacer" />
        {stale && <span className="rvs-changes-stale" title={t('changes.staleHint')}>{t('changes.stale')}</span>}
        <button
          type="button"
          className="rvs-changes-refresh"
          onClick={() => { void load(true) }}
          title={t('changes.refresh')}
        >⟳</button>
      </div>
      {!collapsed && (
        <div className="rvs-changes-body">
          {error !== undefined && <div className="rvs-changes-note rvs-changes-error">{t('changes.failed')}: {error}</div>}
          {/*
            刚才那次点击的结论（二进制 / 读不到 / 已被改回 / 只给了前缀）。留在这里
            而不是只闪一条 toast：它解释的是"为什么屏幕上没有标记"，用户随时能回读。
          */}
          {diffNotice !== undefined && (
            <div className="rvs-changes-note rvs-changes-diffnote" title={diffNotice.path}>
              {t(diffNoticeKey(diffNotice.notice))}
            </div>
          )}
          {/*
            本轮视图自己的说明（"为什么没有标记 / 为什么回退成会话累计"）。上方那条
            `diffNotice` 是**比较结论文案**，这条是**这次点击的处置**，两者可能同时
            存在，所以分两行。
          */}
          {scopeNote !== undefined && (
            <div className="rvs-changes-note rvs-changes-scopenote" title={scopeNote.detail}>
              {t(scopeNote.key)}
              {scopeNote.detail === undefined ? '' : ` · ${scopeNote.detail}`}
            </div>
          )}
          {summary?.unavailable !== undefined && (
            <div className="rvs-changes-note">{t('changes.unavailable')} · {summary.unavailable}</div>
          )}
          {/*
            本轮只有统计（内存预算 / 文件上限）：统计是真的，但点行拿不到 hunk，也
            不能撤销。这句话必须常驻，不能只在点击后出现 —— 用户有权先知道。
          */}
          {turnMode && turnView?.cached === false && (
            <div className="rvs-changes-note rvs-changes-turnnote" title={turnView.reason}>
              {t('changes.turnStatsOnly')}
            </div>
          )}
          {/*
            这一轮的新文件扫描还没落地：同一轮会被重算，列表可能继续变长。说清楚，
            否则用户会以为"新文件没算进本轮"（审核 S2）。
          */}
          {turnMode && turnView?.pending === true && (
            <div className="rvs-changes-note rvs-changes-turnnote">{t('changes.turnPending')}</div>
          )}
          {/*
            撤销成功后被隐藏的行：宿主冻结的 delta 仍然列着它（宿主语义不动），所以
            "少了几行"必须由面板自己说清楚。只有视图**完整**且可见行为 0 时才说"全部
            撤销"（`turnFullyReverted`）；partial/pending 下仍用带 {n} 的那句 —— 面板
            无法证明"这一轮再没有别的改动"（SHOULD-1）。
          */}
          {turnMode && hiddenRows > 0 && (
            <div className="rvs-changes-note rvs-changes-turnnote">
              {allReverted
                ? t('changes.turnRevertedAll')
                : t('changes.turnRevertedHidden').replace('{n}', String(hiddenRows))}
            </div>
          )}
          {/*
            A turn still waiting for its slow scan is NOT "this turn changed nothing":
            saying both would flatly contradict the "still filling in" note above
            (review NIT-1). Neither is "every row was reverted": that case has its own
            sentence above (`turnRevertedAll`), so the generic empty copy stays away —
            and in a partial/pending view the "all" sentence itself is withheld above.
          */}
          {files.length === 0
            && summary?.unavailable === undefined
            && summary?.pending !== true
            && turnView?.pending !== true
            && hiddenRows === 0 && (
            <div className="rvs-changes-note">{turnMode ? t('changes.turnEmpty') : t('changes.empty')}</div>
          )}
          {/*
            The filter can hide every row; an empty body must then say WHY instead
            of looking like a broken list.
          */}
          {files.length > 0 && listed.length === 0 && (
            <div className="rvs-changes-note">{t('changes.allReviewed')}</div>
          )}
          {listed.map(file => {
            const { dir, name } = splitDisplay(file.display)
            const marked = isReviewed(file, reviewed)
            const key = reviewKeyOf(file)
            return (
              <div
                key={file.path}
                ref={(node) => {
                  if (node === null) rowRefs.current.delete(key)
                  else rowRefs.current.set(key, node)
                }}
                className={`rvs-chg-row${busy === file.path ? ' rvs-chg-loading' : ''}`}
                data-reviewed={marked ? '1' : '0'}
              >
                {/*
                  Two buttons, not one: a whole-row <button> cannot legally contain
                  the review toggle, and the toggle must not open the file. The
                  status letter is decoration here — its meaning is in the title.
                */}
                <button
                  type="button"
                  className="rvs-chg-open"
                  title={`${file.path}\n${statusWord(file, t)}`}
                  onClick={() => { void openChanged(file) }}
                  onContextMenu={(event) => { openRowMenu(event, file) }}
                >
                  <span className="rvs-chg-status" data-status={file.status ?? 'M'} aria-hidden="true">
                    {file.status ?? 'M'}
                  </span>
                  <span className="rvs-chg-icon" aria-hidden="true"><FileIcon path={file.display} size={14} /></span>
                  <span className="rvs-chg-path">
                    <span className="rvs-chg-dir">{dir}</span>
                    <span className="rvs-chg-name">{name}</span>
                  </span>
                  <span className="rvs-chg-counts">
                    {file.oversized === true
                      ? <span className="rvs-chg-note">{t('changes.oversized')}</span>
                      : file.binary === true
                        ? <span className="rvs-chg-note">{t('changes.binary')}</span>
                        : (
                          <>
                            <span className="rvs-chg-add">+{file.added}</span>
                            <span className="rvs-chg-del">−{file.deleted}</span>
                          </>
                          )}
                  </span>
                </button>
                <button
                  type="button"
                  className={`rvs-chg-review${marked ? ' is-on' : ''}`}
                  aria-pressed={marked}
                  title={marked ? t('changes.unmarkReviewed') : t('changes.markReviewed')}
                  onClick={() => { toggleReviewed(file) }}
                >{marked ? '✓' : ''}</button>
              </div>
            )
          })}
          {/*
            两条轴说"不完整"的原因不同，不能共用一句话：
            - 会话累计：`changes.truncated` = 文件超过 500，只列出前 N 个（语义不变）；
            - 本轮：`changes.turnPartial` 覆盖三种成因 —— 文件上限、上一侧内容未知
              （二进制/字节被扣下，无法归属）、上一轮扫描从未落定（上一轮校正没赶上）。
              常见场景（改过二进制文件）几乎每轮都会显示，用"文件过多"解释会撒谎。
          */}
          {turnMode
            ? (turnView?.truncated === true
              && <div className="rvs-changes-note rvs-changes-turnnote">{t('changes.turnPartial')}</div>)
            : (summary?.truncated === true
              && <div className="rvs-changes-note">{t('changes.truncated')}</div>)}
          {/*
            Which paths the new-file scan skipped. Stated, never silent: a file
            the user expected to see must not be missing without a reason, and
            the SCM panel is where every path (build output included) is listed.
          */}
          {(summary?.excludedDirs?.length ?? 0) > 0 && (
            <div className="rvs-changes-note" title={summary?.excludedDirs?.join(', ')}>
              {t('changes.excluded').replace('{dirs}', summary?.excludedDirs?.join(', ') ?? '')}
            </div>
          )}
        </div>
      )}
      {rowMenu.menu !== undefined && (
        <ContextMenu
          x={rowMenu.menu.x}
          y={rowMenu.menu.y}
          entries={rowMenu.menu.entries}
          onClose={rowMenu.close}
          className="rvs-menu-dock"
        />
      )}
      {reviewMenu.menu !== undefined && (
        <ContextMenu
          x={reviewMenu.menu.x}
          y={reviewMenu.menu.y}
          entries={reviewMenu.menu.entries}
          onClose={reviewMenu.close}
          className="rvs-menu-dock"
        />
      )}
    </div>
  )
}
