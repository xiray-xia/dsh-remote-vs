/**
 * Connection status for the workspace on screen.
 *
 * Two renderings, one source of truth: a chip in the remote surface's top bar
 * (dot + label) and a compact dot in the editor's info bar. The chip is a
 * read-out in the healthy states and a RETRY control in the errored one.
 *
 * An errored link self-heals: a bounded auto-retry (one dial per tick, at most
 * AUTO_RETRY_MAX_ATTEMPTS in a row) runs while the page is visible, so a network
 * that comes back does not need a user action. It stops after the budget and
 * leaves the manual click — repeated dials against a password-auth host can
 * count towards a lockout, so this is deliberately not an endless loop.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from './api.ts'
import {
  applyConnectionStatuses,
  AUTO_RETRY_MAX_ATTEMPTS,
  AUTO_RETRY_MS,
  connectionLabelKey,
  consumeAutoRetry,
  markConnectionProbeOk,
  useConnectionStatus,
  type ConnectionView,
} from './connection.ts'
import { useExplorer } from './store.tsx'
import { MiniSpinner } from './vsc/kit.tsx'

/** Tooltip: alias, state, the last failure (with its time) or the last success. */
function titleOf(connection: ConnectionView, t: (key: string) => string): string {
  const parts = [`${connection.alias} · ${t(connectionLabelKey(connection.state))}`]
  if (connection.state === 'error') {
    if (connection.errorAt !== undefined) {
      parts.push(`${t('connection.errorAt')} ${new Date(connection.errorAt).toLocaleTimeString()}`)
    }
    if (connection.error !== undefined) parts.push(`${t('connection.detail')}: ${connection.error}`)
    parts.push(t('connection.retryHint'))
  }
  if (connection.state === 'ok' && connection.okAt !== undefined) {
    parts.push(`${t('connection.lastOk')} ${new Date(connection.okAt).toLocaleTimeString()}`)
  }
  return parts.join('\n')
}

export function ConnectionStatusChip(props: { compact?: boolean }): ReactNode {
  const store = useExplorer()
  const t = store.t
  const alias = store.workspace?.alias ?? ''
  const connection = useConnectionStatus()
  const [retrying, setRetrying] = useState(false)
  const alive = useRef(true)
  /** Consecutive automatic attempts for the CURRENT error episode. */
  const autoAttempts = useRef(0)
  const busy = useRef(false)
  useEffect(() => () => {
    alive.current = false
  }, [])

  const attempt = async (): Promise<void> => {
    if (alias === '' || busy.current) return
    busy.current = true
    setRetrying(true)
    try {
      // The Host records the attempt in the pool (success clears the error,
      // failure records it); refresh right after so the chip reflects it now.
      const result = await api.testHost(alias)
      // A stale poll error must not undo a retry that just proved the link alive.
      if (result.ok) markConnectionProbeOk(alias)
      applyConnectionStatuses(await api.connectionStatus())
    } catch {
      // A transport failure already marked the alias through `call`; the next
      // poll confirms it.
    } finally {
      busy.current = false
      if (alive.current) setRetrying(false)
    }
  }

  // A broken link is retried on its own, within a budget, while the page is
  // visible. Recovery otherwise waits for the user to touch something.
  const errored = connection?.state === 'error'
  // The budget belongs to ONE error episode on ONE host: switching to another
  // errored workspace must not inherit a spent budget.
  useEffect(() => {
    autoAttempts.current = 0
  }, [alias])
  useEffect(() => {
    if (!errored || alias === '') {
      if (!errored) autoAttempts.current = 0
      return
    }
    const timer = window.setInterval(() => {
      if (document.hidden) return
      const plan = consumeAutoRetry(errored ? 'error' : 'idle', autoAttempts.current)
      autoAttempts.current = plan.attempts
      if (!plan.run) {
        window.clearInterval(timer)
        return
      }
      void attempt()
    }, AUTO_RETRY_MS)
    return () => window.clearInterval(timer)
    // `attempt` is recreated each render; the interval only needs the episode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errored, alias])

  if (alias === '' || connection === undefined) return null
  const label = retrying ? t('connection.retrying') : t(connectionLabelKey(connection.state))
  const className = `rvs-conn rvs-conn-${connection.state}${props.compact === true ? ' compact' : ''}${errored ? ' clickable' : ''}`
  const title = titleOf(connection, t)
  if (!errored) {
    // A healthy/idle read-out must not be a button whose click does nothing.
    return (
      <span className={className} title={title} role="status" aria-label={label}>
        <span className="rvs-conn-dot" aria-hidden="true" />
        {props.compact !== true && <span className="rvs-conn-label">{label}</span>}
      </span>
    )
  }
  // Errored stays a BUTTON even while an automatic attempt is in flight: that
  // dial can take the whole ready-timeout, and hiding the manual affordance for
  // its duration is exactly when the user reaches for it.
  return (
    <button type="button" className={className} title={title} aria-label={label} aria-busy={retrying} onClick={() => { void attempt() }}>
      <span className="rvs-conn-dot" aria-hidden="true" />
      {retrying && <MiniSpinner />}
      {props.compact !== true && <span className="rvs-conn-label">{label}</span>}
    </button>
  )
}
