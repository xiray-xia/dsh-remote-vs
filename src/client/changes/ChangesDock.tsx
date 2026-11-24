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
  openRemoteFileInBinding,
  refreshAll,
  remoteOpenBindings,
  revertFileChanges,
  sessionRepoSubdir,
  setFollowSession,
  setView,
  useExplorer,
  workspaceMatchesSession,
} from '../store.tsx'
import { bindingForChangedFile } from '../remote-file-open-target.ts'
import { useRemoteChatTarget } from '../use-remote-chat-target.ts'
import type { RemoteChangedFile, RemoteChangesSummary } from '../../protocol.ts'
import { EMPTY_CHANGE_SET, changeSetFromHunks, type ChangeSet } from './model.ts'
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

  const files = useMemo(() => summary?.files ?? [], [summary])

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

  /** Open one listed file in the remote editor with its change marks. */
  const openChanged = useCallback(async (file: RemoteChangedFile): Promise<void> => {
    if (sessionId === undefined || summary === null) return
    // Opening a row also moves the review cursor, so 「跳到下一个未审阅」continues
    // from whatever the user just looked at (a click, a menu entry or a jump)
    // instead of from wherever the last jump happened to stop.
    setCursorKey(reviewKeyOf(file))
    setBusy(file.path)
    try {
      const diff = await api.changes.diff(sessionId, file.path, repoSubdirOf())
      if (!alive.current) return
      const stamp = `${file.path}@${summary.at}@${summary.turn}`
      const set: ChangeSet = diff !== null && diff.kind === 'text'
        ? changeSetFromHunks(diff.hunks, stamp, diff.patch)
        : { ...EMPTY_CHANGE_SET, stamp }
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
      if (diff !== null && diff.kind === 'text' && diff.hunks.length > 0) {
        rememberChangeOrigin(tabId, { sessionId, bindingId: binding.id, alias: binding.alias, root: summary.root })
      } else {
        forgetChangeOrigin(tabId)
      }
    } catch (problem) {
      if (alive.current) explorer.info(`${t('changes.diffFailed')}: ${problem instanceof Error ? problem.message : String(problem)}`)
    } finally {
      if (alive.current) setBusy(undefined)
    }
  }, [bindingOf, explorer, sessionId, summary, t])

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
      })
    } finally {
      if (alive.current) setBusy(undefined)
    }
  }, [bindingOf, explorer, sessionId, summary, t])

  const toggleReviewed = useCallback((file: RemoteChangedFile): void => {
    setReviewed(previous => toggleReviewedEntry(files, previous, file))
  }, [files])

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
      const next = pruneReviewed(files, previous)
      // A prune only ever removes entries, so equal length means "identical".
      return Object.keys(next).length === Object.keys(previous).length ? previous : next
    })
  }, [files, summary])

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

  const openRowMenu = useCallback((event: React.MouseEvent, file: RemoteChangedFile): void => {
    event.preventDefault()
    event.stopPropagation()
    const cannotRevert = file.revert === undefined
    rowMenu.open(event.clientX, event.clientY, [
      { label: t('changes.menuOpen'), onSelect: () => { void openChanged(file) } },
      {
        label: file.revert === 'delete' ? t('changes.revertCreation') : t('changes.revertFile'),
        danger: true,
        disabled: cannotRevert,
        ...(cannotRevert ? { hint: t('changes.revertNotPossible') } : {}),
        separated: true,
        onSelect: () => { void revertRow(file) },
      },
      { label: t('changes.openInScm'), separated: true, onSelect: () => { setView('scm') } },
      { label: t('changes.copyPath'), onSelect: () => { void copyText(file.path) } },
    ])
  }, [openChanged, revertRow, rowMenu, t])

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
    return files.length > 0 || summary.pending === true || summary.unavailable !== undefined
  }, [files.length, summary])
  // Published for the tick (see `visibleRef`): read at tick time, not captured at
  // effect time, so the cadence follows the panel without restarting the timer.
  // "Rendered" mirrors the early return below: an error is shown even without a
  // summary, so a failed panel keeps the near cadence (its ⟳ is on screen).
  visibleRef.current = visible || error !== undefined

  if (sessionId === undefined || sessionId === '') return null
  if (!visible && error === undefined) return null

  const stale = activeTab?.changeStale === true
  const title = files.length > 0 ? `${t('changes.title')} · ${files.length}` : t('changes.title')

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
        {files.length > 0 && (
          <span className="rvs-changes-totals">
            <span className="rvs-chg-add">+{summary?.added ?? 0}</span>
            <span className="rvs-chg-del">−{summary?.deleted ?? 0}</span>
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
          {summary?.unavailable !== undefined && (
            <div className="rvs-changes-note">{t('changes.unavailable')} · {summary.unavailable}</div>
          )}
          {files.length === 0 && summary?.unavailable === undefined && summary?.pending !== true && (
            <div className="rvs-changes-note">{t('changes.empty')}</div>
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
          {summary?.truncated === true && <div className="rvs-changes-note">{t('changes.truncated')}</div>}
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
