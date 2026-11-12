/**
 * Terminal view: a tab strip of independent remote shells under the host
 * picker. Each tab owns its own WebSocket and xterm instance, so several
 * sessions (or several hosts) can run side by side; hidden tabs stay MOUNTED,
 * which is what keeps their scrollback and running command alive.
 *
 * A tab is refresh-safe: the server session id is persisted, so reloading the
 * GUI reattaches to the still-running shell instead of spawning a new one.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { RemoteHostSummary } from '../protocol.ts'
import { RemoteApiError, api } from './api.ts'
import { XTerm } from './XTerm.tsx'
import { cdCommand } from './shell.ts'
import type { TerminalRequest } from './store.tsx'
import { optionStyle } from './ui.tsx'
import {
  IconButton,
  IconClose,
  IconPlus,
  IconTerminal,
  confirmDialog,
} from './vsc/kit.tsx'

const ALIAS_KEY = 'dsh-remote-vs.term.alias'
const TABS_KEY = 'dsh-remote-vs.term.tabs'

interface TermTab {
  /** Local identity (React key + storage identity). */
  id: string
  alias: string
  /** Server session id once the shell is up (enables reattach). */
  session?: string
  /** Bumped to force a fresh connection (connect / reconnect). */
  nonce: number
  connected: boolean
  /** Command typed once the shell reports ready (a menu entry's `cd`). */
  initialCommand?: string
  /** Human-readable reason the tab is not connected. */
  note?: string
}

interface StoredTab {
  id: string
  alias: string
  session?: string
}

function readAlias(): string {
  try {
    return localStorage.getItem(ALIAS_KEY) ?? ''
  } catch {
    return ''
  }
}

