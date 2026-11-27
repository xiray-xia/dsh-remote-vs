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
import type { EgressInfo, RemoteConnectionStatus } from '../protocol.ts'

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

/**
 * One route, as the localized sentence fragment the chip prints.
 *
 * Pure and exported so the jsdom gate can pin the copy without a browser and the
 * three route kinds cannot drift into three different wordings. The Host sends
 * the hop (`host:port` / the jump alias), never a sentence: the wording is UI
 * copy and has to exist in both languages.
 */
export function describeEgress(egress: EgressInfo, t: (key: string) => string): string {
  if (egress.kind === 'jump') return t('connection.egressJump').replace('{jump}', egress.viaAlias ?? egress.detail)
  if (egress.kind === 'proxy') {
    const template = egress.proxyKind === 'socks5' ? t('connection.egressSocks5') : t('connection.egressHttp')
    return template.replace('{proxy}', egress.detail)
  }
  return t('connection.egressDirect').replace('{target}', egress.detail)
}

/**
 * The tooltip line that answers "did this really go through the jump host?".
 *
 * The ACTUAL egress of the live connection wins. With nothing dialed the
 * CONFIGURED route is shown and LABELLED as such, so a configuration can never
 * be read as evidence about a connection — that distinction is the whole point
 * (a host edited to use a jump host keeps serving on its old direct link until
 * the old connection is dropped). A configured route that cannot be used says
 * why instead of reading healthy.
 */
export function egressTitleLine(
  connection: Pick<ConnectionView, 'egress' | 'configured'>,
  t: (key: string) => string,
): string | undefined {
  if (connection.egress !== undefined) {
    return t('connection.egress').replace('{egress}', describeEgress(connection.egress, t))
  }
  const configured = connection.configured
  if (configured === undefined) return undefined
  const line = t('connection.egressConfigured').replace('{egress}', describeEgress(configured, t))
  return configured.problem === undefined
    ? line
    : // No separator space here: the two copies carry their own (zh uses a
      // full-width bracket, en a leading space), so the punctuation stays right
      // in both languages.
      `${line}${t('connection.egressProblem').replace('{problem}', configured.problem)}`
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
   * The route the LIVE connection was opened through. Evidence, not intention:
   * it is what the Host's pool reports for the connection it is holding.
   */
  egress?: EgressInfo
  /** The route the stored configuration resolves to (no live connection). */
  configured?: EgressInfo
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
 * The flags are honoured first: a repeat failure's message is REWRITTEN to a
 * localized sentence before it is thrown (see `api.call`), and downstream guards
 * (toast quieting, the offline banner) must still see a link error.
 *
 * `deadline` wins over the text: a budget that ran out is an operation result,
 * not a link failure. Its message contains "timed out", so the text rule alone
 * would classify it as transport — and that is exactly what used to turn one
 * slow listing into a red chip and a read-only editor.
 */
export function isConnectionFailure(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    if ((error as { transport?: unknown }).transport === true) return true
    if ((error as { deadline?: unknown }).deadline === true) return false
  }
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
      && next.okAt === snapshot.okAt && next.open === snapshot.open && next.notedAt === snapshot.notedAt
      && sameEgress(next.egress, snapshot.egress) && sameEgress(next.configured, snapshot.configured))
  if (same) return
  snapshot = next
  notify()
}

/**
 * Field-wise equality for one reported route.
 *
 * The Host re-sends the object on every poll and this module rebuilds the view,
 * so identity says nothing: a fresh-but-equal egress must not wake subscribers
 * (that would repaint the whole surface every 5 s), while a real change — the
 * route the connection took — must.
 */
function sameEgress(a: EgressInfo | undefined, b: EgressInfo | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return a.kind === b.kind && a.detail === b.detail && a.viaAlias === b.viaAlias
    && a.source === b.source && a.proxyKind === b.proxyKind && a.problem === b.problem
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
      ...(item.egress === undefined ? {} : { egress: item.egress }),
      ...(item.configured === undefined ? {} : { configured: item.configured }),
    })
  }
  refreshSnapshot()
}

/** Record a transport failure the page just observed on `alias`. */
export function noteConnectionFailure(alias: string, error: unknown): void {
  if (alias === '') return
  // The ERROR, not its message: the `deadline` / `transport` flags live on the
  // object, and a deadline must not paint the alias red.
  if (!isConnectionFailure(error)) return
  const message = error instanceof Error ? error.message : String(error ?? '')
  const prev = views.get(alias)
  views.set(alias, {
    alias,
    state: 'error',
    error: message,
    errorAt: Date.now(),
    ...(prev?.okAt === undefined ? {} : { okAt: prev.okAt }),
    open: prev?.open ?? false,
    // The route the DEAD connection used is not carried over (it is evidence
    // about a link that just failed); the configured route still describes what
    // the next attempt will take, so it stays until the Host answers.
    ...(prev?.configured === undefined ? {} : { configured: prev.configured }),
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

/**
 * Forget the cached record of every alias the hosts table no longer holds.
 *
 * `views`/`probes` are module-level maps keyed by alias and nothing ever removed
 * an entry: deleting or renaming a host in Settings left its view (and its
 * explicit-retry probe) in page memory for the life of the tab. Callers pass the
 * aliases the hosts table currently holds; everything else is stale.
 *
 * Only cache entries are removed — no connection state is transitioned. When the
 * ACTIVE alias is pruned its snapshot becomes `undefined` ("no evidence yet",
 * which every reader already treats as "not proven down") and subscribers are
 * woken. `activeAlias` itself is deliberately KEPT: `setActiveConnectionAlias`
 * early-returns on an unchanged alias, so clearing it here would leave a
 * re-added host's chip blank until the user switched workspaces.
 */
export function pruneConnections(aliases: Iterable<string>): void {
  const keep = new Set(aliases)
  let dropped = false
  for (const alias of [...views.keys()]) {
    if (keep.has(alias)) continue
    views.delete(alias)
    dropped = true
  }
  for (const alias of [...probes.keys()]) {
    if (!keep.has(alias)) probes.delete(alias)
  }
  if (dropped) refreshSnapshot()
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

/**
 * The cached health of ONE alias (`undefined` = never observed).
 *
 * `currentConnection()` answers for the alias the user is LOOKING at; an action
 * that carries its own alias must ask by that alias instead. The undo path is
 * the case in point: its coordinates come from `undoContext()` (the change
 * panel), which can point at a different workspace than the visible one, and
 * reading the visible alias' state there would block (or allow) the wrong host.
 *
 * A cached `error` is exactly what the save path already refuses on
 * (`EditorPane` offline), and an unknown alias means "no evidence" — callers
 * must treat `undefined` as "not proven down", never as healthy.
 */
export function connectionStateOf(alias: string): ConnectionState | undefined {
  if (alias === '') return undefined
  return views.get(alias)?.state
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
