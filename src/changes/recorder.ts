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
  parseReads,
  parseStatusZ,
  parseUntrackedZ,
  readHeadCommand,
  readWorktreeCommand,
  trackedStatusCommand,
  untrackedCommand,
  type ChangeStatus,
  type ReadResult,
  type StatusEntry,
} from './status.ts'
import { diffText, hunkPatch } from './text-diff.ts'

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
}

/** Grace added to an exec budget before the watchdog gives up on it. */
const WATCHDOG_GRACE_MS = 5_000
/** Sentinel for "the host call never came back". */
const WATCHDOG_FIRED = 'watchdog-fired' as const

/** One session's bookkeeping. */
interface Ledger {
  sessionId: string
  alias: string
  root: string
  /** Content of every path that was ALREADY dirty when the session began. */
  baseline: Map<string, ReadResult> | undefined
  baselineTaken: boolean
  /** Set once the untracked scan proves unusable on this host; stops retrying it. */
  untrackedGivenUp: boolean
  /** Wall-clock ms this ledger appeared: the session's own start for mtime tests. */
  startedAt: number
  /** True once the first untracked result has been folded into the baseline. */
  absorbed: boolean
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
    return {
      alias: ledger.alias,
      root: ledger.root,
      turn: ledger.turn,
      files: ledger.files,
      added: ledger.added,
      deleted: ledger.deleted,
      at: ledger.at,
      // The slow scan counts as pending too. Without it, a turn whose only
      // product is a NEW file would look like "nothing changed" for the minute
      // the untracked walk needs — the panel would hide and the user would
      // conclude the feature is broken, right up to the moment the row appears.
      pending: ledger.pending || ledger.untrackedJob !== undefined,
      ...(ledger.truncated === true ? { truncated: true as const } : {}),
      ...(ledger.unavailable === undefined ? {} : { unavailable: ledger.unavailable }),
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
    const fresh = await this.readPaths(ledger, [record.display], 'worktree')
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
    const result = diffText(record.before ?? '', afterText ?? '')
    const hunks: UnifiedHunk[] = result.hunks.map(hunk => ({
      oldStart: hunk.oldStart,
      oldCount: hunk.oldLines,
      newStart: hunk.newStart,
      newCount: hunk.newLines,
      heading: '',
      lines: hunk.lines,
      // The client hands this straight to `git apply -R` for "revert this
      // change", so it must be a real patch, not a display artifact.
      patch: hunkPatch(record.display, hunk),
    }))
    if (hunks.length === 0) {
      return { kind: 'missing', path, display: record.display, hunks: [], ...(status === undefined ? {} : { status }) }
    }
    return {
      kind: 'text',
      path,
      display: record.display,
      hunks,
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
    ledger.untrackedAt = 0
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

  // ------------------------------------------------------------- internals

  /** Resolve the routing target once per session, caching the ledger. */
  private ensure(target: LedgerTarget): Ledger | undefined {
    if (target.cwd.trim() === '') return undefined
    const existing = this.ledgers.get(target.sessionId)
    if (existing !== undefined && !existing.disposed && existing.root !== '') return existing
    let route: WorldRoute
    try {
      route = this.deps.worlds.routeDir(target.cwd)
    } catch {
      return undefined
    }
    if (route.kind !== 'remote') {
      // Local sessions are already covered by DSH's own recorder, and this
      // panel is a remote-workspace feature: keeping no ledger is what makes it
      // stay hidden there instead of showing a permanently empty box.
      this.ledgers.delete(target.sessionId)
      return undefined
    }
    const root = route.remotePath.length > 1 && route.remotePath.endsWith('/')
      ? route.remotePath.replace(/\/+$/, '')
      : route.remotePath
    const ledger: Ledger = {
      sessionId: target.sessionId,
      alias: route.alias,
      root,
      baseline: undefined,
      baselineTaken: false,
      untrackedGivenUp: false,
      startedAt: Date.now(),
      absorbed: false,
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
    const tracked = await this.scanTracked(ledger)
    if (ledger.disposed || tracked === undefined) return
    ledger.tracked = tracked
    await this.publish(ledger)
    void this.kickUntracked(ledger)
  }

  /** Recompute the panel's list from the scans currently known. */
  private async publish(ledger: Ledger): Promise<void> {
    if (ledger.disposed) return
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
      ledger.baseline = await this.readPaths(ledger, listed.map(entry => entry.path), 'worktree')
      if (ledger.disposed) return
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
    if (ledger.disposed) return

    const records = new Map<string, FileRecord>()
    const files: RemoteChangedFile[] = []
    let added = 0
    let deleted = 0
    for (const entry of listed) {
      const beforeSide = baseline.get(entry.path) ?? head.get(entry.path)
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
      })
    }
    files.sort((left, right) => left.display.localeCompare(right.display))
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
   * @returns entries relative to the session root, or undefined when the root
   *   is not a usable repository (the ledger then reports why).
   */
  private async scanTracked(ledger: Ledger): Promise<StatusEntry[] | undefined> {
    const tracked = await this.run(ledger.alias, trackedStatusCommand(ledger.root))
    if (!tracked.ok) {
      ledger.unavailable = tracked.reason
      return undefined
    }
    ledger.unavailable = undefined
    return parseStatusZ(tracked.stdout)
  }

  /**
   * The slow scan: new files, in the background.
   *
   * Measured at 11s on a warm tree and 71s on the same monorepo cold, so it never
   * runs inline with the tracked scan, never runs twice at once, and only runs
   * again after {@link untrackedRefreshMs}. A repo that cannot answer inside the
   * budget is written off for the session (`untrackedGivenUp`) instead of being
   * retried every turn.
   */
  private async kickUntracked(ledger: Ledger): Promise<void> {
    if (ledger.disposed || ledger.untrackedGivenUp || ledger.untrackedJob !== undefined) return
    if (ledger.untracked !== undefined && Date.now() - ledger.untrackedAt < this.untrackedCadence(ledger)) return
    ledger.untrackedAt = Date.now()
    const job = (async () => {
      const started = Date.now()
      const scan = await this.run(ledger.alias, untrackedCommand(ledger.root), this.untrackedBudget())
      ledger.untrackedMs = Date.now() - started
      if (ledger.disposed) return
      if (!scan.ok) {
        ledger.untrackedGivenUp = true
        this.warn(`untracked scan unusable (${scan.reason}); new files will not be listed`)
        return
      }
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
    return Math.max(5_000, Math.min(last * 4, 120_000))
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
    const baseline = ledger.baseline ?? new Map<string, ReadResult>()
    ledger.baseline = baseline
    const unknown = ledger.untracked
      .map(entry => entry.path)
      .filter(path => !baseline.has(path))
    if (unknown.length === 0) return
    const reads = await this.readPaths(ledger, unknown, 'worktree')
    if (ledger.disposed) return
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
  ): Promise<Map<string, ReadResult>> {
    if (paths.length === 0) return new Map()
    const perFile = this.deps.maxFileBytes ?? 256 * 1024
    const total = this.deps.maxTotalBytes ?? 8 * 1024 * 1024
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
    { ok: true; stdout: string } | { ok: false; reason: string }
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
      return { ok: false, reason: this.reasonOf(result.exitCode, stderr) }
    } catch (error) {
      return { ok: false, reason: `host unreachable: ${messageOf(error)}` }
    }
  }

  /** Turn a failed scan into something a user can act on. */
  private reasonOf(exitCode: number | null | undefined, stderr: string): string {
    if (exitCode === 93) return 'not a git repository (change tracking needs git)'
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
  private untrackedBudget(): number {
    return this.deps.untrackedBudgetMs ?? this.budget(this.deps.timeouts().gitMs, 10_000, 90_000)
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
