/**
 * Terminal view: a tab strip of independent remote shells under the host
 * picker. Each tab owns its own WebSocket and xterm instance, so several
 * sessions (or several hosts) can run side by side; hidden tabs stay MOUNTED,
 * which is what keeps their scrollback and running command alive.
 *
 * A tab is refresh-safe: the server session id is persisted, so reloading the
 * GUI reattaches to the still-running shell instead of spawning a new one.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { RemoteHostSummary } from '../protocol.ts'
import { RemoteApiError, api } from './api.ts'
import { XTerm } from './XTerm.tsx'
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

export function TerminalView(props: {
  t: (key: string) => string
  hosts: RemoteHostSummary[]
  visible: boolean
}): ReactNode {
  const t = props.t
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

  useEffect(() => {
    try {
      localStorage.setItem(ALIAS_KEY, effectiveAlias)
    } catch {
      // Ignore.
    }
  }, [effectiveAlias])

  useEffect(() => {
    persistTabs(tabs)
  }, [tabs])

  // A restored tab whose host no longer exists cannot reattach.
  useEffect(() => {
    if (props.hosts.length === 0) return
    setTabs(prev => prev.filter(tab => props.hosts.some(host => host.alias === tab.alias)))
  }, [props.hosts])

  const patchTab = useCallback((id: string, next: Partial<TermTab>): void => {
    setTabs(prev => prev.map(tab => (tab.id === id ? { ...tab, ...next } : tab)))
  }, [])

  const openTab = useCallback((host: string): void => {
    if (host === '') return
    const tab: TermTab = { id: newId(), alias: host, nonce: 0, connected: true }
    setTabs(prev => [...prev, tab])
    setActiveId(tab.id)
  }, [])

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
                onReady={(id) => patchTab(tab.id, { session: id, connected: true, note: undefined })}
                onExit={(code, message) => {
                  if (message === 'terminal session expired') {
                    // Stale reattach: drop the id and retry once with a fresh shell.
                    patchTab(tab.id, { session: undefined, nonce: tab.nonce + 1, connected: true, note: undefined })
                    return
                  }
                  patchTab(tab.id, {
                    connected: false,
                    session: undefined,
                    note: code === null ? (message ?? t('term.closed')) : `exit ${code}`,
                  })
                }}
              />
            ) : (
              <div className="rvs-term-dead">
                {tab.note !== undefined && <div className="rvs-empty">{tab.note}</div>}
                <div className="rvs-commit-row" style={{ justifyContent: 'center' }}>
                  <button type="button" className="rvs-chip primary" onClick={() => reconnect(tab.id, true)}>
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