function readStoredTabs(): StoredTab[] {
  try {
    const raw = localStorage.getItem(TABS_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: StoredTab[] = []
    for (const row of parsed) {
      if (typeof row !== 'object' || row === null) continue
      const { id, alias, session } = row as { id?: unknown; alias?: unknown; session?: unknown }
      if (typeof id !== 'string' || typeof alias !== 'string') continue
      out.push(session === undefined || typeof session !== 'string' ? { id, alias } : { id, alias, session })
    }
    return out
  } catch {
    return []
  }
}

function persistTabs(tabs: TermTab[]): void {
  try {
    const rows: StoredTab[] = tabs.map(tab => (tab.session === undefined
      ? { id: tab.id, alias: tab.alias }
      : { id: tab.id, alias: tab.alias, session: tab.session }))
    localStorage.setItem(TABS_KEY, JSON.stringify(rows))
  } catch {
    // Private mode: ignore.
  }
}

function newId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * The last "open a terminal here" request this page already acted on.
 *
 * Module scope, not a component ref: the panel is normally kept mounted, but a
 * remount would reset a ref and re-open a tab for the SAME old request. A new
 * request always carries a larger id, so one counter serves both goals.
 */
let openedTerminalRequest = 0

/**
 * Which mounted terminal surface owns the view (one at a time).
 *
 * The native right-sidebar fallback mounts a `RemoteRoot` per session that
 * opened the remote page, so two `TerminalView`s can be alive at once. They
 * share one localStorage tab list and one module-level request counter, so
 * without an owner the hidden instance can steal an "open terminal here"
 * request (its tab is invisible), and both instances keep XTerm sockets for the
 * same stored session ids (duplicate input, last-writer-wins tabs). The owner is
 * the surface on screen; only it renders the terminal UI and persists the tab
 * list, so exactly one instance holds sockets for a given session.
 */
let terminalOwner: symbol | undefined
const terminalOwnerListeners = new Set<() => void>()

function publishTerminalOwner(next: symbol): void {
  if (terminalOwner === next) return
  terminalOwner = next
  for (const listener of [...terminalOwnerListeners]) listener()
}

function subscribeTerminalOwner(listener: () => void): () => void {
  terminalOwnerListeners.add(listener)
  return () => {
    terminalOwnerListeners.delete(listener)
  }
}

/** First mount claims the panel, so a single-surface profile renders at once. */
export function claimTerminalOwnerIfNone(id: symbol): void {
  if (terminalOwner === undefined) publishTerminalOwner(id)
}

/** Whether `id` is the surface that currently owns the terminal panel. */
export function terminalSurfaceOwnedBy(owner: symbol | undefined, id: symbol): boolean {
  return owner === id
}

/** Why a terminal connection ended — and therefore whether the shell may live on. */
export type TerminalExitKind =
  /** The socket went away; the Host keeps the PTY for 10 minutes and can reattach. */
  | 'reattach'
  /** The remote shell really exited (or refused the connection at the shell level). */
  | 'exited'
  /** The Host no longer knows this session id: drop it and open a fresh shell. */
  | 'expired'

/** Failures that are about the socket, not about the shell inside it. */
const SOCKET_LEVEL_MESSAGES = new Set(['websocket refused', 'websocket error'])

/**
 * Classify one terminal exit report.
 *
 * `XTerm` reports the ssh channel's exit code and, for socket-level problems, a
 * message with `code === null`. A socket that closes with neither (page reload,
 * network blip, laptop sleep) must NOT destroy the tab's `session` id: the Host
 * keeps the PTY for `EMPTY_SOCKET_TTL_MS`, so the right answer is "keep the id,
 * offer a reattach". Only a real exit (a code, or a shell-level error message)
 * ends the session.
 */
export function classifyTerminalExit(code: number | null, message: string | undefined): TerminalExitKind {
  if (message === 'terminal session expired') return 'expired'
  if (code !== null) return 'exited'
  if (message === undefined || SOCKET_LEVEL_MESSAGES.has(message)) return 'reattach'
  return 'exited'
}

/** What one tab should look like after an exit report. */
export interface TerminalExitState {
  connected: boolean
  /** Kept for `reattach`, cleared for `exited`/`expired`. */
  session: string | undefined
  kind: TerminalExitKind
  /** i18n key for the note, when the note is a fixed sentence. */
  noteKey?: 'term.disconnected' | 'term.closed'
  /** Literal note (exit code or a host message), when it is not a fixed sentence. */
  noteText?: string
}

/** Apply {@link classifyTerminalExit} to one tab. Pure, so the gate can pin it. */
export function terminalExitState(
  tab: { session?: string },
  code: number | null,
  message: string | undefined,
): TerminalExitState {
  const kind = classifyTerminalExit(code, message)
  if (kind === 'expired') return { connected: false, session: undefined, kind }
  if (kind === 'reattach') return { connected: false, session: tab.session, kind, noteKey: 'term.disconnected' }
  return {
    connected: false,
    session: undefined,
    kind,
    ...(code === null
      ? (message === undefined ? { noteKey: 'term.closed' as const } : { noteText: message })
      : { noteText: `exit ${code}` }),
  }
}

export function TerminalView(props: {
  t: (key: string) => string
  hosts: RemoteHostSummary[]
  visible: boolean
  /** A pending "open a terminal here" request from the search results' menu. */
  request?: TerminalRequest
}): ReactNode {
  const t = props.t
  /** This mounted surface's identity in the one-owner arbitration (see above). */
  const surfaceId = useRef<symbol>(Symbol('terminal-surface'))
  // First mount claims the panel before the first paint, so a profile with one
  // surface (the normal better-sidebar case) renders immediately.
  claimTerminalOwnerIfNone(surfaceId.current)
  const owner = useSyncExternalStore(
    subscribeTerminalOwner,
    () => terminalSurfaceOwnedBy(terminalOwner, surfaceId.current),
  )
  const [alias, setAlias] = useState<string>(readAlias)
  const [tabs, setTabs] = useState<TermTab[]>(() => readStoredTabs().map(row => ({
    id: row.id,
    alias: row.alias,
    ...(row.session === undefined ? {} : { session: row.session }),
    nonce: 0,
    connected: true,
  })))
  const [activeId, setActiveId] = useState<string | undefined>(() => tabs[0]?.id)

  const effectiveAlias = (alias !== '' && props.hosts.some(host => host.alias === alias))
    ? alias
    : (props.hosts[0]?.alias ?? '')

  // The surface on screen takes the panel over from a hidden one (per-session
  // native pages mount several instances). Last-visible wins; the hidden one
  // stops rendering (and closes its sockets) instead of writing the same
  // localStorage tab list behind the owner's back.
  const wasOwner = useRef(false)
  useEffect(() => {
    if (!owner) {
      wasOwner.current = false
      return
    }
    // Regaining the panel: the sessions this surface knew about may still be
    // alive on the Host (10-minute reattach window), and their sockets were
    // closed when ownership left. Reattach them instead of making the user click
    // "Reconnect" for every tab; a tab whose shell really exited has no session
    // id and stays dead.
    const reclaim = !wasOwner.current
    wasOwner.current = true
    if (!reclaim) return
    setTabs(prev => prev.map(tab => (
      !tab.connected && tab.session !== undefined
        ? { ...tab, connected: true, nonce: tab.nonce + 1, note: undefined }
        : tab
    )))
  }, [owner])

  useEffect(() => {
    if (props.visible) publishTerminalOwner(surfaceId.current)
  }, [props.visible])

  useEffect(() => {
    if (!owner) return
    try {
      localStorage.setItem(ALIAS_KEY, effectiveAlias)
    } catch {
      // Ignore.
    }
  }, [effectiveAlias, owner])

  useEffect(() => {
    // Only the owner persists: two instances writing one key is last-writer-wins
    // and can resurrect a hidden surface's stale list over the visible one.
    if (!owner) return
    persistTabs(tabs)
  }, [tabs, owner])

  // A restored tab whose host no longer exists cannot reattach.
  useEffect(() => {
    if (props.hosts.length === 0) return
    setTabs(prev => prev.filter(tab => props.hosts.some(host => host.alias === tab.alias)))
  }, [props.hosts])

  const patchTab = useCallback((id: string, next: Partial<TermTab>): void => {
    setTabs(prev => prev.map(tab => (tab.id === id ? { ...tab, ...next } : tab)))
  }, [])

  const openTab = useCallback((host: string, initialCommand?: string): void => {
    if (host === '') return
    const tab: TermTab = {
      id: newId(),
      alias: host,
      nonce: 0,
      connected: true,
      ...(initialCommand === undefined ? {} : { initialCommand }),
    }
    setTabs(prev => [...prev, tab])
    setActiveId(tab.id)
  }, [])

  /**
   * "Open a terminal here" (a search result's menu): open one tab whose shell
   * lands in that folder, on the host the folder BELONGS to.
   *
   * The alias must come from the request, not from `effectiveAlias`: the panel
   * remembers whatever host the user last ran a shell on, so a menu action on a
   * workspace bound elsewhere used to open the shell on the wrong machine and
   * the `cd` failed with "No such file or directory" for a path that is fine on
   * its own host.
   *
   * The folder is reached by TYPING `cd` once the PTY reports ready (see
   * `XTerm`'s `initialInput`) — the host's terminal route has no "start in this
   * directory" parameter, and inventing one would mean a host-side change for a
   * display feature. The request id makes a repeat for the same folder still
   * open a second tab.
   */
  useEffect(() => {
    const request = props.request
    if (request === undefined || request.id === openedTerminalRequest) return
    // Only the surface actually on screen may consume the request: with several
    // per-session instances mounted, a hidden one consuming it opened the tab
    // where nobody could see it while the visible panel stayed empty. The
    // owner flag turns true together with `visible`, and this effect re-runs
    // when either changes, so the request is not lost — it is just owned by the
    // right surface.
    if (!owner || props.visible !== true) return
    openedTerminalRequest = request.id
    const target = request.alias !== '' && props.hosts.some(host => host.alias === request.alias)
      ? request.alias
      : effectiveAlias
    // Keep the header picker in step with the tab that just opened, so the next
    // "+" continues on the same host.
    if (target !== alias) setAlias(target)
    openTab(target, cdCommand(request.dir))
  }, [props.request, props.hosts, effectiveAlias, alias, openTab, owner, props.visible])

  const closeTab = useCallback(async (tab: TermTab): Promise<void> => {
    const ok = await confirmDialog({
      title: t('term.closeTitle'),
      text: `${tab.alias}${tab.session === undefined ? '' : ` · ${tab.session.slice(0, 8)}`}`,
      danger: true,
      okText: t('term.close'),
    })
    if (!ok) return
    if (tab.session !== undefined) {
      api.terminalClose(tab.session).catch(() => undefined)
    }
    // Compute the next tabs OUTSIDE the updater. A state updater must be pure:
    // React may run it more than once for the same update (StrictMode, or a
    // replay after a higher-priority render), and the old form dispatched
    // setState — and, in reconnect, a terminalClose network call — from inside
    // one, so those side effects can happen twice.
    setTabs(prev => prev.filter(item => item.id !== tab.id))
    const remaining = tabs.filter(item => item.id !== tab.id)
    setActiveId(current => (current === tab.id ? remaining[remaining.length - 1]?.id : current))
  }, [t, tabs])

  const reconnect = useCallback((id: string, fresh: boolean): void => {
    if (fresh) {
      const target = tabs.find(tab => tab.id === id)
      if (target?.session !== undefined) api.terminalClose(target.session).catch(() => undefined)
    }
    setTabs(prev => prev.map(tab => {
      if (tab.id !== id) return tab
      return {
        ...tab,
        nonce: tab.nonce + 1,
        connected: true,
        note: undefined,
        ...(fresh ? { session: undefined } : {}),
      }
    }))
  }, [tabs])

  const active = tabs.find(tab => tab.id === activeId) ?? tabs[0]

  const labelFor = (tab: TermTab): string => {
    const siblings = tabs.filter(item => item.alias === tab.alias)
    const index = siblings.findIndex(item => item.id === tab.id) + 1
    // `baseName` was a no-op here: host aliases are validated server-side
    // against [A-Za-z0-9._-]{1,64} (store.ts), so an alias can never contain a
    // slash for baseName to strip — and the `|| tab.alias` fallback was
    // unreachable. Reading it suggested aliases might be paths.
    const name = tab.alias
    return siblings.length > 1 ? `${name} #${index}` : name
  }

  if (!owner) {
    // A hidden per-session surface: the visible one owns the terminal panel.
    // Rendering here would mount a second XTerm per stored session (duplicate
    // sockets/input) and its tab list would race the owner's on localStorage.
    return null
  }

  return (
    <div className="rvs-pane grow">
      <div className="rvs-header">
        <span className="rvs-title">{t('tab.terminal')}</span>
        <select
          className="rvs-select"
          value={effectiveAlias}
          onChange={(e) => setAlias(e.target.value)}
          disabled={props.hosts.length === 0}
          title={t('term.selectHost')}
          style={{ flex: 1, minWidth: 90 }}
        >
          {props.hosts.map(host => (
            <option key={host.alias} value={host.alias} style={optionStyle}>
              {host.alias} ({host.user}@{host.host})
            </option>
          ))}
        </select>
        <IconButton
          title={t('term.new')}
          onClick={() => openTab(effectiveAlias)}
          disabled={effectiveAlias === ''}
        >
          <IconPlus size={15} />
        </IconButton>
      </div>

      {props.hosts.length === 0 && <div className="rvs-banner warn">{t('term.noHosts')}</div>}

      <div className="rvs-term-tabs" role="tablist">
        {tabs.map(tab => (
          // The close affordance is a SIBLING button, not a span inside the tab
          // button: a nested interactive element is invalid, and with
          // `role="presentation"` on it the only way to close a tab was the
          // mouse — no keyboard path existed at all. Split out, the tab keeps
          // role="tab" and the ✕ is a real focusable button.
          <span key={tab.id} className="rvs-term-tabwrap">
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === active?.id}
              className={`rvs-term-tab${tab.id === active?.id ? ' active' : ''}${tab.note === undefined ? '' : ' dead'}`}
              title={`${tab.alias}${tab.session === undefined ? '' : `\n${tab.session}`}`}
              onClick={() => setActiveId(tab.id)}
              onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); void closeTab(tab) } }}
            >
              <IconTerminal size={13} />
              <span className="rvs-term-name">{labelFor(tab)}</span>
            </button>
            <button
              type="button"
              className="rvs-etab-close"
              aria-label={t('term.close')}
              title={t('term.close')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { void closeTab(tab) }}
            >
              <IconClose size={11} />
            </button>
          </span>
        ))}
        <button
          type="button"
          className="rvs-term-tab"
          title={t('term.new')}
          onClick={() => openTab(effectiveAlias)}
          disabled={effectiveAlias === ''}
          style={{ padding: '0 8px' }}
        >
          <IconPlus size={13} />
        </button>
      </div>

      <div className="rvs-term-body">
        {tabs.length === 0 && (
          <div className="rvs-empty">{t('term.empty')}</div>
        )}
        {tabs.map(tab => (
          <div
            key={tab.id}
            className="rvs-term-slot"
            style={{ display: tab.id === active?.id ? 'block' : 'none' }}
          >
            {tab.connected ? (
              <XTerm
                key={`${tab.id}:${tab.nonce}`}
                wsUrl={api.terminalUrl({
                  ...(tab.session === undefined ? { alias: tab.alias } : { session: tab.session }),
                  cols: 80,
                  rows: 24,
                })}
                visible={props.visible && tab.id === active?.id}
                t={t}
                {...(tab.initialCommand === undefined ? {} : { initialInput: tab.initialCommand })}
                onReady={(id) => patchTab(tab.id, { session: id, connected: true, note: undefined })}
                onExit={(code, message) => {
                  // A socket that goes away is NOT the shell exiting: the Host
                  // keeps the PTY for 10 minutes, so keeping `session` is what
                  // makes the reconnect a reattach instead of a new shell. Only
                  // a real exit (or an expired id) drops it.
                  const exitState = terminalExitState(tab, code, message)
                  if (exitState.kind === 'expired') {
                    // Stale reattach: drop the id and retry once with a fresh shell.
                    patchTab(tab.id, { session: undefined, nonce: tab.nonce + 1, connected: true, note: undefined })
                    return
                  }
                  patchTab(tab.id, {
                    connected: exitState.connected,
                    session: exitState.session,
                    note: exitState.noteText ?? (exitState.noteKey === undefined ? undefined : t(exitState.noteKey)),
                  })
                }}
              />
            ) : (
              <div className="rvs-term-dead">
                {tab.note !== undefined && <div className="rvs-empty">{tab.note}</div>}
                <div className="rvs-commit-row" style={{ justifyContent: 'center' }}>
                  <button
                    type="button"
                    className="rvs-chip primary"
                    // A tab that still knows its Host session id reattaches to
                    // the live shell; only a tab without one opens a fresh shell.
                    onClick={() => reconnect(tab.id, tab.session === undefined)}
                  >
                    {t('term.reconnect')}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
