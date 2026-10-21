/**
 * Stage / unstage coordinator: instant local feedback, ONE cheap verification.
 *
 * The reported problem: pressing `+` on a single file in a large repository
 * (AOSP monorepo) fired FOUR repository-wide git commands — the `git add`
 * itself, a full `git status` (through the panel's `refreshAll` →
 * `store.afterWrite()`), and the three extras loaders (stash list, branches,
 * remotes) — so one click cost minutes and locked the panel behind `gitBusy`.
 * Nothing about staging one file needs any of them.
 *
 * What happens instead, per click:
 *  1. the row moves between "changes" and "staged changes" IMMEDIATELY, in the
 *     local status model (`sink.apply`), before anything leaves the browser;
 *  2. the real `git add` / `git restore --staged` goes out, serialized per
 *     repository so two clicks can never reorder each other;
 *  3. clicks landing inside one window (250 ms) coalesce into ONE path-limited
 *     `git status -- …` probe, whose cost tracks the touched paths rather than
 *     the repository;
 *  4. a path the probe contradicts is put back to what the repository actually
 *     says — and the user is told. An optimistic update may be fast; it may
 *     never quietly lie.
 *
 * No React, no fetch: the git verbs and the two local effects are injected, so
 * the whole policy is drivable by `scripts/check-scm-stage.mjs` with a stubbed
 * port and a fake clock.
 */
import { parseStatusDetail } from '../../git-ops.ts'
import { stagedStateOf } from './status-map.ts'

/** The repository a stage/unstage acts on. */
export interface ScmTarget {
  /** Host alias. */
  alias: string
  /** Absolute remote repository root (git runs here). */
  root: string
}

/** The git verbs the coordinator drives. */
export interface StagePort {
  /** `git add -A -- <paths>`. */
  stage: (target: ScmTarget, paths: readonly string[]) => Promise<void>
  /** `git restore --staged -- <paths>`. */
  unstage: (target: ScmTarget, paths: readonly string[]) => Promise<void>
  /** Raw `-z` stdout of the path-limited status (`probeStatusPaths`). */
  probe: (target: ScmTarget, paths: readonly string[]) => Promise<string>
}

/** The two local effects: the status model, and the user. */
export interface StageSink {
  /** Move paths between the index and worktree halves of the local model. */
  apply: (paths: readonly string[], staged: boolean) => void
  /** Tell the user something they must know (rollback, unverifiable). */
  notify: (text: string, isError: boolean) => void
}

/** Timer injection, so a check can drive the debounce deterministically. */
export interface StageClock {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

/** The debounce window: how long clicks keep merging into one probe. */
export const DEFAULT_STAGE_WINDOW_MS = 250

/** One pending click. */
interface Job {
  target: ScmTarget
  paths: readonly string[]
  staged: boolean
  /** The real verb, already in flight (ordered per repository). */
  write: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}

/** Repository identity for grouping (alias + root, one line each). */
function targetKey(target: ScmTarget): string {
  return `${target.alias}\n${target.root}`
}

/** How many paths a message names before it summarises. */
const LISTED_PATHS = 3

/** A short, readable path list for a notification. */
function listPaths(paths: readonly string[]): string {
  if (paths.length <= LISTED_PATHS) return paths.join(', ')
  return `${paths.slice(0, LISTED_PATHS).join(', ')} (+${paths.length - LISTED_PATHS})`
}

/**
 * Coordinates optimistic stage/unstage with a debounced, path-limited check.
 *
 * One instance per client: the panel's clicks, the store's status model and the
 * user notifications all meet here.
 */
export class StageCoordinator {
  private readonly port: StagePort
  private readonly sink: StageSink
  private readonly clock: StageClock
  private readonly windowMs: number
  /** Clicks waiting for the current window to close. */
  private pending: Job[] = []
  private timer: unknown
  /** Per-repository write chain: the second click waits for the first. */
  private readonly chains = new Map<string, Promise<void>>()

  constructor(
    port: StagePort,
    sink: StageSink,
    options: { clock?: StageClock; windowMs?: number } = {},
  ) {
    this.port = port
    this.sink = sink
    this.clock = options.clock ?? {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: handle => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
    }
    this.windowMs = options.windowMs ?? DEFAULT_STAGE_WINDOW_MS
  }

