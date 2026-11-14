/**
 * Per-session change ledger for remote workspaces.
 *
 * DSH already records "what did this turn change" — but only for local
 * sessions: `@deepseek-ai/dsh-workspace-changes` parses git's POSIX output with
 * host path semantics and stages its scratch index through `node:fs`, so on a
 * routed session the first baseline snapshot fails and the recorder returns
 * before appending anything (measured: 58 remote-bound sessions, 390 fs
 * writes, zero `workspace/changes` events).
 *
 * This ledger re-expresses the idea for a remote host, and one measurement
 * decided its shape. A first version snapshotted the worktree with `git add
 * --all` into a private index; on a monorepo (AOSP, ~1M files) that never
 * finished — it was still hashing two minutes in, and the panel sat at
 * "computing…" forever. Everything here is therefore **read-only and
 * proportional to the files that changed**, never to the size of the
 * repository:
 *
 * 1. `git status --porcelain -uno` names the tracked files that differ (1.7s
 *    measured), `git ls-files --others` names the new ones (11.3s measured,
 *    run as its own best-effort exec).
 * 2. Only those paths are read (their current text, and `HEAD:<path>` for the
 *    ones the session started clean).
 * 3. The diff itself is computed here, line by line, with no git call at all.
 *
 * Nothing in this file writes to the repository: no `git add`, no index, no
 * object store, no temp files under the repo. "What changed" is answered by
 * git's own stat cache; "what changed *since the session started*" is answered
 * by keeping the pre-existing dirty files' contents at session start and
 * treating an unchanged one as untouched.
 */

import type {
  RemoteChangesDiff,
  RemoteChangedFile,
  RemoteChangesSummary,
  RemoteTimeouts,
  UnifiedHunk,
} from '../protocol.ts'
import type { RemotePool } from '../pool.ts'
import type { RemoteWorlds, WorldRoute } from '../p2/worlds.ts'
import {
  excludeDirNames,
  parseReads,
  parseStatusZ,
  parseUntrackedZ,
  readHeadCommand,
  readWorktreeCommand,
  reposBelowCommand,
  trackedStatusCommand,
  UNTRACKED_EXCLUDED_DIRECTORIES,
  untrackedCommand,
  type ChangeStatus,
  type ReadResult,
  type StatusEntry,
} from './status.ts'
import { diffText, filePatch, hunkPatch } from './text-diff.ts'

/** The two facts a turn boundary needs from a Session, kept cordis-free. */
export interface LedgerTarget {
  sessionId: string
  /** Session working directory as the host sees it (an alias path for remote sessions). */
  cwd: string
}

/** Collaborators the ledger needs; all injectable so it can be unit-tested. */
export interface SessionChangesDeps {
  pool: RemotePool
  worlds: RemoteWorlds
  /** Effective git budget, read per call (a `volatile()` edit applies live). */
  timeouts: () => RemoteTimeouts
  log?: (level: 'info' | 'warn', message: string) => void
  /** Cap on listed files; the header totals stay whole. */
  maxFiles?: number
  /** Cap on one file's text, in bytes. */
  maxFileBytes?: number
  /** Cap on one refresh's total text, in bytes. */
  maxTotalBytes?: number
  /** Budget for the untracked scan, which is an order of magnitude slower. */
  untrackedBudgetMs?: number
  /** How often the untracked scan may run again (default five seconds). */
  untrackedRefreshMs?: number
  /**
   * Directory names the untracked scan leaves out (build output, dependency
   * caches). Defaults to {@link UNTRACKED_EXCLUDED_DIRECTORIES}; an explicit
   * empty array turns the exclusion off.
   */
  excludeDirs?: readonly string[]
  /**
   * Override the per-exec budget outright.
   *
   * The timeouts setting is clamped to a sane range, which is right for a Host
   * but useless for a check that must not wait five seconds to see a watchdog
   * fire.
   */
  execBudgetMs?: number
}

/** A status letter the panel can paint (untracked has no git letter of its own). */
type PanelStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U'

/**
 * Map a scan entry onto the panel's vocabulary.
 *
 * `?` means "git does not track this path yet", which for a review panel is
 * exactly a new file — the same thing `A` says for a staged addition.
 */
function panelStatus(status: ChangeStatus): PanelStatus | undefined {
  return status === '?' ? 'A' : status
}

/** One file as the panel and the editor need it, with both sides kept for hunks. */
interface FileRecord {
  display: string
  path: string
  status: PanelStatus | undefined
  before: string | null
  after: string | null
  binary: boolean
  truncated: boolean
  /**
   * Which side the `before` bytes came from.
   *
   * `baseline` is the content a file already carried when the session started
   * (pre-existing dirt), `head` is git's committed blob. The distinction is
   * load-bearing for big files: a HEAD read can be taken again at a larger cap
   * when the user asks for one file, while the baseline snapshot cannot be
   * retaken — it described the worktree at session start, which has moved on.
   * Re-reading `HEAD` for a baseline-backed record would silently build a
   * revert that discards the user's own pre-session edits.
   */
  beforeFrom: 'baseline' | 'head' | 'none'
}

/** Grace added to an exec budget before the watchdog gives up on it. */
const WATCHDOG_GRACE_MS = 5_000
/** Sentinel for "the host call never came back". */
const WATCHDOG_FIRED = 'watchdog-fired' as const

/**
 * Per-file budget for the ONE read a click asks for (`diff`).
 *
 * A scan compares hundreds of paths and stays at 256 KiB; a single file the user
 * asked to review is a different trade — 2 MiB is enough for the large sources
 * a monorepo carries while keeping the base64 reply (≈2.7 MB) inside what one
 * exec comfortably returns.
 */
const DIFF_MAX_FILE_BYTES = 2 * 1024 * 1024

/** The single-file read budget, as `readPaths` wants it. */
const DIFF_LIMITS = { perFile: DIFF_MAX_FILE_BYTES, total: DIFF_MAX_FILE_BYTES } as const

