/**
 * Terminal view: one xterm per connection, refresh-safe reattach by stored
 * server session id, explicit disconnect (kills the remote shell).
 */
import { useState, type ReactNode } from 'react'
import type { RemoteHostSummary } from '../protocol.ts'
import { RemoteApiError, api } from './api.ts'
import { XTerm } from './XTerm.tsx'
import { Btn, Notice, Row, optionStyle, selectStyle } from './ui.tsx'

function sessionStoreKey(alias: string): string {
  return `dsh-remote-vs.term.${alias}`
}

function loadStoredSession(alias: string): string | undefined {
  try {
    return localStorage.getItem(sessionStoreKey(alias)) ?? undefined
  } catch {
    return undefined
  }
}

function storeSession(alias: string, id: string): void {
  try {
    localStorage.setItem(sessionStoreKey(alias), id)
  } catch {
    // Private mode: ignore.
  }
}

function clearStoredSession(alias: string): void {
  try {
    localStorage.removeItem(sessionStoreKey(alias))
  } catch {
    // Ignore.
  }
}

export function TerminalView(props: { t: (k: string) => string; hosts: RemoteHostSummary[]; visible: boolean }): ReactNode {
  const t = props.t
  const [alias, setAlias] = useState<string>(() => {
    try {
      return localStorage.getItem('dsh-remote-vs.term.alias') ?? ''
    } catch {
      return ''
    }
  })
  const [connKey, setConnKey] = useState(0)
  const [connected, setConnected] = useState(false)
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)
  const [exitMsg, setExitMsg] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const effectiveAlias = alias !== '' ? alias : (props.hosts[0]?.alias ?? '')

  const connect = (fresh: boolean): void => {
    if (effectiveAlias === '') return
    try {
      localStorage.setItem('dsh-remote-vs.term.alias', effectiveAlias)
    } catch {
      // Ignore.
    }
    if (fresh) {
      const stale = loadStoredSession(effectiveAlias)
      if (stale !== undefined) {
        // Best-effort kill of the orphaned shell before opening a new one.
        api.terminalClose(stale).catch(() => undefined)
      }
      clearStoredSession(effectiveAlias)
    }
    setExitMsg(undefined)
    setError(undefined)
    setSessionId(undefined)
    setConnKey((k) => k + 1)
    setConnected(true)
  }

  const disconnect = (kill: boolean): void => {
    const id = sessionId ?? (effectiveAlias !== '' ? loadStoredSession(effectiveAlias) : undefined)
    if (kill && id !== undefined) {
      api.terminalClose(id).then(
        () => undefined,
        (e: unknown) => setError(e instanceof RemoteApiError ? e.message : String(e)),
      )
    }
    if (effectiveAlias !== '') clearStoredSession(effectiveAlias)
    setConnected(false)
    setSessionId(undefined)
  }

  const storedId = effectiveAlias !== '' ? loadStoredSession(effectiveAlias) : undefined
  const wsUrl = connected && effectiveAlias !== ''
    ? api.terminalUrl({ ...(storedId !== undefined ? { session: storedId } : { alias: effectiveAlias }), cols: 80, rows: 24 })
    : undefined

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ flex: 'none' }}>
      <Row>
        <span style={{ fontSize: 12, opacity: 0.75 }}>{t('term.selectHost')}</span>
        <select
          value={effectiveAlias}
          disabled={connected || props.hosts.length === 0}
          onChange={(e) => setAlias(e.target.value)}
          style={{ ...selectStyle, flex: 1 }}
        >
          {props.hosts.map((h) => <option key={h.alias} value={h.alias} style={optionStyle}>{h.alias} ({h.user}@{h.host})</option>)}
        </select>
        {!connected ? (
          <Btn kind="primary" onClick={() => connect(false)} disabled={effectiveAlias === ''}>{t('term.connect')}</Btn>
        ) : (
          <>
            <Btn onClick={() => connect(true)}>{t('term.reconnect')}</Btn>
            <Btn kind="danger" onClick={() => disconnect(true)}>{t('term.disconnect')}</Btn>
          </>
        )}
      </Row>
      {error !== undefined && <Notice kind="error">{error}</Notice>}
      {exitMsg !== undefined && !connected && <Notice kind="info">{exitMsg}</Notice>}
      </div>
      <div style={{ marginTop: 8, flex: 1, minHeight: 240, border: '1px solid rgba(127,127,127,.25)', borderRadius: 6, overflow: 'hidden', background: 'rgba(0,0,0,.25)' }}>
        {connected && wsUrl !== undefined ? (
          <XTerm
            key={`${effectiveAlias}:${connKey}`}
            wsUrl={wsUrl}
            visible={props.visible}
            onReady={(id) => {
              setSessionId(id)
              storeSession(effectiveAlias, id)
            }}
            onExit={(code, message) => {
              if (message === 'terminal session expired') {
                // Stale reattach: drop the id and retry once with a fresh shell.
                clearStoredSession(effectiveAlias)
                setSessionId(undefined)
                setConnKey((k) => k + 1)
                return
              }
              // The shell is gone: drop the id and return to the connect UI.
              clearStoredSession(effectiveAlias)
              setSessionId(undefined)
              setConnected(false)
              setExitMsg(code === null ? (message ?? t('term.closed')) : `exit ${code}`)
            }}
          />
        ) : (
          <div style={{ padding: 12, opacity: 0.6, fontSize: 12 }}>{t('term.selectHost')}</div>
        )}
      </div>
    </div>
  )
}
