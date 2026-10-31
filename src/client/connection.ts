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

/** Automatic-retry cadence for an errored link (one dial per tick). */
export const AUTO_RETRY_MS = 30_000

/**
 * Automatic attempts allowed per error episode.
 *
 * Not endless on purpose: each attempt is a real SSH dial, and repeated dials
 * against a password-auth host can count towards a lockout. After the budget
 * the chip stays a manual retry control.
 */
export const AUTO_RETRY_MAX_ATTEMPTS = 3

/**
 * Decide one automatic-retry tick.
 *
 * Pure so the budget can be pinned without a browser: ok/idle reset the
 * count, rror consumes one attempt until the budget is spent.
 */
export function consumeAutoRetry(
  state: ConnectionState,
  attempts: number,
): { run: boolean; attempts: number } {
  if (state !== 'error') return { run: false, attempts: 0 }
  if (attempts >= AUTO_RETRY_MAX_ATTEMPTS) return { run: false, attempts }
  return { run: true, attempts: attempts + 1 }
}

/**
 * The i18n key for a state's label.
 *
 * Kept here (not inside the chip) so the gate can assert the MAPPING without a
 * browser: rendering the pool's normal lazy state as "not connected" was a real
 * UX defect — idle means "nothing to report yet / connects on demand", not a
 * broken link.
 */
export function connectionLabelKey(state: ConnectionState): string {
  if (state === 'ok') return 'connection.ok'
  if (state === 'error') return 'connection.error'
  return 'connection.idle'
}

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
const CONNECTION_ERROR_RE = /not connected|no response from server|connection lost|connection refused|socket hang up|channel open fail(?:ed|ure)|connection closed|stalled|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|EPIPE|host .* was disconnected/i

/**
 * Whether `error` (or its message) is a transport-level failure.
 *
 * The flag is honoured first: a repeat failure's message is REWRITTEN to a
 * localized sentence before it is thrown (see `api.call`), and downstream
 * guards (toast quieting, the offline banner) must still see a link error.
 */
export function isConnectionFailure(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && (error as { transport?: unknown }).transport === true) return true
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message !== '' && CONNECTION_ERROR_RE.test(message)
}

let activeAlias = ''
const views = new Map<string, ConnectionView>()
/** Explicit-retry successes (epoch ms): a stale poll error must not undo them. */
const probes = new Map<string, number>()
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
    // A poll response generated BEFORE a successful manual retry can land after
    // it; a failure older than that probe must not repaint the chip red.
    const probedAt = probes.get(item.alias) ?? 0
    if (item.state === 'error' && probedAt > (item.errorAt ?? 0)) continue
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


/** Drop every cached view — tests only (a live page keeps its map). */
export function resetConnectionViews(): void {
  views.clear()
  probes.clear()
  snapshot = undefined
  activeAlias = ''
}

/** Record that an explicit retry just succeeded for `alias`. */
export function markConnectionProbeOk(alias: string): void {
  if (alias === '') return
  probes.set(alias, Date.now())
}

/** Where the last observed state came from (see `isConnectionRecovery`). */
export interface ConnectionTrace {
  alias: string
  state: string | undefined
}

/**
 * Whether this is the LINK recovering, as opposed to a workspace switch.
 *
 * Between two already-errored hosts the alias changes while the state does not;
 * counting that as a recovery would refresh the wrong workspace. The caller
 * keeps a trace keyed by alias, so by the time the new host recovers this sees
 * `(b, error) → (b, ok)`.
 */
export function isConnectionRecovery(
  previous: ConnectionTrace | undefined,
  alias: string,
  state: string | undefined,
): boolean {
  if (previous === undefined || previous.alias !== alias) return false
  return previous.state === 'error' && state === 'ok'
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