/** One session's bookkeeping. */
interface Ledger {
  sessionId: string
  /** Session working directory this ledger is CURRENTLY bound to (see `ensure`). */
  cwd: string
  /** Remote route (binding) id the ledger is bound to; a different one = rebind. */
  routeId: string
  alias: string
  root: string
  /** Content of every path that was ALREADY dirty when the session began. */
  baseline: Map<string, ReadResult> | undefined
  baselineTaken: boolean
  /** Set once the untracked scan proves unusable for THIS root; stops retrying it. */
  untrackedGivenUp: boolean
  /**
   * Why the untracked scan was written off, kept so the panel can SAY so.
   *
   * Capability loss without a reason reads as "this session changed nothing new",
   * which is the opposite of the truth: the walk that finds new files is off. This
   * is sticky (a later successful tracked scan must not hide it) and only cleared
   * by a successful walk or by moving the root (`resetObservation`).
   */
  untrackedFailure: string | undefined
  /**
   * Wall-clock ms when observation of the CURRENT root started.
   *
   * The baseline's "was this file here before?" test compares file mtimes against
   * it, so it must move with the root (`resetObservation`) — a file that appeared
   * before we started looking at this tree is pre-existing by definition.
   */
  startedAt: number
  /** True once the first untracked result has been folded into the baseline. */
  absorbed: boolean
  /** True once a repository below the session root has been looked for. */
  adoptedSubdir: boolean
  /** The session root as first resolved; root may be this plus subdir. */
  baseRoot: string
  /** Explicit repository directory inside the root ('' = the root itself). */
  subdir: string
  /** Latest tracked scan (cheap, refreshed every turn). */
  tracked: StatusEntry[]
  /** Latest untracked scan; undefined until the first one lands. */
  untracked: StatusEntry[] | undefined
  /** When the last untracked scan STARTED, for the cadence. */
  untrackedAt: number
  /** How long the last completed untracked scan took, for the cadence. */
  untrackedMs: number | undefined
  /** In-flight untracked scan, so a turn boundary cannot start a second one. */
  untrackedJob: Promise<void> | undefined
  turn: number
  files: RemoteChangedFile[]
  records: Map<string, FileRecord>
  added: number
  deleted: number
  truncated: true | undefined
  at: number
  unavailable: string | undefined
  /** A scan is running right now; the list will refresh. */
  pending: boolean
  /** Serialized background work; a second schedule coalesces into one run. */
  queue: Promise<void>
  dirty: boolean
  /**
   * Monotonic publish ledger: only the LATEST started publish may write.
   *
   * Two publishes can be in flight at once by design (the queued `refresh` and the
   * background untracked job, which runs outside the queue), each holding a
   * snapshot taken before its own awaits. Without this, the one that finishes last
   * wins with the OLDER data — rows vanish/reappear and counts flop for a scan.
   * Deliberately NOT reset by `resetObservation`: it orders writes, it is not an
   * observation of a root (the root guard already covers identity).
   */
  publishSeq: number
  disposed: boolean
}

/** POSIX join — `node:path` would apply Windows semantics on the host. */
function posixJoin(base: string, rel: string): string {
  if (rel.startsWith('/')) return rel
  const left = base.endsWith('/') ? base.slice(0, -1) : base
  const right = rel.startsWith('./') ? rel.slice(2) : rel
  return right === '' ? left : `${left}/${right}`
}

/**
 * Whether two reads prove the file did not move between them.
 *
 * The last resort for a path whose bytes never crossed the wire (over the size
 * cap, or binary): mtime and size are all that is left, and requiring BOTH keeps
 * the claim honest. mtime has one-second resolution, so an edit inside the same
 * second as the read is invisible here — which is why this is only ever used
 * where a content comparison is impossible.
 */
function sameStat(before: ReadResult | undefined, after: ReadResult | undefined): boolean {
  if (before === undefined || after === undefined) return false
  if (before.mtime === undefined || after.mtime === undefined) return false
  if (before.size === undefined || after.size === undefined) return false
  return before.mtime === after.mtime && before.size === after.size
}

export class SessionChanges {
  private readonly ledgers = new Map<string, Ledger>()
  private readonly deps: SessionChangesDeps
  private disposed = false

  constructor(deps: SessionChangesDeps) {
    this.deps = deps
  }

  /** Open (or reuse) the ledger for one session at the start of a turn. */
  beginTurn(target: LedgerTarget): void {
    if (this.disposed) return
    const ledger = this.ensure(target)
    if (ledger === undefined) return
    // The baseline is only meaningful once per session. A failed attempt leaves
    // it unset and the next turn retries (a host may be briefly down).
    if (!ledger.baselineTaken) this.schedule(ledger)
  }

  /** Refresh the ledger at the end of a turn. */
  endTurn(target: LedgerTarget, turn: number): void {
    if (this.disposed) return
    const ledger = this.ensure(target)
    if (ledger === undefined) return
    ledger.turn = Math.max(ledger.turn, turn)
    this.schedule(ledger)
  }

