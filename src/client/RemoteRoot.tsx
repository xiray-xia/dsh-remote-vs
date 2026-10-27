/**
 * Sidebar surface (better-sidebar tab, or the native right-Sidebar fallback):
 * a VS Code-style activity rail plus one column that shows the active view.
 *
 * The editor itself lives in the conversation view next to 轨迹 whenever that
 * registration succeeds (`editorSurface === 'center'`), so the tree keeps the
 * whole column; on a host where the conversation slot is unavailable the old
 * split (panel above the editor) still applies and nothing becomes
 * unreachable.
 */
import type { Context } from '@deepseek-ai/cordis'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { EditorPane } from './EditorPane.tsx'
import { FloatingEditorPlaceholder } from './FloatingPlaceholder.tsx'
import { RemoteExplorer } from './RemoteExplorer.tsx'
import { SearchView } from './SearchView.tsx'
import { HistoryPanel } from './scm/HistoryPanel.tsx'
import { ScmPanel } from './scm/ScmPanel.tsx'
import { TerminalView } from './TerminalView.tsx'
import { WorkspacesView } from './WorkspacesView.tsx'
import { useBootstrap, useExplorer, followSessionWorkspace, setFollowSession } from './store.tsx'
import { useRemoteChatTarget } from './use-remote-chat-target.ts'
import { DialogHost } from './vsc/kit.tsx'
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

type RailView = 'explorer' | 'search' | 'scm' | 'history' | 'editor' | 'terminal' | 'workspaces'

