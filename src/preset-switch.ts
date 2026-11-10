/**
 * Auto-switch decision for a new session born in a remote workspace.
 *
 * Why this module is pure
 * -----------------------
 * The 2026-11-10 bug was "sometimes no preset switch about 3 s after creating a
 * session". Two independent causes had to be found by reading the Host:
 *
 * 1. **The switch only listened to `source === 'startup'`.** The Web client does
 *    not always mint a session: `session.create` accepts a named BLANK session
 *    and reuses it (`createInWorkspace` passes the first listed blank id), which
 *    the Host answers through `agents.resume` → `agent/created` with source
 *    `'resume'`. Those sessions never even armed the timer.
 * 2. **A single 2.5 s shot lost every transient state.** At fire time the preset
 *    may not be composed yet, the working directory may be unreadable, or the
 *    workspace binding may not be listed; each guard returned silently, and the
 *    one chance was spent.
 *
 * The fix keeps the "never block session creation" contract and turns the
 * decision into a pure function plus a bounded retry loop, so every branch is
 * covered by a gate instead of being inferred from a silent return.
 *
 * Blankness — no turn started — is the real precondition (`presets.select`
 * enforces exactly that), and it is also what excludes resumed sessions with
 * history. The event source only told us how the session came to be.
 */

/** Preset id this plugin switches remote sessions to (see `cordis.patch.yml`). */
export const REMOTE_PRESET_ID = 'remote'

/** Delay before each attempt, in order. The first attempt keeps the old 2.5 s. */
export const PRESET_SWITCH_DELAYS_MS: readonly number[] = [2500, 1000, 1500, 2000, 3000]

/** Why one attempt ended the way it did (logged, never thrown). */
export type PresetSwitchReason =
  | 'switched'
  | 'already-remote'
  | 'custom-preset'
  | 'routing-off'
  | 'presets-absent'
  | 'services-absent'
  | 'not-blank'
  | 'preset-unbound'
  | 'cwd-unavailable'
  | 'route-unknown'
  | 'tombstoned'
  | 'local-session'
  | 'locked'
  | 'select-failed'

/** One attempt's outcome: switch now, try again later, or stop for good. */
export type PresetSwitchStep =
  | { action: 'switch' }
  | { action: 'retry'; reason: PresetSwitchReason }
  | { action: 'stop'; reason: PresetSwitchReason }

/** A settled attempt (`switch` is reported as `stop/switched`). */
export type PresetSwitchSettled = Exclude<PresetSwitchStep, { action: 'switch' }>

/** Everything the decision reads, resolved by the caller (no services here). */
export interface PresetSwitchFacts {
  /** Routing mode from the plugin config: only `enforce` auto-switches. */
  mode: string
  /** The preset registry service is mounted at all. */
  hasPresets: boolean
  /** No turn has started yet (`turnBoundaryOf`): openTurnStartSeq null, lastTurn 0. */
  blank: boolean
  /** The step also runs for local sessions; the caller decides what to log. */
  cwd: string
  /** `undefined` when the route lookup threw (retried); false means local. */
  remote: boolean | undefined
  /** The directory belongs to a retired binding: dead session, never switch. */
  tombstoned: boolean
  currentPreset: string | undefined
  defaultPreset: string | undefined
}

/**
 * Decide one attempt.
 *
 * Order matters: the terminal reasons come first (config, history, user choice),
 * then the transient ones (composed preset, cwd, route), then the switch.
 */
export function decidePresetSwitch(facts: PresetSwitchFacts): PresetSwitchStep {
  if (facts.mode !== 'enforce') return { action: 'stop', reason: 'routing-off' }
  if (!facts.hasPresets) return { action: 'stop', reason: 'presets-absent' }
  if (!facts.blank) return { action: 'stop', reason: 'not-blank' }
  if (facts.currentPreset === REMOTE_PRESET_ID) return { action: 'stop', reason: 'already-remote' }
  if (facts.currentPreset === undefined) return { action: 'retry', reason: 'preset-unbound' }
  if (facts.currentPreset !== facts.defaultPreset) return { action: 'stop', reason: 'custom-preset' }
  if (facts.cwd.trim() === '') return { action: 'retry', reason: 'cwd-unavailable' }
  if (facts.tombstoned) return { action: 'stop', reason: 'tombstoned' }
  if (facts.remote === undefined) return { action: 'retry', reason: 'route-unknown' }
  if (!facts.remote) return { action: 'stop', reason: 'local-session' }
  return { action: 'switch' }
}

/** One attempt as the caller sees it: the step plus the facts it was made from. */
export interface PresetSwitchAttempt {
  step: PresetSwitchSettled
  facts: PresetSwitchFacts
}

/** Wait for `ms`, unref'd so a pending switch never keeps the Host alive. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Run attempts with the given delays until one stops or switches.
 *
 * A retry is only worth spending for the transient reasons the planner names;
 * the loop itself does not re-classify, so a future terminal reason added to the
 * planner stays terminal automatically.
 *
 * @returns the last attempt and how many attempts were used (1-based).
 */
export async function runPresetSwitchAttempts(
  attempt: () => Promise<PresetSwitchAttempt> | PresetSwitchAttempt,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  delays: readonly number[] = PRESET_SWITCH_DELAYS_MS,
): Promise<{ step: PresetSwitchSettled; facts: PresetSwitchFacts | undefined; attempts: number }> {
  let last: PresetSwitchAttempt | undefined
  let attempts = 0
  for (const delay of delays) {
    attempts += 1
    await sleep(delay)
    last = await attempt()
    if (last.step.action !== 'retry') {
      return { step: last.step, facts: last.facts, attempts }
    }
  }
  return {
    // An exhausted retry keeps `action: 'retry'`: the caller reads that as
    // "gave up after the last attempt" and logs the reason exactly once.
    step: last === undefined ? { action: 'stop', reason: 'services-absent' } : last.step,
    facts: last?.facts,
    attempts,
  }
}