  /** The current summary for one session, or null when it has no ledger. */
  summary(sessionId: string): RemoteChangesSummary | null {
    const ledger = this.ledgers.get(sessionId)
    if (ledger === undefined) return null
    /*
     * Why "unavailable" has two sources.
     *
     * The tracked scan explains itself through `ledger.unavailable`. A written-off
     * untracked walk has no such channel — it permanently removes the "new files"
     * column, and silence there reads as "this session changed nothing new". So the
     * sticky `untrackedFailure` is folded in here, with the one action that can
     * recover it. The explicit reason wins: a successful tracked scan clears
     * `ledger.unavailable` every turn, while `untrackedFailure` survives until a
     * walk succeeds or the root moves.
     */
    const unavailable = ledger.unavailable
      ?? (ledger.untrackedFailure === undefined
        ? undefined
        : `new-file scan unavailable: ${ledger.untrackedFailure} (use the refresh button to retry)`)
    // Which paths the scan was told to skip. Said out loud (not silently
    // filtered) so a file the user expected to see is never "missing" for an
    // unknown reason; the SCM panel is the surface that shows everything.
    const excludedDirs = this.excludedDirs()
    return {
      alias: ledger.alias,
      root: ledger.root,
      turn: ledger.turn,
      files: ledger.files,
      added: ledger.added,
      deleted: ledger.deleted,
      at: ledger.at,
      ...(excludedDirs.length === 0 ? {} : { excludedDirs }),
      /*
       * What "pending" is allowed to mean to the panel.
       *
       * The slow scan counts even with an empty list: without it, a turn whose
       * only product is a NEW file would look like "nothing changed" for the
       * minutes the untracked walk needs, and the user would conclude the
       * feature is broken right up to the moment the row appears.
       *
       * A quick scan does NOT count while there is nothing to show. The panel
       * polls every few seconds and self-heals stale data, so counting it made
       * the header flash "computing…" for two seconds every half minute in a
       * session that had not touched a file yet, then vanish — a glitch with no
       * information in it.
       */
      pending: ledger.untrackedJob !== undefined || (ledger.pending && ledger.files.length > 0),
      ...(ledger.truncated === true ? { truncated: true as const } : {}),
      ...(unavailable === undefined ? {} : { unavailable }),
    }
  }

  /**
   * Compare one listed file across the whole session.
   *
   * The `before` side comes from the session baseline, which never moves. The
   * `after` side is read from the host on every call rather than replayed from
   * the last scan: a revert, a save from the editor or a shell command all
   * change the file between scans, and replaying a cached copy against a fresh
   * buffer is exactly how the painted lines end up at the wrong places.
   *
   * This is the ONE read a user asks for by clicking a row, so it is allowed a
   * larger per-file budget than a scan (`DIFF_MAX_FILE_BYTES`): a file the list
   * had to withhold as "too large" can still be reviewed and reverted here,
   * while a scan stays cheap. A withheld HEAD side is retaken at that budget
   * (git has the bytes); a withheld BASELINE side is not — that snapshot
   * described the session's own starting point and cannot be reconstructed, so
   * the file stays display-only rather than guessing a wrong reverse.
   *
   * @param sessionId - live session owning the ledger.
   * @param path - the file's remote absolute path (as listed in the summary).
   * @returns hunks for decorations, or null when the session/file is unknown.
   */
  async diff(sessionId: string, path: string): Promise<RemoteChangesDiff | null> {
    const ledger = this.ledgers.get(sessionId)
    if (ledger === undefined) return null
    const record = ledger.records.get(path)
    if (record === undefined) return null
    const status = record.status

    // Fresh "after" side; the cached one only covers a failed read.
    let afterText = record.after
    let binary = record.binary
    let truncated = record.truncated
    const fresh = await this.readPaths(ledger, [record.display], 'worktree', DIFF_LIMITS)
    if (ledger.disposed) return null
    const side = fresh.get(record.display)
    if (side !== undefined) {
      binary = side.binary
      truncated = side.truncated
      afterText = side.absent ? null : side.text
      if (afterText === null && !side.absent && !side.binary) afterText = record.after
    }
    if (binary) {
      return { kind: 'binary', path, display: record.display, hunks: [], ...(status === undefined ? {} : { status }) }
    }
    // A HEAD side the scan had to withhold is worth one more read at the larger
    // budget; the baseline side is not (see the note above).
    let beforeText = record.before
    if (beforeText === null && record.beforeFrom === 'head') {
      const head = await this.readPaths(ledger, [record.display], 'head', DIFF_LIMITS)
      if (ledger.disposed) return null
      beforeText = head.get(record.display)?.text ?? null
    }
    const result = diffText(beforeText ?? '', afterText ?? '')
    /**
     * The reverse patch exists only when the comparison is complete and has an
     * old side. A whole-file creation has no old side: its reverse is "delete the
     * file", which a patch cannot express (the client uses
     * `RemoteChangedFile.revert` for that case instead). Withheld bytes are not
     * evidence either, so a truncated after side gets no patch — the client's
     * undo path then refuses (`changes.undoMissing`) instead of guessing.
     */
    const reverse = beforeText !== null && !truncated ? filePatch(record.display, result.hunks) : ''
    const hunks: UnifiedHunk[] = result.hunks.map(hunk => ({
      oldStart: hunk.oldStart,
      oldCount: hunk.oldLines,
      newStart: hunk.newStart,
      newCount: hunk.newLines,
      heading: '',
      lines: hunk.lines,
      // The client hands this straight to `git apply -R` for "revert this
      // change", so it must be a real patch, not a display artifact. Empty
      // means "display only": the client's undo path refuses an empty patch
      // (`changes.undoMissing`), which is the fail-closed answer for a record
      // whose reverse would delete a file git has no copy of.
      patch: reverse === '' ? '' : hunkPatch(record.display, hunk),
    }))
    if (hunks.length === 0) {
      return { kind: 'missing', path, display: record.display, hunks: [], ...(status === undefined ? {} : { status }) }
    }
    return {
      kind: 'text',
      path,
      display: record.display,
      hunks,
      ...(reverse === '' ? {} : { patch: reverse }),
      ...(status === undefined ? {} : { status }),
      ...(truncated ? { truncated: true as const } : {}),
    }
  }

  /** Resolve once every queued refresh has settled, including coalesced work. */
  async settled(): Promise<void> {
    for (let guard = 0; guard < 100; guard += 1) {
      await Promise.all([...this.ledgers.values()].map(ledger => ledger.queue))
      // The untracked scan deliberately runs outside the queue (it can take a
      // minute); "settled" has to include it or a caller would read a list that
      // is about to change.
      const jobs = [...this.ledgers.values()]
        .map(ledger => ledger.untrackedJob)
        .filter((job): job is Promise<void> => job !== undefined)
      if (jobs.length > 0) await Promise.all(jobs)
      const busy = [...this.ledgers.values()].some(ledger => ledger.pending || ledger.untrackedJob !== undefined)
      if (!busy) return
    }
  }