const SPLIT_KEY = 'dsh-remote-vs.split'
const HIDDEN_KEY = 'dsh-remote-vs.showHidden'

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
  const store = useExplorer()
  const t = store.t
  // The active panel lives in the shared store so other surfaces (the tree's
  // "Find in Folder…", the SCM panel's history shortcut) can switch it.
  const view = store.view
  const [showHidden, setShowHidden] = useState<boolean>(() => {
    try {
      return localStorage.getItem(HIDDEN_KEY) === '1'
    } catch {
      return false
    }
  })
  const [split, setSplit] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(SPLIT_KEY))
      return Number.isFinite(saved) && saved > 0.15 && saved < 0.9 ? saved : 0.45
    } catch {
      return 0.45
    }
  })
  const splitRef = useRef(split)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ startY: number; startRatio: number } | undefined>(undefined)
  const columnRef = useRef<HTMLDivElement>(null)

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

  const go = useCallback((next: RailView): void => {
    store.setView(next)
  }, [store])

  // Panels are mounted on first visit and then kept alive (see panelFor).
  const [mounted, setMounted] = useState<Set<RailView>>(() => new Set<RailView>([store.view]))
  useEffect(() => {
    setMounted(prev => (prev.has(view) ? prev : new Set(prev).add(view)))
  }, [view])

  // A profile with no binding has nothing to explore: the workspaces view (the
  // wizard) takes over until one exists.
  useEffect(() => {
    if (store.workspaces.length === 0 && view !== 'workspaces') go('workspaces')
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

  /**
   * The mount surface owns the editor, so a persisted `view === 'editor'` is
   * only reachable where the sidebar still holds the editor.
   *
   * `view` is restored from localStorage (where 'editor' is an allowed value)
   * and `editorSurface` starts as 'sidebar' before index.tsx flips it once the
   * conversation-view slot registers. A profile that last used the fallback
   * layout therefore came back with `view === 'editor'` while the rail button
   * that owns it was gone AND the centre tab mounted a second EditorPane on
   * the same store tab — two live buffers with independent undo state, the one
   * state this file declares must never happen.
   *
   * Only the CENTRE pixel surface triggers this redirect. While the editor
   * floats the sidebar keeps whatever view it had: the editor panel renders a
   * "docked elsewhere" placeholder (see panelFor), and on docking the user
   * lands back where they were.
   */
  useEffect(() => {
    if (store.editorSurface === 'center' && view === 'editor') go('explorer')
  }, [store.editorSurface, view, go])

  useEffect(() => {
    try {
      localStorage.setItem(HIDDEN_KEY, showHidden ? '1' : '0')
    } catch {
      // Ignore.
    }
  }, [showHidden])

  const onDividerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // Older engine: the buttons gate below covers it.
    }
    dragRef.current = { startY: e.clientY, startRatio: splitRef.current }
    setDragging(true)
  }
  const onDividerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === undefined) return
    if ((e.buttons & 1) === 0) {
      dragRef.current = undefined
      setDragging(false)
      return
    }
    const total = columnRef.current?.clientHeight ?? 0
    if (total < 200) return
    const next = Math.min(0.88, Math.max(0.12, drag.startRatio + (e.clientY - drag.startY) / total))
    splitRef.current = next
    setSplit(next)
  }
  const onDividerEnd = (): void => {
    if (dragRef.current === undefined) return
    dragRef.current = undefined
    setDragging(false)
    try {
      localStorage.setItem(SPLIT_KEY, String(splitRef.current))
    } catch {
      // Ignore.
    }
  }

  if (!store.ready) {
    return (
      <div className="rvs-root">
        <div className="rvs-empty" style={{ margin: 'auto' }}><MiniSpinner /> {t('common.loading')}</div>
      </div>
    )
  }

  const editorInSidebar = store.editorSurface === 'sidebar'
  const browsing = view === 'explorer' || view === 'search' || view === 'scm' || view === 'history'
  const showEditorWithView = editorInSidebar && browsing && store.tabs.length > 0

  /**
   * One panel body. Every visited panel stays MOUNTED (hidden by CSS), which
   * is what keeps the explorer's listings / expansion set — and the terminal's
   * connection — alive across rail switches: re-mounting used to refetch the
   * whole visible tree and flash a reload on every return.
   */
  const panelFor = (id: RailView): ReactNode => {
    switch (id) {
      case 'search': return <SearchView />
      case 'scm': return <ScmPanel onOpenHistory={() => go('history')} visible={panelLive('scm')} />
      case 'history': return <HistoryPanel />
      case 'terminal':
        // The terminal draws its own header + tab strip, so it takes the whole
        // slot (no extra padding wrapper).
        return <TerminalView t={t} hosts={store.hosts} visible={panelLive('terminal')} request={store.terminalRequest} />
      case 'workspaces':
        return (
          <div className="rvs-viewpad" style={{ height: '100%' }}>
            <WorkspacesView
              t={t}
              hosts={store.hosts}
              workspaces={store.workspaces}
              routing={store.routing}
              onChanged={store.refreshAll}
              onOpenFiles={(value) => { store.selectWorkspace(value); go('explorer') }}
            />
          </div>
        )
      case 'editor':
        // The sidebar editor is the FALLBACK surface, used only when the host
        // has no `conversation.view` slot to mount the editor in (index.tsx
        // stays on 'sidebar' then). It must not render while the centre surface
        // or the floating window owns the editor: all of them read the same
        // store, so two live editors for one tab fight over the scroll position
        // and the hidden one — sitting at scrollTop 0 — wins, which is exactly
        // why a tab switch kept snapping back to the top of the file.
        if (editorInSidebar) return <EditorPane visible={panelLive('editor')} />
        // Floating the editor away from the sidebar: the panel stays reachable
        // (so docking returns here) but shows where the editor went.
        return store.floatOpen ? <FloatingEditorPlaceholder /> : null
      default:
        return (
          <RemoteExplorer
            showHidden={showHidden}
            onToggleHidden={() => setShowHidden(v => !v)}
            visible={panelLive('explorer')}
          />
        )
    }
  }

  // Without a conversation-view slot the editor has no center tab, so it keeps
  // its rail entry (and the split) — the older layout, still fully reachable.
  const editorInStack = editorInSidebar && !showEditorWithView

  const panel = (
    <div className="rvs-pane grow">
      {[...mounted].map(id => (
        <div
          key={id}
          className="rvs-viewslot"
          // The editor slot stays MOUNTED even while the split renders the
          // divider copy below: removing it from this list unmounted the
          // panel, so leaving the split and re-entering it rebuilt the editor
          // and dropped its local undo/scroll state. Hidden, not removed —
          // that is also what keeps two live buffers from fighting.
          style={{ display: view === id && !(showEditorWithView && id === 'editor') ? 'flex' : 'none' }}
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
      <div className="rvs-rail">
        {railButton('explorer', t('tab.files'), <IconCode size={17} />)}
        {railButton('search', t('tab.search'), <IconSearch size={17} />)}
        {railButton('scm', t('tab.git'), <IconBranch size={17} />, store.buckets.total)}
        {railButton('history', t('tab.history'), <IconHistory size={17} />)}
        <div className="rvs-rail-sep" />
        {editorInStack && store.tabs.length > 0
          && railButton('editor', store.activeTab?.rel.split('/').pop() ?? t('tab.editor'), <IconDiff size={17} />, store.tabs.length)}
        {railButton('terminal', t('tab.terminal'), <IconTerminal size={17} />)}
        {railButton('workspaces', t('tab.workspaces'), <IconServer size={17} />, store.workspaces.length)}
      </div>
      <div className="rvs-column" ref={columnRef}>
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
          {store.repoRoot !== undefined && store.head !== undefined && (
            <span className="rvs-pill" title={store.repoRoot}>
              ⑂ {store.head.detached ? t('scm.detached') : store.head.branch}
              {store.head.ahead > 0 && ` ↑${store.head.ahead}`}
              {store.head.behind > 0 && ` ↓${store.head.behind}`}
            </span>
          )}
          {store.gitBusy && <MiniSpinner />}
        </div>
        {store.error !== undefined && <div className="rvs-banner error">{store.error}</div>}
        {/* The split must not change the TYPE of the element at this position.
            It used to swap a Fragment for a `div` here, and React reconciles
            by type — so every flip deleted and remounted the whole subtree,
            which is the kept-alive panel stack (`panel` below). Consequences
            were exactly what the keep-alive design exists to prevent: the
            explorer re-listed over SFTP and lost its expansion, and every
            xterm was torn down and rebuilt, closing its WebSocket and
            orphaning a tab whose session id had not arrived yet. Same element,
            different props, always. */}
        <div
          className="rvs-pane"
          style={showEditorWithView ? { height: `${Math.round(split * 1000) / 10}%`, flex: 'none', minHeight: 0 } : { flex: 1, minHeight: 0 }}
        >
          {panel}
        </div>
        {showEditorWithView && (
          <>
            <div
              className="rvs-vsplit-handle"
              data-dragging={dragging ? 'true' : 'false'}
              onPointerDown={onDividerDown}
              onPointerMove={onDividerMove}
              onPointerUp={onDividerEnd}
              onPointerCancel={onDividerEnd}
              title={t('editor.resizeHint')}
            />
            <div className="rvs-pane grow">
              <EditorPane visible={live} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
