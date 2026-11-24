/**
 * Sidebar surface (better-sidebar tab, or the native right-Sidebar fallback):
 * a VS Code-style activity rail plus one column that shows the active view.
 *
 * The DOCKED editor is the default seat (`editorSurface === 'sidebar'`) and it
 * is a FULL-COLUMN rail page — one view at a time, like the local sidebar
 * plugin: opening a file switches the column to the editor, and closing its last
 * file switches back to the directory. The conversation-view tab next to 轨迹 is
 * the OPTIONAL full-width seat the editor's own button switches to.
 */
import type { Context } from '@deepseek-ai/cordis'
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from './api.ts'
import { ConnectionStatusChip } from './ConnectionStatus.tsx'
import { applyConnectionStatuses, isConnectionRecovery, setActiveConnectionAlias, useConnectionStatus, type ConnectionTrace } from './connection.ts'
import { EditorPane as EditorPaneView } from './EditorPane.tsx'
import { FloatingEditorPlaceholder as FloatingEditorPlaceholderView } from './FloatingPlaceholder.tsx'
import { DownloadDock } from './DownloadDock.tsx'
import { PortsView, IconPlug } from './PortsView.tsx'
import { MonitorView, IconMonitor } from './MonitorView.tsx'
import { QuickOpen } from './QuickOpen.tsx'
import { RemoteExplorer } from './RemoteExplorer.tsx'
import { SearchView } from './SearchView.tsx'
import { HistoryPanel } from './scm/HistoryPanel.tsx'
import { ScmPanel } from './scm/ScmPanel.tsx'
import { TerminalView } from './TerminalView.tsx'
import { WorkspacesView } from './WorkspacesView.tsx'
import {
  followSessionWorkspace,
  refreshAfterReconnect,
  selectWorkspace,
  setFollowSession,
  setView,
  shallowEqual,
  useBootstrap,
  useExplorerSelector,
  type ExplorerValue,
} from './store.tsx'
import { useRemoteChatTarget } from './use-remote-chat-target.ts'
import { DialogHost } from './vsc/kit.tsx'
import { FOREIGN_TARGET, isModalLayerOpen } from './vsc/save-shortcut.ts'
import {
  IconBranch,
  IconCode,
  IconDiff,
  IconHistory,
  IconSearch,
  IconServer,
  IconTerminal,
  MiniSpinner,
} from './vsc/kit.tsx'

type RailView = 'explorer' | 'search' | 'scm' | 'history' | 'editor' | 'terminal' | 'ports' | 'monitor' | 'workspaces'

const HIDDEN_KEY = 'dsh-remote-vs.showHidden'

/**
 * How often the client asks the Host for connection health. A local JSON call
 * into the same process (no SSH, no dial); 5 s keeps the chip truthful without
 * being noticeable, and request failures update it sooner than that.
 */
const CONNECTION_POLL_MS = 5_000

/**
 * How long the link must stay up before the recovery refresh runs.
 *
 * Two poll intervals: one good sample can be a race (a retry's probe beating a
 * still-failing dial); two in a row mean the link is actually back. Auto-retry
 * makes flaps cheap to trigger, so the damping lives here.
 */
const RECOVERY_SETTLE_MS = 10_000

/**
 * Which tabs a recovered link must reload, and how many dirty tabs to warn about.
 *
 * Pure so the gate can drive it with a synthetic list: the recovery timer used
 * to close over the tab array of the render that STARTED it (10 s earlier), so a
 * tab opened or closed in that window was missed. Only clean file/diff tabs are
 * reloaded; a dirty tab is the user's unsaved work and must never be replaced.
 */
export function planRecoveryReload(
  tabs: readonly { id: string; dirty: boolean; loading: boolean; kind: string }[],
): { dirty: number; reload: string[] } {
  return {
    dirty: tabs.filter(tab => tab.dirty).length,
    reload: tabs
      .filter(tab => !tab.loading && !tab.dirty && (tab.kind === 'file' || tab.kind === 'diff'))
      .map(tab => tab.id),
  }
}