  /** Drop one session's ledger. */
  forget(sessionId: string): void {
    const ledger = this.ledgers.get(sessionId)
    if (ledger === undefined) return
    this.ledgers.delete(sessionId)
    ledger.disposed = true
  }

  /** Release every ledger (plugin unmount). */
  dispose(): void {
    this.disposed = true
    for (const sessionId of [...this.ledgers.keys()]) this.forget(sessionId)
  }

  /**
   * Force a fresh pass, ignoring the untracked cadence.
   *
   * The panel's refresh button calls this: the cadence exists so a slow scan
   * does not run on every turn, but "I clicked refresh" means the user wants
   * the truth now — including files that appeared seconds ago.
   */
  rescan(sessionId: string): void {
    const ledger = this.ledgers.get(sessionId)
    if (ledger === undefined || ledger.disposed) return
    // An explicit refresh means "try again": the write-off verdict describes the
    // previous attempt, not the session, so the button must be able to clear it.
    // Automatic polls (`touch`) deliberately keep it — retrying a minute-long
    // walk on every 30s self-heal is exactly what the write-off prevents.
    if (ledger.untrackedGivenUp) {
      ledger.untrackedGivenUp = false
      this.warn('manual refresh re-arms the untracked scan for this session')
    }
    ledger.untrackedAt = 0
    ledger.untrackedMs = undefined
    this.schedule(ledger)
  }

  /**
   * Self-heal a ledger whose data has gone stale.
   *
   * The panel polls `list`, and a poll is the one moment we know a human is
   * looking at the answer. If the data is older than `maxAgeMs`, re-scan — so a
   * turn boundary this Host never delivered costs a few seconds of staleness
   * instead of a manual refresh.
   *
   * @returns whether a refresh was queued.
   */
  touch(sessionId: string, maxAgeMs = 30_000): boolean {
    const ledger = this.ledgers.get(sessionId)
    if (ledger === undefined || ledger.disposed || ledger.pending) return false
    if (ledger.at > 0 && Date.now() - ledger.at < maxAgeMs) return false
    this.schedule(ledger)
    return true
  }

  /**
   * Point one ledger at a subdirectory of the session root.
   *
   * This is the Source Control panel's "repository directory": an explicit
   * choice by the user, and therefore the authority whenever it is set. The
   * automatic one-level probe is only a fallback for a container workspace that
   * holds exactly one repository.
   *
   * @param subdir - workspace-relative directory, or undefined for the session
   *   root itself. Absolute paths and `..` are refused: they would move the
   *   ledger outside the workspace it was created for.
   */
  useRepoSubdir(sessionId: string, subdir: string | undefined): void {
    const ledger = this.ledgers.get(sessionId)
    if (ledger === undefined || ledger.disposed) return
    const clean = normalizeRepoSubdir(subdir)
    if (clean === ledger.subdir) return
    ledger.subdir = clean
    ledger.root = clean === '' ? ledger.baseRoot : `${ledger.baseRoot}/${clean}`
    this.resetObservation(ledger)
    this.schedule(ledger)
  }

  /**
   * Forget everything observed against the ledger's previous root.
   *
   * The root is the subject of every fact this ledger holds: the baseline
   * describes that tree, both scans name paths relative to it, and the flags
   * that gate them (`absorbed`, `untrackedGivenUp`) are verdicts about that
   * repository. Moving the root therefore makes the whole observation set
   * meaningless at once — resetting only the ones a caller happened to remember
   * is how the first cut of `useRepoSubdir` forgot `untracked` and `absorbed`,
   * which announced the newly selected repository's PRE-EXISTING untracked
   * files as this session's work (full-file additions, revertible — and a
   * revert of an untracked file destroys a copy git never had).
   *
   * One entry point on purpose: a field added later belongs here by default,
   * instead of needing every root-move path to be found again.
   */
  private resetObservation(ledger: Ledger): void {
    ledger.baseline = undefined
    ledger.baselineTaken = false
    ledger.absorbed = false
    ledger.adoptedSubdir = false
    ledger.tracked = []
    ledger.untracked = undefined
    ledger.untrackedAt = 0
    ledger.untrackedMs = undefined
    ledger.untrackedGivenUp = false
    ledger.untrackedFailure = undefined
    ledger.files = []
    ledger.records = new Map()
    ledger.added = 0
    ledger.deleted = 0
    ledger.truncated = undefined
    ledger.at = 0
    ledger.unavailable = undefined
    // The mtime test in `absorbPreExisting` asks "did this file predate the
    // observation of THIS tree?"; the previous root's clock would call files that
    // appeared in the new one before the move "session work" (and list them with
    // whole-file counts). Restart it with the rest of the observation.
    ledger.startedAt = Date.now()
  }

  // ------------------------------------------------------------- internals

