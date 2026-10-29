/**
 * One timeout policy for every remote round trip.
 *
 * Why this module exists
 * ----------------------
 * Large remote repositories made the explorer look broken: `git status` on a
 * cold tree takes minutes, while the client gave up at a fixed 45 s and showed
 * "读取超时（远端无响应）" with git still working. The number therefore has to be
 * (a) bigger by default, (b) the same on both halves, and (c) editable, because
 * how large "large" is differs per host.
 *
 * The Host owns the setting (`gitTimeoutMs` / `readTimeoutMs` in the plugin
 * config, editable in the settings form) and serves the effective pair through
 * `/api/dsh-remote/workspaces`; the client applies it and falls back to these
 * defaults when an older Host answers without them. Nothing here may throw on a
 * malformed value — a bad config must degrade to the default, not break the
 * explorer.
 */
import type { RemoteTimeouts } from './protocol.ts'

/** Smallest accepted timeout: below this, local work would start failing. */
export const MIN_TIMEOUT_MS = 1_000

/**
 * Largest accepted timeout — the exec route clamps to the same ceiling.
 *
 * Raised from 10 to 30 minutes when the SCM push gained a live output panel:
 * a Gerrit push on a large repo waits for server-side hooks and can outlast
 * the old ceiling with nothing wrong on either side.
 */
export const MAX_TIMEOUT_MS = 1_800_000

/**
 * Default for one git command (status/log/branches/diff over exec).
 *
 * 120 s was the old internal value and 45 s the old client deadline; both were
 * routinely exceeded by a cold `git status` on a large monorepo. Five minutes
 * still fails eventually (a wedged host must not spin forever) but outlasts any
 * plausible cold index walk.
 */
export const DEFAULT_GIT_TIMEOUT_MS = 300_000

/**
 * Floor for the NETWORK verbs (fetch / pull / push / sync).
 *
 * These wait on the far end's hooks and pack transfer, not on this machine, so
 * their budget starts at 20 minutes and grows with `gitTimeoutMs × 2` up to
 * `MAX_TIMEOUT_MS`. The old formula started at 5 minutes and capped at 10, which
 * killed healthy Gerrit pushes.
 */
export const DEFAULT_NETWORK_TIMEOUT_MS = 1_200_000

/** Default for one SFTP file read (editor, diff sides, document preview). */
export const DEFAULT_READ_TIMEOUT_MS = 120_000

/** The pair every half starts from before any Host answer arrives. */
export const DEFAULT_TIMEOUTS: RemoteTimeouts = {
  gitMs: DEFAULT_GIT_TIMEOUT_MS,
  readMs: DEFAULT_READ_TIMEOUT_MS,
}

/**
 * Clamp one untrusted timeout into the accepted range.
 *
 * @param value - raw value (plugin config, JSON body, anything).
 * @param fallback - used when the value is not a usable number.
 * @returns a whole number of milliseconds within [MIN, MAX].
 */
export function clampTimeout(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const whole = Math.floor(value)
  if (whole < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS
  if (whole > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS
  return whole
}

/**
 * Clamp an optional request timeout: absent/invalid stays absent, which is what
 * the exec route forwards as "use the pool default".
 *
 * @param value - raw `timeoutMs` from a request body.
 * @returns the clamped timeout, or undefined when the caller named none.
 */
export function clampExecTimeout(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return clampTimeout(value, DEFAULT_GIT_TIMEOUT_MS)
}

/** Resolve the effective pair from raw config values. */
export function resolveTimeouts(config: {
  gitTimeoutMs?: unknown
  readTimeoutMs?: unknown
} | undefined): RemoteTimeouts {
  return {
    gitMs: clampTimeout(config?.gitTimeoutMs, DEFAULT_GIT_TIMEOUT_MS),
    readMs: clampTimeout(config?.readTimeoutMs, DEFAULT_READ_TIMEOUT_MS),
  }
}

/**
 * Normalize a pair that arrived over the wire (an older Host sends nothing).
 *
 * @param value - the `timeouts` field of a workspaces answer.
 * @returns the pair to use, always complete and clamped.
 */
export function normalizeTimeouts(value: unknown): RemoteTimeouts {
  const record = (typeof value === 'object' && value !== null ? value : {}) as {
    gitMs?: unknown
    readMs?: unknown
  }
  return resolveTimeouts({ gitTimeoutMs: record.gitMs, readTimeoutMs: record.readMs })
}

/** Human-facing seconds for one timeout ("300s"), used in status and errors. */
export function timeoutSeconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`
}

/**
 * Extra wait the CLIENT allows beyond the server-side budget.
 *
 * Both halves enforce a limit, so without a margin they race and the loser is
 * effectively random — and the loser's message is much worse: the generic
 * client deadline ("读取超时（远端无响应）") instead of git's own "timed out after
 * Ns" plus the hint to raise the setting. The client therefore always waits a
 * little longer than the command it is watching.
 */
export const CLIENT_DEADLINE_MARGIN_MS = 15_000

/**
 * The client's watchdog for one operation whose server-side budget is `ms`.
 *
 * @param ms - the command's own budget (git or SFTP).
 * @returns a deadline strictly greater than `ms`, so the server-side error wins.
 */
export function clientDeadlineFor(ms: number): number {
  return ms + CLIENT_DEADLINE_MARGIN_MS
}