  /**
   * Stage or unstage paths: local first, real verb in flight, verification once
   * the window closes.
   *
   * @param target - repository the paths belong to.
   * @param paths - repo-relative paths (a directory row may keep its `/`).
   * @param staged - true to stage, false to unstage.
   * @returns a promise that settles when this click's verification is in:
   *   rejected when the git verb itself failed (the caller reports it), and
   *   resolved when the verb landed — whether or not the probe agreed (a
   *   disagreement is corrected and notified here, not thrown).
   */
  submit(target: ScmTarget, paths: readonly string[], staged: boolean): Promise<void> {
    if (paths.length === 0) return Promise.resolve()
    const list = [...paths]
    // The write is queued BEFORE the local patch so the two orders cannot
    // invert: the chain's first link runs on a microtask, after this frame.
    const write = this.enqueue(target, () => (staged ? this.port.stage : this.port.unstage)(target, list))
    let resolve: () => void = () => {}
    let reject: (error: unknown) => void = () => {}
    const settled = new Promise<void>((done, fail) => {
      resolve = done
      reject = fail
    })
    this.sink.apply(list, staged)
    this.pending.push({ target, paths: list, staged, write, resolve, reject })
    this.arm()
    return settled
  }

  /**
   * Verify everything submitted so far with ONE path-limited probe per
   * repository. Called by the debounce timer; exposed so a caller (or a check)
   * can force the window closed.
   */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      this.clock.clear(this.timer)
      this.timer = undefined
    }
    const batch = this.pending
    this.pending = []
    if (batch.length === 0) return
    // The probe must never run before the writes it verifies have landed: on a
    // slow repository a `git add` can outlast the debounce window by seconds.
    const outcomes = await Promise.all(batch.map(job => job.write.then(() => undefined, (error: unknown) => error)))
    batch.forEach((job, index) => {
      const error = outcomes[index]
      if (error === undefined) return
      // The verb never landed: put the row back and let the caller report it.
      this.sink.apply(job.paths, !job.staged)
      job.reject(error)
    })
    const landed = batch.filter((_, index) => outcomes[index] === undefined)
    if (landed.length > 0) await this.verify(landed)
    for (const job of landed) job.resolve()
  }

  /** Drop the pending window (page teardown; the writes already went out). */
  dispose(): void {
    if (this.timer !== undefined) {
      this.clock.clear(this.timer)
      this.timer = undefined
    }
  }

  /** Queue one write behind the previous one for the same repository. */
  private enqueue(target: ScmTarget, run: () => Promise<void>): Promise<void> {
    const key = targetKey(target)
    const previous = this.chains.get(key) ?? Promise.resolve()
    // A failed predecessor must not skip this write, hence the same handler on
    // both sides; the stored chain swallows the failure so the next link runs.
    const next = previous.then(run, run)
    this.chains.set(key, next.then(() => undefined, () => undefined))
    return next
  }

  /** (Re)start the debounce window. */
  private arm(): void {
    if (this.timer !== undefined) this.clock.clear(this.timer)
    this.timer = this.clock.set(() => {
      this.timer = undefined
      void this.flush()
    }, this.windowMs)
  }

  /**
   * One probe per repository over every path the window touched, then correct
   * whatever it contradicts.
   */
  private async verify(jobs: readonly Job[]): Promise<void> {
    interface Group {
      target: ScmTarget
      paths: string[]
      /** path → the staged-ness the local model now claims (last click wins). */
      staged: Map<string, boolean>
    }
    const groups = new Map<string, Group>()
    for (const job of jobs) {
      const key = targetKey(job.target)
      const group = groups.get(key) ?? { target: job.target, paths: [], staged: new Map<string, boolean>() }
      for (const path of job.paths) {
        if (!group.paths.includes(path)) group.paths.push(path)
        // Two clicks on one path inside the window keep the LAST intent — that
        // is the state the ordered writes left behind.
        group.staged.set(path, job.staged)
      }
      groups.set(key, group)
    }

    for (const group of groups.values()) {
      let stdout = ''
      try {
        stdout = await this.port.probe(group.target, group.paths)
      } catch {
        // A failed probe is not a failed operation: the writes landed, so the
        // optimistic state stands. Say so rather than silently trusting it.
        this.sink.notify(
          `could not verify ${group.paths.length} staged path(s) in ${group.target.root} — keeping the local state: ${listPaths(group.paths)}`,
          true,
        )
        continue
      }
      const detail = parseStatusDetail(stdout)
      const wrong: string[] = []
      for (const path of group.paths) {
        const expected = group.staged.get(path) === true
        if (stagedStateOf(detail, path) !== expected) wrong.push(path)
      }
      if (wrong.length === 0) continue
      // Staged-ness is binary, so the opposite of the optimistic value IS what
      // the repository reports: apply the observation, not a guess.
      for (const path of wrong) this.sink.apply([path], !(group.staged.get(path) === true))
      this.sink.notify(
        `git did not ${group.staged.get(wrong[0] as string) === true ? 'stage' : 'unstage'} ${listPaths(wrong)} in ${group.target.root} — the panel was put back in sync with the repository`,
        true,
      )
    }
  }
}