/**
 * What the SHELL itself renders — and nothing else.
 *
 * The shell used to subscribe to the whole snapshot (`useExplorer()`), so every
 * publish repainted it: a save (3-4 publishes), a git status refresh, a tab
 * dirty flag. Each of those renders re-created the element for every KEPT-ALIVE
 * panel (the wrapper is always mounted, see `panelFor`) and — because a function
 * component re-renders whenever its parent does — rebuilt all ten panels,
 * including the 4000-row SCM change list.
 *
 * This slice is exactly what the root chrome paints (rail badges and title,
 * workspace picker, branch pill, busy spinner, banner) plus what its effects
 * need (tabs for the recovery timer, workspaces/aliasPaths for the session
 * follow, terminalRequest for the terminal page). `useExplorerSelector` +
 * `shallowEqual` repaint the shell only when one of these changes; the panels
 * are memoized below, so even when the shell DOES render they are skipped
 * unless their own props changed.
 *
 * Module-level so its identity is stable: between publishes the hook's cache
 * answers without running the selector.
 */
const selectShellStore = (snapshot: ExplorerValue) => ({
  t: snapshot.t,
  ready: snapshot.ready,
  view: snapshot.view,
  hosts: snapshot.hosts,
  workspaces: snapshot.workspaces,
  routing: snapshot.routing,
  workspace: snapshot.workspace,
  aliasPaths: snapshot.aliasPaths,
  error: snapshot.error,
  repoRoot: snapshot.repoRoot,
  head: snapshot.head,
  gitBusy: snapshot.gitBusy,
  editorSurface: snapshot.editorSurface,
  floatOpen: snapshot.floatOpen,
  terminalRequest: snapshot.terminalRequest,
  tabs: snapshot.tabs,
  activeTab: snapshot.activeTab,
  buckets: snapshot.buckets,
  selectWorkspace: snapshot.selectWorkspace,
  refreshAll: snapshot.refreshAll,
  reloadTab: snapshot.reloadTab,
  info: snapshot.info,
})

/**
 * The kept-alive panels, memoized.
 *
 * `React.memo` compares PROPS shallowly: none of these panels is re-rendered
 * just because their parent was — only when their own props changed. That is
 * what makes the selector migration pay off, and it also covers local shell
 * state (the Ctrl+P modal, `showHidden`, the IntersectionObserver's `live` bit)
 * that used to drag every panel into a render.
 *
 * The props must therefore be STABLE while nothing changes for the panel:
 * - `go`/`openHistory`/`openWorkspaceFiles`/`toggleHidden` below are
 *   `useCallback`s over module-level store actions, so they keep one identity;
 * - the other props are strings, booleans or store references, compared with
 *   `Object.is` (and the store hands out the same reference until that value
 *   changes — see `selectShellStore`).
 *
 * `EditorPane` and `FloatingEditorPlaceholder` keep their original JSX names
 * (a gate pins those call sites), so they are wrapped under their own name.
 */
const MemoSearchView = memo(SearchView)
const MemoScmPanel = memo(ScmPanel)
const MemoHistoryPanel = memo(HistoryPanel)
const MemoTerminalView = memo(TerminalView)
const MemoPortsView = memo(PortsView)
const MemoMonitorView = memo(MonitorView)
const MemoWorkspacesView = memo(WorkspacesView)
const EditorPane = memo(EditorPaneView)
const FloatingEditorPlaceholder = memo(FloatingEditorPlaceholderView)

export function RemoteRoot(props: { ctx: Context; visible?: boolean }): ReactNode {
  useBootstrap(props.ctx)
  return (
    <>
      <DialogHost />
      <Shell ctx={props.ctx} visible={props.visible !== false} />
    </>
  )
}