  /**
   * Resolve (or rebind) the ledger for one session from its CURRENT cwd.
   *
   * The cwd is re-resolved on every turn boundary instead of once per session: a
   * session can change its working directory mid-conversation (a workspace
   * switch, `working-directory.set`), and a ledger pinned to the first binding
   * then keeps answering "what did this session change" about a tree the session
   * is no longer working in — and points file-open and undo at it.
   *
   * Rebinding happens IN PLACE rather than forget+create: the panel keeps its
   * identity and `turn` counter (no null-summary flicker) and one
   * `resetObservation()` drops every fact that belonged to the previous root, so
   * the field list stays in that one method. C1's root-snapshot guards in
   * `refresh`/`publish`/`kickUntracked`/`absorbPreExisting` are exactly what makes
   * this safe while a scan of the old root is still in flight.
   */
  private ensure(target: LedgerTarget): Ledger | undefined {
    if (target.cwd.trim() === '') return undefined
    let route: WorldRoute
    try {
      route = this.deps.worlds.routeDir(target.cwd)
    } catch {
      // Tombstoned spelling (a removed mapping): fail closed AND stop serving a
      // list for a workspace that no longer exists. Keeping the old ledger was
      // the old behaviour and it kept a dead session looking alive.
      this.forget(target.sessionId)
      return undefined
    }
    if (route.kind !== 'remote') {
      // Local sessions are already covered by DSH's own recorder, and this
      // panel is a remote-workspace feature: keeping no ledger is what makes it
      // stay hidden there instead of showing a permanently empty box.
      this.forget(target.sessionId)
      return undefined
    }
    const root = route.remotePath.length > 1 && route.remotePath.endsWith('/')
      ? route.remotePath.replace(/\/+$/, '')
      : route.remotePath
    const existing = this.ledgers.get(target.sessionId)
    if (existing !== undefined && !existing.disposed && existing.root !== '') {
      existing.cwd = target.cwd
      if (existing.routeId === route.id) return existing
      // Same session, different binding: rebind in place.
      this.warn(`session working directory moved to ${route.alias}:${root}; re-observing the new binding`)
      existing.routeId = route.id
      existing.alias = route.alias
      existing.baseRoot = root
      existing.subdir = ''
      existing.root = root
      this.resetObservation(existing)
      return existing
    }
    const ledger: Ledger = {
      sessionId: target.sessionId,
      cwd: target.cwd,
      routeId: route.id,
      alias: route.alias,
      root,
      baseline: undefined,
      baselineTaken: false,
      untrackedGivenUp: false,
      untrackedFailure: undefined,
      startedAt: Date.now(),
      absorbed: false,
      adoptedSubdir: false,
      baseRoot: root,
      subdir: '',
      tracked: [],
      untracked: undefined,
      untrackedAt: 0,
      untrackedMs: undefined,
      untrackedJob: undefined,
      turn: 0,
      files: [],
      records: new Map(),
      added: 0,
      deleted: 0,
      truncated: undefined,
      at: 0,
      unavailable: undefined,
      pending: false,
      queue: Promise.resolve(),
      dirty: false,
      publishSeq: 0,
      disposed: false,
    }
    this.ledgers.set(target.sessionId, ledger)
    return ledger
  }

  /** Queue a refresh, coalescing bursts (a turn can end while one is running). */
  private schedule(ledger: Ledger): void {
    if (ledger.disposed) return
    if (ledger.pending) {
      ledger.dirty = true
      return
    }
    ledger.pending = true
    ledger.queue = ledger.queue
      .then(() => this.refresh(ledger))
      .catch(error => this.warn(`refresh failed: ${messageOf(error)}`))
      .finally(() => {
        ledger.pending = false
        if (ledger.dirty && !ledger.disposed) {
          ledger.dirty = false
          this.schedule(ledger)
        }
      })
  }

  /**
   * One refresh: the cheap scan first, then the slow one in the background.
   *
   * The split is not cosmetic. On the reference monorepo `git status -uno`
   * answers in ~3s while `git ls-files --others` needs over a minute, so a
   * single sequential refresh would leave the panel empty for that whole
   * minute even though the tracked changes were known after three seconds.
   * Phase one publishes, phase two adds the new files when (and if) it lands.
   */
  private async refresh(ledger: Ledger): Promise<void> {
    if (ledger.disposed || ledger.root === '') return
    const scanned = await this.scanTracked(ledger)
    if (ledger.disposed || scanned === undefined) return
    // The root may have moved while the scan was in flight (the user picked
    // another repository directory). `scanTracked` reports the root its entries
    // belong to, so a mismatch means someone else owns the observation now —
    // publish nothing and let that caller's own refresh land.
    if (ledger.root !== scanned.root) return
    ledger.tracked = scanned.entries
    await this.publish(ledger)
    void this.kickUntracked(ledger)
  }

