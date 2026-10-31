/**
 * Connection status for the workspace on screen.
 *
 * Two renderings, one source of truth: a chip in the remote surface's top bar
 * (dot + label) and a compact dot in the editor's info bar. Clicking an errored
 * chip retries the connection; the Host's pool records the attempt, and the next
 * status poll (or the retry itself) repaints the chip.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from './api.ts'
import { applyConnectionStatuses, useConnectionStatus, type ConnectionState, type ConnectionView } from './connection.ts'
import { useExplorer } from './store.tsx'
import { MiniSpinner } from './vsc/kit.tsx'

/** Literal translator calls (a lookup table would hide the keys from the scan). */
function labelOf(state: ConnectionState, t: (key: string) => string): string {
  if (state === 'ok') return t('connection.ok')
  if (state === 'error') return t('connection.error')
  return t('connection.idle')
}

/** One-line diagnostic for the chip's tooltip. */
function titleOf(connection: ConnectionView, t: (key: string) => string): string {
  const parts = [`${connection.alias} · ${labelOf(connection.state, t)}`]
  if (connection.state === 'error' && connection.error !== undefined) parts.push(connection.error)
  if (connection.state === 'ok' && connection.okAt !== undefined) {
    parts.push(`${t('connection.lastOk')} ${new Date(connection.okAt).toLocaleTimeString()}`)
  }
  if (connection.state === 'error') parts.push(t('connection.retryHint'))
  return parts.join('\n')
}

export function ConnectionStatusChip(props: { compact?: boolean }): ReactNode {
  const store = useExplorer()
  const t = store.t
  const alias = store.workspace?.alias ?? ''
  const connection = useConnectionStatus()
  const [retrying, setRetrying] = useState(false)
  const alive = useRef(true)
  useEffect(() => () => {
    alive.current = false
  }, [])

  const retry = async (): Promise<void> => {
    if (alias === '' || retrying) return
    setRetrying(true)
    try {
      // The Host records the attempt in the pool (success clears the error,
      // failure records it); refresh right after so the chip reflects it now.
      await api.testHost(alias)
      applyConnectionStatuses(await api.connectionStatus())
    } catch {
      // A transport failure already marked the alias through `call`; a poll
      // will confirm it. Nothing useful to report twice.
    } finally {
      if (alive.current) setRetrying(false)
    }
  }

  if (alias === '' || connection === undefined) return null
  const clickable = connection.state === 'error' && !retrying
  return (
    <button
      type="button"
      className={`rvs-conn rvs-conn-${connection.state}${props.compact === true ? ' compact' : ''}${clickable ? ' clickable' : ''}`}
      title={titleOf(connection, t)}
      aria-label={labelOf(connection.state, t)}
      onClick={() => { if (clickable) void retry() }}
    >
      <span className="rvs-conn-dot" aria-hidden="true" />
      {retrying && <MiniSpinner />}
      {props.compact !== true && <span className="rvs-conn-label">{retrying ? t('connection.retrying') : labelOf(connection.state, t)}</span>}
    </button>
  )
}
