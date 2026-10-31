/**
 * Client-side view of the Host's per-alias SSH connection health.
 *
 * The browser never speaks SSH: every remote call is an HTTP request to the
 * local Host, which fails (or succeeds) on its own. So the Host's pool is the
 * only place that knows whether the link is up, and this module polls it at a
 * low rate. An operation that fails with a TRANSPORT error is applied locally as
 * well, so the UI reacts immediately instead of waiting for the next poll.
 *
 * The two things this module must get right (and the gate pins):
 *  - a BUSINESS error (no such file, permission denied) is not a link problem;
 *    only transport-class messages move the state to `error`;
 *  - `idle` is not `error`: the pool is lazy and closes a connection after 30
 *    idle minutes, and the next operation dials again.
 */
import { useSyncExternalStore } from 'react'
import type { RemoteConnectionStatus } from '../protocol.ts'

export type ConnectionState = 'ok' | 'error' | 'idle'

/** What the UI renders for one alias. */
export interface ConnectionView {
  alias: string
  state: ConnectionState
  /** Last transport error message (only while state === 'error'). */
  error?: string
  /** When the Host last saw a transport error, epoch ms. */
  errorAt?: number
  /** When the Host last completed a dial / transport-level operation. */
  okAt?: number
  /** A pooled SSH connection is open right now (diagnostic detail only). */
  open: boolean
  /**
   * Client time of the last locally noted failure. A poll that still reports
   * the older success must not clear an error the page just saw.
   */
  notedAt?: number
}

/**
 * Transport-level failures, mirroring the Host's classifier (src/pool.ts). Kept
 * in sync deliberately: the client applies the same rule only to turn an
 * operation failure into an immediate indicator update.
 */
const CONNECTION_ERROR_RE = /not connected|no response from server|connection lost|connection refused|socket hang up|channel open failed|stalled|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|EPIPE|host .* was disconnected/i

/** Whether `error` (or its message) is a transport-level failure. */
export function isConnectionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message !== '' && CONNECTION_ERROR_RE.test(message)
}

let activeAlias = ''
const views = new Map<string, ConnectionView>()
const listeners = new Set<() => void>()
/** Last value handed to `useSyncExternalStore` — a new object only on change. */
let snapshot: ConnectionView | undefined

function notify(): void {
  for (const listener of listeners) listener()
}

/** Recompute the snapshot for the ACTIVE alias and wake subscribers. */
function refreshSnapshot(): void {
  const next = activeAlias === '' ? undefined : views.get(activeAlias)
  const same = next === snapshot
    || (next !== undefined && snapshot !== undefined
      && next.alias === snapshot.alias && next.state === snapshot.state
      && next.error === snapshot.error && next.errorAt === snapshot.errorAt
      && next.okAt === snapshot.okAt && next.open === snapshot.open && next.notedAt === snapshot.notedAt)
  if (same) return
  snapshot = next
  notify()
}

/** Point the view at the workspace the user is looking at. */
export function setActiveConnectionAlias(alias: string): void {
  if (alias === activeAlias) return
  activeAlias = alias
  refreshSnapshot()
}

/** The alias the surface currently belongs to ('' when none). */
export function activeConnectionAlias(): string {
  return activeAlias
}

/**
 * Apply the Host's status list. A host-reported success clears an error only
 * when it is NEWER than the local failure note: otherwise a poll that raced the
 * failing operation would flip the chip back to green while the toast still
 * says the request failed.
 */
export function applyConnectionStatuses(list: readonly RemoteConnectionStatus[]): void {
  for (const item of list) {
    const prev = views.get(item.alias)
    const keepLocalError = prev?.state === 'error' && item.state === 'ok'
      && prev.notedAt !== undefined && (item.okAt === undefined || item.okAt < prev.notedAt)
    if (keepLocalError) continue
    views.set(item.alias, {
      alias: item.alias,
      state: item.state,
      ...(item.error === undefined ? {} : { error: item.error }),
      ...(item.errorAt === undefined ? {} : { errorAt: item.errorAt }),
      ...(item.okAt === undefined ? {} : { okAt: item.okAt }),
      open: item.open,
    })
  }
  refreshSnapshot()
}

/** Record a transport failure the page just observed on `alias`. */
export function noteConnectionFailure(alias: string, error: unknown): void {
  if (alias === '') return
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (!isConnectionFailure(message)) return
  const prev = views.get(alias)
  views.set(alias, {
    alias,
    state: 'error',
    error: message,
    errorAt: Date.now(),
    ...(prev?.okAt === undefined ? {} : { okAt: prev.okAt }),
    open: prev?.open ?? false,
    notedAt: Date.now(),
  })
  refreshSnapshot()
}

/** Clear the local overlay once the link is proven back (test/retry). */
export function noteConnectionOk(alias: string): void {
  const prev = views.get(alias)
  views.set(alias, {
    alias,
    state: 'ok',
    okAt: Date.now(),
    open: prev?.open ?? false,
  })
  refreshSnapshot()
}

/** Drop every cached view — tests only (a live page keeps its map). */
export function resetConnectionViews(): void {
  views.clear()
  snapshot = undefined
  activeAlias = ''
}

/** Current view of the active alias (the hook is the UI path; this is for gates). */
export function currentConnection(): ConnectionView | undefined {
  return snapshot
}

/** Subscribe to the active alias's connection view (undefined when none). */
export function useConnectionStatus(): ConnectionView | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => snapshot,
  )
}