  /** Recompute the panel's list from the scans currently known. */
  private async publish(ledger: Ledger): Promise<void> {
    if (ledger.disposed) return
    // Ordering ticket: see Ledger.publishSeq. Taken before the first await.
    const seq = ++ledger.publishSeq
    // The reads below are relative to the root at THIS moment. A root move while
    // they are in flight (the user picked another repository directory) makes
    // the answer mixed-root, so it must not reach the panel; the caller that
    // moved the root has already queued its own refresh.
    const root = ledger.root
    const merged = new Map<string, StatusEntry>()
    for (const entry of ledger.tracked) merged.set(entry.path, entry)
    for (const entry of ledger.untracked ?? []) {
      if (!merged.has(entry.path)) merged.set(entry.path, entry)
    }
    const entries = [...merged.values()].sort((left, right) => left.path.localeCompare(right.path))
    const cap = this.deps.maxFiles ?? 500
    const listed = entries.slice(0, cap)
    const truncated = entries.length > cap

    if (!ledger.baselineTaken) {
      // First observation: everything dirty RIGHT NOW predates this ledger, so
      // it becomes the baseline rather than a change to report.
      const first = await this.readPaths(ledger, listed.map(entry => entry.path), 'worktree')
      if (ledger.disposed || ledger.root !== root) return
      // A newer publish already started: it owns the baseline now.
      if (ledger.publishSeq !== seq) return
      ledger.baseline = first
      ledger.baselineTaken = true
      ledger.files = []
      ledger.records = new Map()
      ledger.added = 0
      ledger.deleted = 0
      ledger.truncated = truncated ? true : undefined
      ledger.at = Date.now()
      return
    }

    const baseline = ledger.baseline ?? new Map<string, ReadResult>()
    // `before` comes from the session baseline when the file was already dirty,
    // and from HEAD when the session started with it clean; `after` is always
    // the worktree as it is now.
    const fromHead = listed.filter(entry => !baseline.has(entry.path)).map(entry => entry.path)
    const head = fromHead.length === 0 ? new Map<string, ReadResult>() : await this.readPaths(ledger, fromHead, 'head')
    const after = await this.readPaths(ledger, listed.map(entry => entry.path), 'worktree')
    if (ledger.disposed || ledger.root !== root) return

    const records = new Map<string, FileRecord>()
    const files: RemoteChangedFile[] = []
    let added = 0
    let deleted = 0
    for (const entry of listed) {
      const fromBaseline = baseline.get(entry.path)
      const fromHead = head.get(entry.path)
      const beforeSide = fromBaseline ?? fromHead
      const afterSide = after.get(entry.path)
      const before = beforeSide?.text ?? null
      const afterText = afterSide?.text ?? null
      const binary = beforeSide?.binary === true || afterSide?.binary === true
      const fileTruncated = beforeSide?.truncated === true || afterSide?.truncated === true
      const gone = beforeSide?.absent === true && afterSide?.absent === true
      if (gone) continue
      // A path git still reports but that is byte-identical to the session
      // baseline is pre-existing dirt, not this session's work.
      if (!binary && !fileTruncated && before === afterText) continue
      // For a file whose bytes were withheld (over the size cap, or binary) the
      // content test above cannot run, and listing it on git's word alone is how
      // the panel filled up with every big file the checkout already carried.
      // Time and size are the evidence that survives the cap: identical on both
      // sides means the session never wrote to it.
      if ((binary || fileTruncated) && sameStat(beforeSide, afterSide)) continue
      const oversized = fileTruncated && !binary
      // No old side = whole-file creation, and the only reverse of its patch is
      // deleting the file. That is recoverable when git holds the content — a
      // tracked addition, where the index still has the bytes — and not when it
      // does not: an untracked file exists only in the worktree, so "undo" would
      // destroy its single copy. The summary therefore tells the client which
      // action (if any) it may offer, instead of letting the browser guess.
      const creation = before === null
      const revert: 'patch' | 'delete' | undefined = !binary && !oversized && beforeSide !== undefined && !creation
        ? 'patch'
        : (entry.status === 'A' ? 'delete' : undefined)
      const diff = binary || oversized ? { added: 0, deleted: 0 } : diffText(before ?? '', afterText ?? '')
      const status = panelStatus(entry.status)
      const absolute = posixJoin(ledger.root, entry.path)
      records.set(absolute, {
        display: entry.path,
        path: absolute,
        status,
        before,
        after: afterText,
        binary,
        truncated: fileTruncated,
        beforeFrom: fromBaseline !== undefined ? 'baseline' : fromHead !== undefined ? 'head' : 'none',
      })
      added += diff.added
      deleted += diff.deleted
      files.push({
        path: absolute,
        display: entry.path,
        added: diff.added,
        deleted: diff.deleted,
        ...(binary ? { binary: true as const } : {}),
        ...(oversized ? { oversized: true as const } : {}),
        ...(status === undefined ? {} : { status }),
        ...(revert === undefined ? {} : { revert }),
      })
    }
    files.sort((left, right) => left.display.localeCompare(right.display))
    // Last gates before the panel sees anything: `root` covers IDENTITY (the tree
    // moved while we read), `publishSeq` covers ORDER (a later publish already
    // wrote a newer list, and this older snapshot must not overwrite it).
    if (ledger.root !== root) return
    if (ledger.publishSeq !== seq) return
    ledger.records = records
    ledger.files = files
    ledger.added = added
    ledger.deleted = deleted
    ledger.truncated = truncated ? true : undefined
    // Ask for contents and get none back: the list is empty because the host did
    // not answer, and saying so beats an empty panel that reads as "nothing
    // changed". A genuinely empty list (nothing dirty) keeps the reason clear.
    ledger.unavailable = listed.length > 0 && after.size === 0
      ? 'file contents could not be read from the host'
      : undefined
    ledger.at = Date.now()
  }

  /**
   * The cheap scan: tracked files whose working-tree bytes differ from the
   * index (1.4s measured on the reference monorepo).
   *
   * A session working directory is often a CONTAINER for repositories rather
   * than one itself (a session root that holds another repository inside it),
   * and `git status` there answers exit 128 — "not a git
   * repository (or any parent up to mount point /)". When that happens the
   * ledger looks one level down once and adopts the repository it finds, which
   * is the same idea the SCM panel's `repoSubdir` expresses by hand.
   *
   * @returns the entries and the root they are relative to, or undefined when no
   *   repository could be found (the ledger then reports why).
   */
  private async scanTracked(ledger: Ledger): Promise<{ root: string; entries: StatusEntry[] } | undefined> {
    let root = ledger.root
    const tracked = await this.run(ledger.alias, trackedStatusCommand(root))
    // A concurrent root move makes this answer describe a tree nobody is
    // looking at any more; hand back nothing instead of mixing two roots.
    if (ledger.root !== root) return undefined
    if (tracked.ok) {
      ledger.unavailable = undefined
      return { root, entries: parseStatusZ(tracked.stdout) }
    }
    // The configured repository directory may belong to a DIFFERENT workspace
    // (the panel reads it from whatever the explorer has selected), or the
    // directory may simply be gone. Either way a missing root is not a reason to
    // report nothing: fall back to the session root once and only then speak.
    if (tracked.code === 90 && ledger.subdir !== '') {
      this.warn(`repository directory "${ledger.subdir}" is missing on the host; falling back to the session root`)
      ledger.subdir = ''
      ledger.root = ledger.baseRoot
      // Same rule as `useRepoSubdir`: the previous root's observations (and its
      // untracked verdicts) say nothing about this one.
      this.resetObservation(ledger)
      root = ledger.root
      const retry = await this.run(ledger.alias, trackedStatusCommand(root))
      if (retry.ok) {
        ledger.unavailable = undefined
        return { root, entries: parseStatusZ(retry.stdout) }
      }
      ledger.unavailable = retry.reason
      return undefined
    }
    if (!ledger.adoptedSubdir) {
      const found = await this.adoptRepositoryBelow(ledger)
      if (found !== undefined) {
        root = ledger.root
        const retry = await this.run(ledger.alias, trackedStatusCommand(root))
        if (retry.ok) {
          ledger.unavailable = undefined
          return { root, entries: parseStatusZ(retry.stdout) }
        }
        ledger.unavailable = retry.reason
        return undefined
      }
    }
    ledger.unavailable = tracked.reason
    return undefined
  }