function Shell(props: { ctx: Context; visible: boolean }): ReactNode {
  const store = useExplorerSelector(selectShellStore, shallowEqual)
  const t = store.t
  // The active panel lives in the shared store so other surfaces (the tree's
  // "Find in Folder…", the SCM panel's history shortcut) can switch it.
  const view = store.view
  /** Latest committed tab list, for timers created by an earlier render. */
  const tabsRef = useRef(store.tabs)
  tabsRef.current = store.tabs
  const [showHidden, setShowHidden] = useState<boolean>(() => {
    try {
      return localStorage.getItem(HIDDEN_KEY) === '1'
    } catch {
      return false
    }
  })

  /**
   * Visibility is measured, not promised.
   *
   * The mount points disagree: the native fallback forwards a real
   * `tab.visible`, but the better-sidebar tab is registered as
   * `component: () => <RemoteRoot ctx={ctx} />` with no props at all, so
   * `visible` there is the constant `true` and every gate built on it is dead.
   * An IntersectionObserver on this root gives the same answer on both paths
   * and keeps giving it: the host hides a parked tab with `display:none` (and
   * removes it when the tab closes), and a box-less element never intersects.
   *
   * Optimistic until the first callback so the first paint is unaffected.
   *
   * A CALLBACK ref, not a ref object plus a mount effect: the first render
   * happens before `store.ready`, so it takes the loading branch below — a
   * different element, with no ref on it. A mount-once effect would read `null`
   * there and never run again (its deps are empty), leaving `onScreen` at the
   * optimistic `true` and every gate below dead on the mount path that needs it
   * most. React invokes this when the real root mounts, whenever that is, and
   * calls it with `null` on the way out — which is also the disconnect.
   */
  const [onScreen, setOnScreen] = useState(true)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const attachRoot = useCallback((node: HTMLDivElement | null): void => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (node === null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (entry !== undefined) setOnScreen(entry.isIntersecting)
    })
    observer.observe(node)
    observerRef.current = observer
  }, [])

  /** The trusted "this panel is live" bit: host visibility AND actually painted. */
  const live = props.visible && onScreen
  const panelLive = (id: RailView): boolean => live && view === id

  /**
   * Ctrl+P / Cmd+P quick open.
   *
   * Fires only while THIS panel is genuinely on screen (`live`, the measured
   * bit above) and the store has booted: a local conversation page must keep
   * the browser's own Ctrl+P, and the better-sidebar mount passes no `visible`
   * prop at all — a gate built on `props.visible` alone would be dead there.
   *
   * `preventDefault()` is the whole point of the handler: without it the
   * browser opens its print dialog on top of the modal. The toggle keeps the
   * "press it again to leave" habit.
   *
   * In the TERMINAL, ^P belongs to the shell (readline's "previous command", and
   * vim/less have their own meanings). xterm has already sent the keystroke by
   * the time it bubbles to `window`, so opening the modal here would fire two
   * actions for one press — the shell gets ^P AND a modal appears. The terminal
   * therefore keeps the key; `preventDefault()` still runs so the browser's
   * print dialog cannot appear behind it.
   */
  const [quickOpen, setQuickOpen] = useState(false)
  const storeReady = store.ready
  useEffect(() => {
    const onQuickOpenKey = (event: KeyboardEvent): void => {
      if (!live || !storeReady) return
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.altKey || event.shiftKey) return
      if (event.key !== 'p' && event.key !== 'P') return
      // Claimed even when the handler steps aside below: the browser's print
      // dialog must never appear behind a layer that owns the keyboard.
      event.preventDefault()
      // Auto-repeat would flash the modal on a held key.
      if (event.repeat) return
      // While OUR modal is up, Ctrl+P is its documented "press again to leave",
      // so the guards below (which belong to OPENING it) must not run.
      if (!quickOpen) {
        // A dialog or menu on screen owns the keyboard: opening QuickOpen over a
        // host approval / the Settings dialog would steal the focus from the
        // layer the user is answering (audit I-2).
        if (isModalLayerOpen()) return
        const focused = document.activeElement
        if (focused instanceof HTMLElement && focused.closest('.xterm') !== null) return
        // Every other text field keeps Ctrl+P too — the host's chat composer, a
        // dialog input — i.e. the same FOREIGN_TARGET the save shortcut yields
        // to, so both global shortcuts draw one line (audit I-11). Our own
        // CodeMirror surface is the exception: editing is the state quick open is
        // FOR, and CodeMirror marks its content `contenteditable`, which the
        // shared list would otherwise turn into "Ctrl+P does nothing here".
        if (focused instanceof HTMLElement
          && focused.closest(FOREIGN_TARGET) !== null
          && focused.closest('.cm-content') === null) return
      }
      setQuickOpen(open => !open)
    }
    window.addEventListener('keydown', onQuickOpenKey)
    return () => window.removeEventListener('keydown', onQuickOpenKey)
  }, [live, storeReady, quickOpen])

  /**
   * Leaving the panel closes the modal.
   *
   * It is portaled to <body>, so nothing about the sidebar's own unmount/hide
   * would take it off screen: without this it would keep floating over a
   * completely different surface after the user switched tabs.
   */
  useEffect(() => {
    if (!live) setQuickOpen(false)
  }, [live])

  /**
   * Stable identities for the panel props below: a `useCallback` over a
   * MODULE-level store action (`setView`/`selectWorkspace`), not over the slice
   * object — the slice changes whenever any chrome field does, which would make
   * every prop refresh and defeat `React.memo` on the panels.
   */
  const go = useCallback((next: RailView): void => {
    setView(next)
  }, [])
  /** The SCM panel's "history →" shortcut (stable, see above). */
  const openHistory = useCallback((): void => {
    setView('history')
  }, [])
  /** The workspace wizard's "open files" (stable, see above). */
  const openWorkspaceFiles = useCallback((value: string): void => {
    selectWorkspace(value)
    setView('explorer')
  }, [])
  /** Arrow for `RemoteExplorer`'s "show hidden" toggle (stable, see above). */
  const toggleHidden = useCallback((): void => {
    setShowHidden(v => !v)
  }, [])

  /**
   * Connection status: point the client view at the workspace's host and poll
   * the Host pool.
   *
   * The poll is a local HTTP call into the Host (no SSH dial, no wake-up), and it
   * pauses while the page is hidden; the link state itself is only observable
   * Host-side, so this is the one honest source. Request-level transport
   * failures update the view immediately (see `api`), so the chip does not lag
   * a failure by a full interval.
   */
  const connectionAlias = store.workspace?.alias ?? ''
  const connection = useConnectionStatus()
  useEffect(() => {
    setActiveConnectionAlias(connectionAlias)
  }, [connectionAlias])
  useEffect(() => {
    if (connectionAlias === '') return
    let stopped = false
    const tick = async (): Promise<void> => {
      if (document.hidden) return
      try {
        const connections = await api.connectionStatus()
        if (!stopped) applyConnectionStatuses(connections)
      } catch {
        // The local Host is unreachable; leave the last view alone — the
        // request-level failure path already marks what it can.
      }
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, CONNECTION_POLL_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [connectionAlias])

  /**
   * Recovered link: refresh what the disconnect left stale.
   *
   * Directory listings, git status and CLEAN editor tabs were all read before
   * the drop. Dirty tabs are deliberately not reloaded (that would throw the
   * user's edits away) and the user is told so. Read-only DIFF tabs have no
   * unsaved edits, so they are reloaded like clean file tabs.
   *
   * Deps are intentionally just the connection state: the store slice changes
   * whenever any chrome field does, and re-running this on those changes would
   * re-fire the refresh loop.
   */
  const lastConnection = useRef<ConnectionTrace | undefined>(undefined)
  // Live mirrors for the settle timer below (it fires long after the effect ran).
  const connectionRef = useRef(connection)
  connectionRef.current = connection
  const connectionAliasRef = useRef(connectionAlias)
  connectionAliasRef.current = connectionAlias
  useEffect(() => {
    // A workspace switch is not a recovery: re-baseline the trace on the new
    // alias (two already-errored hosts change the alias without changing the
    // state, and the recovery must still fire for the second one).
    lastConnection.current = { alias: connectionAlias, state: connection?.state }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionAlias])
  useEffect(() => {
    const previous = lastConnection.current
    lastConnection.current = { alias: connectionAlias, state: connection?.state }
    if (!isConnectionRecovery(previous, connectionAlias, connection?.state)) return
    // Require the link to STAY up for a couple of polls before refreshing: a
    // flapping link would otherwise re-fire git + a full tree re-list + every
    // tab reload on each flap. Auto-retry makes flaps cheap to trigger, so the
    // damping has to live here rather than in "the user must click".
    const timer = window.setTimeout(() => {
      if (connectionRef.current?.state !== 'ok') return
      if (connectionAliasRef.current !== connectionAlias) return
      // Read the LATEST committed tabs: this timer fires 10 s after the
      // effect ran, and a tab opened/closed/changed in between must be seen
      // (the captured `store` snapshot only knows the list from that render).
      const plan = planRecoveryReload(tabsRef.current)
      refreshAfterReconnect()
      for (const id of plan.reload) void store.reloadTab(id)
      if (plan.dirty > 0) store.info(t('connection.recoveredDirty'))
      else store.info(t('connection.recovered'))
    }, RECOVERY_SETTLE_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.state])

  // Panels are mounted on first visit and then kept alive (see panelFor).
  const [mounted, setMounted] = useState<Set<RailView>>(() => new Set<RailView>([store.view]))
  useEffect(() => {
    setMounted(prev => (prev.has(view) ? prev : new Set(prev).add(view)))
  }, [view])

  // A profile with no binding has nothing to explore: the workspaces view (the
  // wizard) takes over until one exists.
  useEffect(() => {
    if (store.workspaces.length === 0 && view !== 'workspaces' && view !== 'monitor') go('workspaces')
  }, [store.workspaces.length, view, go])

  /**
   * The selector follows the SESSION, not the binding list.
   *
   * Without this the panel opened on whatever localStorage held — and on a
   * fresh profile on `workspaces[0]` — so a session working in one remote
   * workspace showed another workspace's tree until the user corrected it by
   * hand (the reported bug: a session browsing another workspace on one host). The host's own
   * workspace membership for the on-screen session is the only sanctioned
   * source (`useRemoteChatTarget`), and it is a soft read: while it answers
   * nothing the current selection stands.
   *
   * The policy itself lives in the store (`followSessionWorkspace`), not here:
   * the sidebar is one TRIGGER, and a conversation whose sidebar was never
   * opened must follow all the same (the change panel registers and triggers
   * the same capability). Registering the session here keeps both surfaces on
   * one subject; when the seat answers nothing the registration is left alone,
   * because the other surface may be the one that knows the session.
   *
   * The binding table arrives asynchronously, so the effect also re-runs when
   * the table (or its alias dirs) lands; the capability is idempotent per
   * session (and shares one in-flight resolution), so the extra runs cost
   * nothing and never fight a manual pick made afterwards.
   */
  const target = useRemoteChatTarget(props.ctx)
  useEffect(() => {
    if (target.sessionId === undefined) return
    setFollowSession(target.sessionId)
    void followSessionWorkspace({
      sessionId: target.sessionId,
      workspacePath: target.sessionWorkspacePath,
    })
  }, [target.sessionId, target.sessionWorkspacePath, store.ready, store.workspaces, store.aliasPaths])

  useEffect(() => {
    try {
      localStorage.setItem(HIDDEN_KEY, showHidden ? '1' : '0')
    } catch {
      // Ignore.
    }
  }, [showHidden])

  if (!store.ready) {
    return (
      <div className="rvs-root">
        <div className="rvs-empty" style={{ margin: 'auto' }}><MiniSpinner /> {t('common.loading')}</div>
      </div>
    )
  }

  const editorInSidebar = store.editorSurface === 'sidebar'

  /**
   * One panel body. Every visited panel stays MOUNTED (hidden by CSS), which
   * is what keeps the explorer's listings / expansion set — and the terminal's
   * connection — alive across rail switches: re-mounting used to refetch the
   * whole visible tree and flash a reload on every return.
   */
  const panelFor = (id: RailView): ReactNode => {
    switch (id) {
      case 'search': return <MemoSearchView />
      case 'scm': return <MemoScmPanel onOpenHistory={openHistory} visible={panelLive('scm')} />
      case 'history': return <MemoHistoryPanel />
      case 'terminal':
        // The terminal draws its own header + tab strip, so it takes the whole
        // slot (no extra padding wrapper).
        return <MemoTerminalView t={t} hosts={store.hosts} visible={panelLive('terminal')} request={store.terminalRequest} />
      case 'ports':
        // Same shape as the terminal: its own header (host picker + refresh) and
        // its own scroller, so no viewpad wrapper either.
        return <MemoPortsView t={t} hosts={store.hosts} visible={panelLive('ports')} />
      case 'monitor':
        // Live host metrics: own header (scope picker + refresh/pause) and its
        // own scroller. Cross-host by design, so it reads `store.hosts` rather
        // than the current binding.
        return <MemoMonitorView t={t} hosts={store.hosts} visible={panelLive('monitor')} />
      case 'workspaces':
        return (
          <div className="rvs-viewpad" style={{ height: '100%' }}>
            <MemoWorkspacesView
              t={t}
              hosts={store.hosts}
              workspaces={store.workspaces}
              routing={store.routing}
              onChanged={store.refreshAll}
              onOpenFiles={openWorkspaceFiles}
            />
          </div>
        )
      case 'editor':
        // The docked editor is the DEFAULT seat: opening a file switches this
        // column to this page, so the editor owns the whole sidebar instead of
        // sharing it with the tree. It must not render while the centre surface
        // or the floating window owns the editor: all of them read the same
        // store, so two live editors for one tab fight over the scroll position
        // and the hidden one — sitting at scrollTop 0 — wins, which is exactly
        // why a tab switch kept snapping back to the top of the file.
        if (editorInSidebar) return <EditorPane visible={panelLive('editor')} />
        // The editor lives elsewhere: the panel stays reachable (so docking
        // returns here) but says where it went and how to bring it back.
        return <FloatingEditorPlaceholder mode={store.floatOpen ? 'float' : 'center'} />
      default:
        return (
          <RemoteExplorer
            showHidden={showHidden}
            onToggleHidden={toggleHidden}
            visible={panelLive('explorer')}
          />
        )
    }
  }

  const panel = (
    <div className="rvs-pane grow">
      {[...mounted].map(id => (
        <div
          key={id}
          className="rvs-viewslot"
          // Kept MOUNTED and only hidden: removing a panel from this list
          // unmounted it, so switching rail pages rebuilt the editor and
          // dropped its local undo/scroll state (and re-listed the tree).
          style={{ display: view === id ? 'flex' : 'none' }}
        >
          {panelFor(id)}
        </div>
      ))}
    </div>
  )

  const railButton = (id: RailView, title: string, icon: ReactNode, badge = 0): ReactNode => (
    <button
      key={id}
      type="button"
      className={`rvs-rail-btn${view === id ? ' active' : ''}`}
      title={title}
      aria-label={title}
      onClick={() => go(id)}
    >
      {icon}
      {badge > 0 && <span className="rvs-rail-badge">{badge > 99 ? '99+' : badge}</span>}
    </button>
  )

  return (
    <div className="rvs-root" ref={attachRoot}>
      <DownloadDock t={t} />
      {quickOpen && live && <QuickOpen onClose={() => setQuickOpen(false)} />}
      <div className="rvs-rail">
        {railButton('explorer', t('tab.files'), <IconCode size={17} />)}
        {railButton('search', t('tab.search'), <IconSearch size={17} />)}
        {railButton('scm', t('tab.git'), <IconBranch size={17} />, store.buckets.total)}
        {railButton('history', t('tab.history'), <IconHistory size={17} />)}
        <div className="rvs-rail-sep" />
        {/* Always present, like the local sidebar: with no file open it is the
            empty state, and a click from anywhere lands on the editor again. */}
        {railButton('editor', store.activeTab?.rel.split('/').pop() ?? t('tab.editor'), <IconDiff size={17} />, store.tabs.length)}
        {railButton('terminal', t('tab.terminal'), <IconTerminal size={17} />)}
        {railButton('ports', t('tab.ports'), <IconPlug size={17} />)}
        {railButton('monitor', t('tab.monitor'), <IconMonitor size={17} />)}
        {railButton('workspaces', t('tab.workspaces'), <IconServer size={17} />, store.workspaces.length)}
      </div>
      <div className="rvs-column">
        <div className="rvs-globalbar">
          <select
            className="rvs-select"
            value={store.workspace?.id ?? ''}
            onChange={(e) => store.selectWorkspace(e.target.value)}
            title={t('files.selectWorkspace')}
          >
            {store.workspaces.map(item => (
              <option key={item.id} value={item.id}>{item.name} ({item.alias})</option>
            ))}
          </select>
          <ConnectionStatusChip />
          {store.repoRoot !== undefined && store.head !== undefined && (
            <span className="rvs-pill" title={store.repoRoot}>
              ⑂ {store.head.detached ? t('scm.detached') : store.head.branch}
              {store.head.ahead > 0 && ` ↑${store.head.ahead}`}
              {store.head.behind > 0 && ` ↓${store.head.behind}`}
            </span>
          )}
          {store.gitBusy && <MiniSpinner />}
        </div>
        {store.error !== undefined && <div className="rvs-banner error" role="status">{store.error}</div>}
        <div className="rvs-pane" style={{ flex: 1, minHeight: 0 }}>
          {panel}
        </div>
      </div>
    </div>
  )
}