  /**
   * Look for a repository in the session root's immediate subdirectories.
   *
   * **Only an unambiguous answer is adopted.** A workspace that holds several
   * repositories has no single right one, and silently picking the first would
   * report changes from a project the session never touched — worse than saying
   * "I don't know". The explicit repository directory the Source Control panel
   * stores is the real answer, and this fallback exists only to spare the user
   * from setting it when there is exactly one candidate.
   *
   * @returns the adopted root, or undefined when nothing (or too much) was found.
   */
  private async adoptRepositoryBelow(ledger: Ledger): Promise<string | undefined> {
    ledger.adoptedSubdir = true
    const probe = await this.run(ledger.alias, reposBelowCommand(ledger.root))
    if (!probe.ok) return undefined
    const found = probe.stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '' && !line.includes('/') && line !== '.')
    if (found.length === 0) return undefined
    if (found.length > 1) {
      ledger.unavailable = `no git repository at the workspace root, and ${found.length} candidates below it`
        + ' — set the repository directory in Source Control'
      return undefined
    }
    const adopted = `${ledger.root}/${found[0]}`
    // Adopting a repository one level down is a root move like any other: what
    // was observed against the container root (and what git said about the
    // untracked walk there) describes a different tree.
    this.resetObservation(ledger)
    ledger.root = adopted
    // `resetObservation` cleared it; the probe above already ran for this root,
    // and re-probing on every refresh would turn one transient miss into a loop.
    ledger.adoptedSubdir = true
    this.warn(`no repository at the session root; using ${ledger.root}`)
    return ledger.root
  }

  /**
   * The slow scan: new files, in the background.
   *
   * The same command costs ~11s on a warm tree and over a minute on a cold one,
   * and on the reference AOSP monorepo it has been measured past 60s with no
   * answer at all. It therefore never runs inline with the tracked scan, never
   * runs twice at once, and only runs again after {@link untrackedCadence}. A
   * repository that cannot answer inside {@link untrackedBudget} is written off
   * for the session (`untrackedGivenUp`) rather than retried every turn.
   */
  private async kickUntracked(ledger: Ledger): Promise<void> {
    if (ledger.disposed || ledger.untrackedGivenUp || ledger.untrackedJob !== undefined) return
    if (ledger.untracked !== undefined && Date.now() - ledger.untrackedAt < this.untrackedCadence(ledger)) return
    // The paths this walk produces are relative to the root it runs in; capture
    // it so a root move that happens mid-walk (seconds to minutes here) cannot
    // merge the previous tree's names into the new one.
    const root = ledger.root
    ledger.untrackedAt = Date.now()
    const job = (async () => {
      const started = Date.now()
      const scan = await this.run(ledger.alias, untrackedCommand(root, this.excludedDirs()), this.untrackedBudget())
      ledger.untrackedMs = Date.now() - started
      if (ledger.disposed) return
      if (ledger.root !== root) return
      if (!scan.ok) {
        ledger.untrackedGivenUp = true
        // Keep WHY: the panel can show it, and its absence would make a dead
        // capability look like "this session created no files".
        ledger.untrackedFailure = scan.reason
        this.warn(`untracked scan unusable (${scan.reason}); new files will not be listed`)
        return
      }
      ledger.untrackedFailure = undefined
      ledger.untracked = parseUntrackedZ(scan.stdout)
      await this.absorbPreExisting(ledger)
      // A completed scan is worth one more publish: it is the only source of
      // "a file appeared" rows.
      await this.publish(ledger)
    })()
      .catch(error => this.warn(`untracked scan failed: ${messageOf(error)}`))
      .finally(() => { ledger.untrackedJob = undefined })
    ledger.untrackedJob = job
  }

  /**
   * How long before the untracked scan may run again.
   *
   * Self-tuning on purpose: the same command costs ~0.2s in a small repository
   * and over a minute in a monorepo, so a fixed cadence is either wasteful or
   * useless. Backing off to four times the last duration keeps small projects
   * near-real-time while a big one settles into a scan every couple of minutes
   * instead of one per turn.
   */
  private untrackedCadence(ledger: Ledger): number {
    const configured = this.deps.untrackedRefreshMs
    if (configured !== undefined) return configured
    const last = ledger.untrackedMs
    if (last === undefined) return 0
    // Twice the last duration, so a three-minute scan settles into one every six
    // minutes instead of running back to back forever on a huge checkout.
    return Math.max(5_000, Math.min(last * 2, 600_000))
  }

  /**
   * Fold files that already existed when the session began into the baseline.
   *
   * The untracked walk is slow enough (a minute on a monorepo) that the baseline
   * refresh publishes before it lands, so its first result arrives without a
   * "before" side. Without this, every file the checkout already had — the
   * user's own scratch files, a build's leftovers — would be announced as this
   * session's work, complete with a full-file addition count.
   *
   * mtime decides: strictly older than the ledger's own start means the session
   * cannot have created it, and its present content is therefore its baseline.
   */
  private async absorbPreExisting(ledger: Ledger): Promise<void> {
    if (ledger.untracked === undefined || ledger.absorbed) return
    ledger.absorbed = true
    const root = ledger.root
    const baseline = ledger.baseline ?? new Map<string, ReadResult>()
    ledger.baseline = baseline
    const unknown = ledger.untracked
      .map(entry => entry.path)
      .filter(path => !baseline.has(path))
    if (unknown.length === 0) return
    const reads = await this.readPaths(ledger, unknown, 'worktree')
    // A root move during the read makes the mtimes describe another tree; the
    // move itself reset `absorbed`, so dropping the batch is enough.
    if (ledger.disposed || ledger.root !== root) return
    for (const [path, read] of reads) {
      if (read.mtime === undefined) continue
      if (read.mtime * 1000 < ledger.startedAt) baseline.set(path, read)
    }
  }

  /**
   * Race one host call against its own budget.
   *
   * A budget handed to `exec` is a request, not a guarantee: the transport may
   * keep the promise open long after the command should have been killed (the
   * remote process can even be gone while the channel stays). Awaiting such a
   * promise blocks the ledger's whole queue, so the panel shows "computing…"
   * for as long as the user is willing to stare at it. This bounds that wait.
   */
  private async withWatchdog<T>(call: Promise<T>, ms: number): Promise<T | typeof WATCHDOG_FIRED> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        call,
        new Promise<typeof WATCHDOG_FIRED>(resolve => {
          // Deliberately NOT unref'd: a watchdog that lets the loop drain is a
          // watchdog that never fires — and a check process would exit with an
          // unsettled await instead of reporting the timeout.
          timer = setTimeout(() => resolve(WATCHDOG_FIRED), ms)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      // The abandoned call may still reject later; it must not surface as an
      // unhandled rejection in the Host process.
      void call.catch(() => undefined)
    }
  }

  /** Read a batch of files, capped per file and in total. */
  private async readPaths(
    ledger: Ledger,
    paths: readonly string[],
    side: 'worktree' | 'head',
    limits?: { perFile: number; total: number },
  ): Promise<Map<string, ReadResult>> {
    if (paths.length === 0) return new Map()
    const perFile = limits?.perFile ?? this.deps.maxFileBytes ?? 256 * 1024
    const total = limits?.total ?? this.deps.maxTotalBytes ?? 8 * 1024 * 1024
    const command = side === 'worktree'
      ? readWorktreeCommand(ledger.root, paths, perFile, total)
      : readHeadCommand(ledger.root, paths, perFile, total)
    const result = await this.run(ledger.alias, command)
    if (!result.ok) {
      // A failed read is not fatal: the affected files report a truncated side
      // and the next turn retries.
      this.warn(`read failed (${side}): ${result.reason}`)
      return new Map()
    }
    return parseReads(result.stdout)
  }

  /** Run one command on the host, normalizing failure into a reason string. */
  private async run(alias: string, command: string, budget = this.execBudget()): Promise<
    { ok: true; stdout: string } | { ok: false; reason: string; code?: number | null }
  > {
    try {
      const call = this.deps.pool.exec(alias, command, { timeoutMs: budget })
      const result = await this.withWatchdog(call, budget + Math.min(WATCHDOG_GRACE_MS, budget))
      if (result === WATCHDOG_FIRED) {
        // The host call never came back. Measured: `git ls-files --others` on a
        // monorepo outran a 60s exec and the promise simply never settled, which
        // left `pending` true forever and froze the panel at "computing…".
        return { ok: false, reason: 'git did not answer in time' }
      }
      const stdout = typeof result.stdout === 'string' ? result.stdout : ''
      if (result.success) return { ok: true, stdout }
      const stderr = typeof result.stderr === 'string' ? result.stderr : ''
      return { ok: false, reason: this.reasonOf(result.exitCode, stderr), code: result.exitCode }
    } catch (error) {
      return { ok: false, reason: `host unreachable: ${messageOf(error)}` }
    }
  }

  /** Turn a failed scan into something a user can act on. */
  private reasonOf(exitCode: number | null | undefined, stderr: string): string {
    // 93 is this plugin's own guard; 128 is git's own "not a repository".
    if (exitCode === 93 || exitCode === 128) return 'not a git repository (change tracking needs git)'
    if (exitCode === 90) return 'session directory is missing on the host'
    if (exitCode === 124 || exitCode === null || exitCode === undefined) {
      return `git did not answer in time${stderr === '' ? '' : ` (${firstLine(stderr)})`}`
    }
    return `git failed (exit ${exitCode})${stderr === '' ? '' : ` (${firstLine(stderr)})`}`
  }

  /** One exec's budget: the git setting, clamped so a hung host cannot pile up work. */
  private execBudget(): number {
    const override = this.deps.execBudgetMs
    if (override !== undefined && Number.isFinite(override) && override > 0) return override
    return this.budget(this.deps.timeouts().gitMs, 5_000, 60_000)
  }

  /** The untracked scan gets its own, more generous budget. */
  /**
   * The untracked scan gets its own, much more generous budget.
   *
   * Three minutes is a deliberate choice for a monorepo: the walk is proportional
   * to the whole checkout, not to the session, and the reference AOSP tree has
   * been measured past a minute cold. Waiting is acceptable here because the
   * scan runs in the background and the tracked changes are already on screen;
   * giving up early is not, because the files a session creates with a shell
   * command are visible ONLY through this scan.
   */
  private untrackedBudget(): number {
    return this.deps.untrackedBudgetMs ?? this.budget(this.deps.timeouts().gitMs, 10_000, 180_000)
  }

  /**
   * The exclusions this ledger scans with, normalized once per call.
   *
   * `??` and not `||`: an explicit empty array is a caller saying "count
   * everything", which must stay distinguishable from "not configured".
   */
  private excludedDirs(): string[] {
    return excludeDirNames(this.deps.excludeDirs ?? UNTRACKED_EXCLUDED_DIRECTORIES)
  }

  private budget(configured: number, floor: number, ceiling: number): number {
    const value = Number.isFinite(configured) && configured > 0 ? configured : 30_000
    return Math.max(floor, Math.min(value, ceiling))
  }

  private warn(message: string): void {
    try {
      this.deps.log?.('warn', message)
    } catch {
      // Logging must never break a turn.
    }
  }
}

function firstLine(text: string): string {
  const line = text.split('\n').find(candidate => candidate.trim() !== '') ?? ''
  return line.trim().slice(0, 160)
}

/** Workspace-relative repository directory, or '' when the value is unusable. */
function normalizeRepoSubdir(value: string | undefined): string {
  if (value === undefined) return ''
  const trimmed = value.trim().replace(/^\.\/+/, '').replace(/\/+$/, '')
  if (trimmed === '' || trimmed === '.') return ''
  if (trimmed.startsWith('/') || trimmed.includes('..')) return ''
  return trimmed
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
