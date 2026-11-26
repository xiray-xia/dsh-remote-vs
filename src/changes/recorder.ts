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
import { diffText, filePatch, hunkPatch, type TextHunk } from './text-diff.ts'

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
  /**
   * Memory budget for the cached per-turn hunks and reverse patches, in bytes.
   *
   * Overridable so a check can exercise the over-budget degradation without
   * generating four megabytes of text; the real default is {@link MAX_TURN_PATCH_BYTES}.
   */
  turnPatchBytes?: number
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

/**
 * One file's comparison for the most recent COMPLETED turn.
 *
 * `before` is the text the file had at the previous turn's close (or, for a path
 * that only became a session change in this turn, the session baseline — see
 * `closeTurn`), `after` is the text at THIS turn's close. Both sides are kept so
 * `turnDiff` can prove the file has not moved since (a fresh read against
 * `after`) — that proof is what keeps stale hunks off the screen.
 */
interface TurnFileRecord {
  display: string
  /** Remote absolute POSIX path (the `turnDiff` lookup key). */
  path: string
  status: PanelStatus | undefined
  binary: boolean
  /** Bytes were withheld by a read cap: no comparison, no patch. */
  oversized: boolean
  hunks: TextHunk[]
  before: string | null
  after: string | null
  /** The WHOLE turn comparison as one reverse-appliable patch (`''` = none). */
  filePatch: string
}

/** The last completed turn's delta, cached between turn closes. */
interface TurnDelta {
  turn: number
  files: RemoteChangedFile[]
  added: number
  deleted: number
  at: number
  /**
   * Whether {@link TurnDelta.records} is usable.
   *
   * `false` = the contents blew the memory budget: the counts/files above are
   * still real, but there are no hunks and no revert. Set once per session and
   * never cleared (see {@link Ledger.turnDisabled}).
   */
  cached: boolean
  reason: string | undefined
  /**
   * This view is incomplete — see `RemoteChangesTurnView.truncated` for the exact
   * meaning (it is NOT "files is a prefix": rows that cannot be attributed are
   * dropped outright).
   */
  truncated: true | undefined
  /**
   * The turn's slow scan has not landed yet: the same turn will be rebuilt once
   * it does (`correctTurn`), so the row list may still grow.
   */
  provisional: boolean
  /** Per absolute remote path. */
  records: Map<string, TurnFileRecord>
  /** Bytes the cached hunks/patches occupy (see {@link MAX_TURN_PATCH_BYTES}). */
  bytes: number
}

/** Both sides of one path as the turn delta builder needs them. */
interface TurnSide {
  /** Text on this side, or null when the side is absent / not text. */
  text: string | null
  binary: boolean
  truncated: boolean
  /**
   * Whether `text: null` means "the file is absent" (known) or "the bytes were
   * withheld" (unknown).
   *
   * Load-bearing at a turn boundary: an unknown side must never be read as an
   * empty one, or the next turn reports the file as a whole-file CREATION even
   * though its bytes never moved (review M2).
   */
  known: boolean
}

/** Text of one read result, with "nothing usable transferred" folded into null. */
function turnSideOf(read: ReadResult): TurnSide {
  const binary = read.binary === true
  const truncated = read.truncated === true
  return {
    text: read.absent || binary || truncated ? null : read.text,
    binary,
    truncated,
    known: !binary && !truncated,
  }
}

/**
 * One path's remembered side at a turn close.
 *
 * A plain `string | null` could not tell "the file was absent" from "its bytes
 * were withheld", and the two call for opposite answers at the next boundary
 * (absent = a creation; withheld = no evidence at all).
 */
interface TurnSideText {
  text: string | null
  /** False = `text` is unknown (binary or over a read cap), not "empty". */
  known: boolean
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

/**
 * Budget for ONE completed turn's **per-file hunks and reverse patches**.
 *
 * What it counts (and what it deliberately does NOT): the sum of every served
 * file patch plus the hunk line bodies. The two FULL texts per record (`before`
 * and `after`) and the `turnAfter` snapshot are not counted — they are what the
 * staleness proof compares against, and they are already bounded by the scan
 * caps (≲256 KiB/file, 8 MiB/turn for `after` plus the same order for `before`
 * and the snapshot). So the real resident cost is this budget PLUS those texts
 * (worst case ≈ 16 MiB + 4 MiB per active session), which is why the copy says
 * "patches and hunk text" rather than "the turn's contents".
 *
 * The turn view must keep a comparison per changed file until the next turn
 * closes (that is what `turnDiff` serves without re-reading the remote). 4 MiB
 * fits a large refactor's patches; crossing it disables per-turn hunks for the
 * session (see {@link Ledger.turnDisabled}) rather than thrashing the budget.
 */
const MAX_TURN_PATCH_BYTES = 4 * 1024 * 1024

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
   * The latest turn that closed since the last publish consumed it.
   *
   * `endTurn` only records the boundary; the delta itself is computed inside
   * `publish`, AFTER its root/publishSeq gates. Computing it in `endTurn` would
   * race the very refresh it is about to schedule (the file reads are the
   * expensive part), and also miss the untracked scan that a turn's new files
   * arrive through.
   */
  pendingClose: number | undefined
  /**
   * Every LISTED path's side at the previous turn close (see `TurnSideText`:
   * `known: false` = the bytes were withheld, so the value says nothing about
   * whether the file was there). This is the "before" side of the next turn's
   * delta; it moves only when a turn closes, so a mid-turn poll cannot fold the
   * session's own work into the next turn.
   */
  turnAfter: Map<string, TurnSideText> | undefined
  /**
   * The previous close's snapshot was cut by the file cap.
   *
   * A path missing from a truncated snapshot is not evidence that it was not
   * dirty then, so "new to the list = changed this turn" becomes a guess. The
   * ledger stops attributing rather than guessing (see {@link turnDisabled}).
   */
  turnAfterTruncated: boolean
  /** The most recent completed turn's delta (what `summary().turnView` reports). */
  turnDelta: TurnDelta | undefined
  /**
   * The snapshot the CURRENT delta was computed against.
   *
   * Kept so a late `git ls-files --others` result can RECOMPUTE the same turn:
   * the slow walk is what discovers files a turn created, and it lands after the
   * turn's tracked scan by design. Without this the delta would either miss them
   * or attribute them to the next turn.
   */
  turnBefore: Map<string, TurnSideText> | undefined
  /**
   * Whether THAT snapshot was cut by the file cap.
   *
   * Kept apart from {@link turnAfterTruncated}: a correction compares against the
   * snapshot the delta was built from, while the close records the one the NEXT
   * turn will use. Sharing one flag made the correction of a turn that had just
   * crossed the cap silently drop every row it had.
   */
  turnBeforeTruncated: boolean
  /** The current delta is still waiting for its turn's slow scan to land. */
  turnProvisional: boolean
  /**
   * Why per-turn views stopped for this session; sticky.
   *
   * Currently one source: the memory budget. Once the hunks of a turn were
   * dropped, its "before" side was never advanced, so continuing would attribute
   * an older change to the newest turn — worse than not having the view at all.
   * The session-cumulative view is unaffected.
   */
  turnDisabled: string | undefined
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

/** The inverse of {@link posixJoin} for a path under `root`; '' when it is not. */
function displayUnder(root: string, path: string): string {
  const base = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(base) ? path.slice(base.length) : ''
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
    /*
     * Two events deliver the SAME boundary: `turn/end` and
     * `agent/turn-stopping`. Re-opening it after it was consumed would make the
     * next publish close the same turn again — with `turnAfter` already advanced,
     * that second delta is empty and would overwrite the real one (review S3).
     * A boundary is therefore recorded only when it moves the ledger forward.
     */
    const advanced = turn > ledger.turn
    ledger.turn = Math.max(ledger.turn, turn)
    if (advanced) ledger.pendingClose = turn
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
      /*
       * The turn view rides along with every summary: the panel polls ONE route,
       * and a second request just to learn "is there a turn delta" would double
       * the poll cost. Omitted entirely when no turn has closed yet, which is
       * what keeps an older client (and a session that never finished a turn)
       * on the cumulative list.
       */
      ...(ledger.turnDelta === undefined ? {} : {
        turnView: {
          turn: ledger.turnDelta.turn,
          files: ledger.turnDelta.files,
          added: ledger.turnDelta.added,
          deleted: ledger.turnDelta.deleted,
          at: ledger.turnDelta.at,
          cached: ledger.turnDelta.cached,
          ...(ledger.turnDelta.reason === undefined ? {} : { reason: ledger.turnDelta.reason }),
          ...(ledger.turnDelta.truncated === true ? { truncated: true as const } : {}),
          // The turn's own slow scan has not landed yet: the rows may still grow
          // (the same turn is rebuilt, never relabelled as the next one).
          ...(ledger.turnDelta.provisional ? { pending: true as const } : {}),
        },
      }),
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
      /**
       * Both sides were READ and compared, so "no hunks" means the file is back
       * at its session baseline (the change was reverted, or an identical byte
       * round-trip). That is NOT "missing": the panel shows `missing` as "the
       * remote cannot read this file", and saying that about a file the host
       * just read is a lie that also hides "your change is gone". A withheld
       * side (null) keeps `missing` — there is genuinely nothing to compare.
       */
      /**
       * 判定只看**改后那一侧读到了**：新建的空文件 before 是 null（不存在），after
       * 读到 `''`，零 hunk 是"读到了、只是没有内容"，不是"读不到"。老条件要求两侧
       * 都非 null，于是会话新建的空文件被报成 `missing`，面板显示「远端读不到」
       * （审核 NIT-1）。
       */
      if (afterText !== null) {
        return { kind: 'text', path, display: record.display, hunks: [], ...(status === undefined ? {} : { status }) }
      }
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

  /**
   * One file's comparison for the most recent COMPLETED turn.
   *
   * Same shape as {@link diff} (the editor paints both the same way), but the
   * "before" side is the previous turn's close instead of the session baseline.
   * The hunks are served from the turn delta's cache, so this call costs NO
   * remote work in the common case — but a cached comparison is only worth
   * showing while it still describes the disk. That is why the `after` side is
   * read back here and compared with the cached text FIRST: if the file moved on
   * after the turn closed (a later save, a terminal command, an agent), the
   * answer is `stale` and the client falls back to the session view instead of
   * painting line numbers that no longer exist.
   *
   * @param sessionId - live session owning the ledger.
   * @param path - the file's remote absolute path (as listed in `turnView.files`).
   * @returns hunks for decorations, `unavailable`/`stale` with a reason, or null
   *   when the session itself is unknown.
   */
  async turnDiff(sessionId: string, path: string): Promise<RemoteChangesDiff | null> {
    const ledger = this.ledgers.get(sessionId)
    if (ledger === undefined) return null
    const delta = ledger.turnDelta
    const display = delta?.records.get(path)?.display ?? displayUnder(ledger.root, path)
    if (delta === undefined) {
      return {
        kind: 'unavailable',
        path,
        display,
        hunks: [],
        reason: 'no turn has closed since this session started',
      }
    }
    if (!delta.cached) {
      return {
        kind: 'unavailable',
        path,
        display,
        hunks: [],
        reason: delta.reason ?? 'per-turn change contents are not cached for this session',
      }
    }
    const record = delta.records.get(path)
    if (record === undefined) {
      return {
        kind: 'unavailable',
        path,
        display,
        hunks: [],
        reason: `this file is not part of turn ${delta.turn}'s change set`,
      }
    }
    const status = record.status
    if (record.binary) {
      return { kind: 'binary', path, display: record.display, hunks: [], ...(status === undefined ? {} : { status }) }
    }
    if (record.oversized) {
      return {
        kind: 'unavailable',
        path,
        display: record.display,
        hunks: [],
        reason: 'the bytes of this file were withheld by the size cap, so there is no line-level comparison',
        ...(status === undefined ? {} : { status }),
      }
    }
    /**
     * Verify the cache against the disk before serving it.
     *
     * A failed read is NOT "unchanged": without evidence the honest answer is
     * `unavailable` (no palatable guess). A binary or cap-truncated read proves
     * the bytes moved on after the turn closed, which is exactly `stale`.
     */
    const fresh = await this.readPaths(ledger, [record.display], 'worktree', DIFF_LIMITS)
    if (ledger.disposed) return null
    const side = fresh.get(record.display)
    if (side === undefined) {
      return {
        kind: 'unavailable',
        path,
        display: record.display,
        hunks: [],
        reason: 'the file could not be read back from the host, so the turn comparison cannot be verified',
        ...(status === undefined ? {} : { status }),
      }
    }
    const current = turnSideOf(side)
    if (current.binary || current.truncated) {
      return {
        kind: 'stale',
        path,
        display: record.display,
        hunks: [],
        reason: current.binary
          ? 'the file has become binary since the turn closed'
          : 'the file has grown past the read budget since the turn closed',
        ...(status === undefined ? {} : { status }),
      }
    }
    if (current.text !== record.after) {
      return {
        kind: 'stale',
        path,
        display: record.display,
        hunks: [],
        reason: 'the file was modified after the turn closed',
        ...(status === undefined ? {} : { status }),
      }
    }
    const hunks: UnifiedHunk[] = record.hunks.map(hunk => ({
      oldStart: hunk.oldStart,
      oldCount: hunk.oldLines,
      newStart: hunk.newStart,
      newCount: hunk.newLines,
      heading: '',
      lines: hunk.lines,
      // Same rule as `diff`: a real `git apply -R` patch per hunk, empty when the
      // turn's reverse cannot be expressed (a whole-file creation).
      patch: record.filePatch === '' ? '' : hunkPatch(record.display, hunk),
    }))
    return {
      kind: 'text',
      path,
      display: record.display,
      hunks,
      ...(record.filePatch === '' ? {} : { patch: record.filePatch }),
      ...(status === undefined ? {} : { status }),
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
    // The turn delta describes the previous tree: its paths are relative to the
    // old root and its patch headers would apply in the wrong checkout. Drop it
    // with the rest of the observation. `turnDisabled` deliberately stays — it is
    // a verdict about this session's size (like `publishSeq`, which is not an
    // observation either), and re-enabling it would only re-blow the budget.
    ledger.pendingClose = undefined
    ledger.turnAfter = undefined
    ledger.turnAfterTruncated = false
    ledger.turnDelta = undefined
    ledger.turnBefore = undefined
    ledger.turnBeforeTruncated = false
    ledger.turnProvisional = false
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
      pendingClose: undefined,
      turnAfter: undefined,
      turnAfterTruncated: false,
      turnDelta: undefined,
      turnBefore: undefined,
      turnBeforeTruncated: false,
      turnProvisional: false,
      turnDisabled: undefined,
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

  /**
   * Recompute the panel's list from the scans currently known.
   *
   * @param fromSlowScan - this publish was triggered by the `git ls-files
   *   --others` walk. A turn delta closed before that walk landed is still
   *   provisional: this flag is what lets it be re-derived once the turn's new
   *   files are known (see `correctTurn`).
   */
  private async publish(ledger: Ledger, fromSlowScan = false): Promise<void> {
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
    /*
     * The turn delta is derived from the SAME snapshot the panel just received
     * and only after the two write gates above: it compares against "what the
     * file looked like when the previous turn closed", so it must not be fed an
     * older (or mixed-root) list. A publish that only carries the slow scan's
     * result instead CORRECTS the turn it already closed.
     */
    if (ledger.pendingClose !== undefined) {
      await this.closeTurn(ledger, root, seq, entries, listed, after, records, truncated)
    } else if (fromSlowScan) {
      await this.correctTurn(ledger, root, seq, entries, listed, after, records, truncated)
    }
  }

  /**
   * Close one turn: compute "what did it change" and remember this close as the
   * next turn's starting point.
   *
   * The delta is defined against the PREVIOUS close, not the session baseline, so
   * a file the session changed in turn 1 and left alone in turn 2 must not appear
   * in turn 2's list — otherwise the view says the same work happened twice.
   * That is what `turnAfter` is for: it holds every listed path's text at the
   * moment the previous turn closed, and it is replaced (never merged) here.
   *
   * A failed `after` read leaves the boundary unconsumed, so the next publish
   * retries instead of recording a turn against "nothing".
   */
  private async closeTurn(
    ledger: Ledger,
    root: string,
    seq: number,
    entries: readonly StatusEntry[],
    listed: readonly StatusEntry[],
    after: Map<string, ReadResult>,
    records: Map<string, FileRecord>,
    truncated: boolean,
  ): Promise<void> {
    const turn = ledger.pendingClose
    if (turn === undefined || ledger.disposed) return
    // A written-off session must not keep a boundary around: nothing will ever
    // consume it, and `endTurn` would only re-set it on the next turn.
    ledger.pendingClose = undefined
    if (ledger.turnDisabled !== undefined) return
    const known = ledger.turnAfter
    const collected = await this.collectTurnSides(ledger, root, seq, listed, after, known)
    if (collected.kind === 'retry') {
      ledger.pendingClose = turn
      return
    }
    if (collected.kind === 'superseded') return
    /**
     * A previous snapshot cut by the file cap cannot prove that a path MISSING
     * from it was clean — it may simply have been past the cap. Entries that were
     * listed then are still exact, so only the "newcomer = changed this turn"
     * inference is dropped, and the view says it is partial (`truncated`).
     */
    const partial = ledger.turnAfterTruncated
    /*
     * If the PREVIOUS turn's slow scan never landed before this close, its
     * snapshot may be missing files — so this turn's "newcomer = changed now"
     * inference is unreliable too. The new view therefore keeps saying it is
     * partial (review S2).
     */
    const previousUncorrected = ledger.turnProvisional
    const built = this.buildTurnDelta(root, turn, collected.now, entries, records, known, partial, truncated)
    this.storeTurnDelta(ledger, built, previousUncorrected)
    if (built.overflow) return
    ledger.turnBefore = known
    ledger.turnBeforeTruncated = partial
    ledger.turnProvisional = true
    /**
     * This close becomes the next turn's starting point. Built from `listed`
     * ONLY: a path that left the dirty list is at its baseline, and the session
     * baseline is exactly what a re-appearance will be compared against — keeping
     * it here would cost a full re-read of every reverted file on every later
     * turn.
     */
    ledger.turnAfter = this.turnSnapshotOf(listed, collected.now)
    ledger.turnAfterTruncated = truncated
  }

  /**
   * Re-derive the CURRENT turn's delta once the slow scan behind it has landed.
   *
   * A turn's new files are discovered by `git ls-files --others`, which runs
   * after the tracked scan by design and can land seconds later. Rebuilding the
   * same turn from the SAME "before" snapshot (kept in `turnBefore`) is what
   * makes those files appear in the turn they belong to instead of in the next
   * one. Guarded against the two ways this could lie: a newer turn boundary
   * (which supersedes this delta) and a root move.
   */
  private async correctTurn(
    ledger: Ledger,
    root: string,
    seq: number,
    entries: readonly StatusEntry[],
    listed: readonly StatusEntry[],
    after: Map<string, ReadResult>,
    records: Map<string, FileRecord>,
    truncated: boolean,
  ): Promise<void> {
    const delta = ledger.turnDelta
    const before = ledger.turnBefore
    // `before === undefined` is legitimate on the FIRST turn (there is no previous
    // close): the delta then compares against the session baseline, so the
    // correction must run there too or a turn's new files never arrive.
    if (!ledger.turnProvisional || delta === undefined) return
    // Only the first slow-scan publish after the close may correct it, and only
    // while its turn is still the current one.
    ledger.turnProvisional = false
    if (ledger.turnDisabled !== undefined || ledger.turn !== delta.turn) return
    const collected = await this.collectTurnSides(ledger, root, seq, listed, after, before)
    if (collected.kind !== 'ok') return
    // The correction compares against `turnBefore`, so it must use THAT snapshot's
    // cap verdict — not the one the close just stored for the next turn.
    const partial = ledger.turnBeforeTruncated
    const built = this.buildTurnDelta(root, delta.turn, collected.now, entries, records, before, partial, truncated)
    // `previousUncorrected` is false here: this IS the correction, so it must not
    // carry the "previous view was uncorrected" verdict forward.
    this.storeTurnDelta(ledger, built, false)
    if (built.overflow) return
    // The correction has landed: the view is final for this turn.
    const stored = ledger.turnDelta
    if (stored !== undefined) stored.provisional = false
    ledger.turnAfter = this.turnSnapshotOf(listed, collected.now)
  }

  /** Remember one close's sides for the next boundary (see `TurnSideText`). */
  private turnSnapshotOf(
    listed: readonly StatusEntry[],
    now: Map<string, TurnSide>,
  ): Map<string, TurnSideText> {
    const snapshot = new Map<string, TurnSideText>()
    for (const entry of listed) {
      const side = now.get(entry.path)
      snapshot.set(entry.path, { text: side?.text ?? null, known: side?.known ?? false })
    }
    return snapshot
  }

  /**
   * The "after" side of one turn close, in `display` space.
   *
   * Starts from the publish's own reads (every listed path), then reads the paths
   * the PREVIOUS close listed but this publish does not: those left the dirty
   * list (reverted to their baseline, deleted, restored), and without reading
   * them now the revert would be attributed to nobody — "the turn put the file
   * back" would look like "the turn changed nothing".
   *
   * @returns `ok` with the sides; `retry` when a read failed (the caller keeps
   *   the turn boundary for the next publish); `superseded` when a root move or
   *   a newer publish already owns the observation.
   */
  private async collectTurnSides(
    ledger: Ledger,
    root: string,
    seq: number,
    listed: readonly StatusEntry[],
    after: Map<string, ReadResult>,
    known: Map<string, TurnSideText> | undefined,
  ): Promise<{ kind: 'ok'; now: Map<string, TurnSide> } | { kind: 'retry' } | { kind: 'superseded' }> {
    // No "after" side at all (the reads failed): there is nothing to compare.
    if (listed.length > 0 && after.size === 0) return { kind: 'retry' }
    const now = new Map<string, TurnSide>()
    for (const entry of listed) {
      const side = after.get(entry.path)
      if (side === undefined) return { kind: 'retry' }
      now.set(entry.path, turnSideOf(side))
    }
    const vanished = known === undefined ? [] : [...known.keys()].filter(display => !now.has(display))
    if (vanished.length === 0) return { kind: 'ok', now }
    const reads = await this.readPaths(ledger, vanished, 'worktree')
    if (ledger.disposed) return { kind: 'superseded' }
    if (ledger.root !== root || ledger.publishSeq !== seq) return { kind: 'superseded' }
    if (reads.size === 0) return { kind: 'retry' }
    for (const display of vanished) {
      const side = reads.get(display)
      if (side === undefined) return { kind: 'retry' }
      now.set(display, turnSideOf(side))
    }
    return { kind: 'ok', now }
  }

  /**
   * Compare one turn's before/after sides into panel rows plus cached hunks.
   *
   * The comparison rules are the ones the whole-session `publish` uses (binary
   * and cap-withheld bytes carry 0/0 counts, a creation has no reverse patch,
   * hunks come from the same Myers implementation), so a row means the same
   * thing in both views.
   */
  private buildTurnDelta(
    root: string,
    turn: number,
    now: Map<string, TurnSide>,
    entries: readonly StatusEntry[],
    records: Map<string, FileRecord>,
    known: Map<string, TurnSideText> | undefined,
    partial: boolean,
    capTruncated: boolean,
  ): {
    turn: number
    files: RemoteChangedFile[]
    added: number
    deleted: number
    records: Map<string, TurnFileRecord>
    bytes: number
    overflow: boolean
    /** This view drops rows it cannot attribute (see `TurnDelta.truncated`). */
    incomplete: boolean
  } {
    const statusOf = new Map<string, PanelStatus | undefined>()
    for (const entry of entries) statusOf.set(entry.path, panelStatus(entry.status))
    const budget = this.deps.turnPatchBytes ?? MAX_TURN_PATCH_BYTES
    const files: RemoteChangedFile[] = []
    const turnRecords = new Map<string, TurnFileRecord>()
    let added = 0
    let deleted = 0
    let bytes = 0
    let incomplete = partial || capTruncated
    for (const [display, side] of now) {
      const absolute = posixJoin(root, display)
      const record = records.get(absolute)
      const had = known !== undefined && known.has(display)
      // Not listed at the previous close AND not a session change now either: a
      // file the session never touched (pre-existing dirt), which is not work.
      // With a truncated previous snapshot, a newcomer is not evidence either.
      if (!had && (record === undefined || partial)) continue
      /*
       * The PREVIOUS side is unknown (its bytes were binary / over a read cap).
       * "null" here must never be read as "the file was absent": doing so turns an
       * unchanged binary/oversized file into a whole-file CREATION (review M2).
       * There is no evidence to compare, so the row is dropped and the view is
       * marked incomplete — an honest gap, not a fabricated diff. The next close
       * can attribute normally because this close records the side as readable.
       */
      const previous = had ? known.get(display) : undefined
      if (had && previous !== undefined && previous.known === false) {
        incomplete = true
        continue
      }
      /*
       * Where the "before" side comes from, in order of authority:
       * - the previous turn close, when this path was listed then (exact);
       * - the session baseline, for a path that became a session change in THIS
       *   turn (the best remaining evidence, and the only side that exists);
       * - nothing, otherwise.
       */
      const before = had ? (previous?.text ?? null) : (record?.before ?? null)
      // Listed on both sides and byte-identical: the turn did not touch it.
      if (had && before === side.text) continue
      const binary = side.binary || record?.binary === true
      const oversized = !binary && (side.truncated || record?.truncated === true)
      let fileAdded = 0
      let fileDeleted = 0
      let hunks: TextHunk[] = []
      let patch = ''
      if (!binary && !oversized) {
        const result = diffText(before ?? '', side.text ?? '')
        fileAdded = result.added
        fileDeleted = result.deleted
        hunks = result.hunks
        /*
         * A whole-file creation has no reverse patch (its reverse is "delete the
         * file", which the client expresses through `revert` and only the HOST
         * may decide). Same rule as `publish`/`diff`.
         */
        patch = before !== null && hunks.length > 0 ? filePatch(display, hunks) : ''
        // Memory accounting: the patch plus the hunk bodies are what the cache
        // holds beyond the two texts (which the record needs for the staleness
        // proof) — see MAX_TURN_PATCH_BYTES.
        if (patch !== '') bytes += Buffer.byteLength(patch, 'utf8')
        for (const hunk of hunks) {
          for (const line of hunk.lines) bytes += Buffer.byteLength(line, 'utf8') + 1
        }
      }
      added += fileAdded
      deleted += fileDeleted
      const status = statusOf.get(display)
      const revert: 'patch' | undefined = patch === '' ? undefined : 'patch'
      files.push({
        path: absolute,
        display,
        added: fileAdded,
        deleted: fileDeleted,
        ...(binary ? { binary: true as const } : {}),
        ...(oversized ? { oversized: true as const } : {}),
        ...(status === undefined ? {} : { status }),
        ...(revert === undefined ? {} : { revert }),
      })
      turnRecords.set(absolute, {
        display,
        path: absolute,
        status,
        binary,
        oversized,
        hunks,
        before,
        after: side.text,
        filePatch: patch,
      })
    }
    files.sort((left, right) => left.display.localeCompare(right.display))
    return { turn, files, added, deleted, records: turnRecords, bytes, overflow: bytes > budget, incomplete }
  }

  /**
   * Commit one built delta, degrading honestly when it blew the memory budget.
   *
   * Over budget the statistics are already computed and stay usable, but the
   * per-file hunks and patches are dropped and this session stops computing turn
   * views: keeping a half-filled snapshot would make the NEXT turn compare
   * against texts that belong to an older boundary.
   */
  private storeTurnDelta(
    ledger: Ledger,
    built: {
      turn: number
      files: RemoteChangedFile[]
      added: number
      deleted: number
      records: Map<string, TurnFileRecord>
      bytes: number
      overflow: boolean
      incomplete: boolean
    },
    /** The turn BEFORE this one closed without ever being corrected (review S2). */
    uncorrectedPrevious: boolean,
  ): void {
    const truncated = built.incomplete || uncorrectedPrevious
    if (!built.overflow) {
      ledger.turnDelta = {
        turn: built.turn,
        files: built.files,
        added: built.added,
        deleted: built.deleted,
        at: Date.now(),
        cached: true,
        reason: undefined,
        truncated: truncated ? true : undefined,
        provisional: true,
        records: built.records,
        bytes: built.bytes,
      }
      return
    }
    const budget = this.deps.turnPatchBytes ?? MAX_TURN_PATCH_BYTES
    const reason = `the per-turn patches and hunk text exceed the ${budget} byte memory budget`
      + '; turn totals stay available without per-file hunks'
    ledger.turnDelta = {
      turn: built.turn,
      files: built.files.map(file => {
        const { revert: _revert, ...rest } = file
        return rest
      }),
      added: built.added,
      deleted: built.deleted,
      at: Date.now(),
      cached: false,
      reason,
      truncated: truncated ? true : undefined,
      provisional: false,
      records: new Map(),
      bytes: built.bytes,
    }
    this.disableTurn(ledger, reason)
  }

  /** Stop computing turn views for this session, saying why (sticky). */
  private disableTurn(ledger: Ledger, reason: string): void {
    if (ledger.turnDisabled !== undefined) return
    ledger.turnDisabled = reason
    ledger.turnAfter = undefined
    ledger.turnAfterTruncated = false
    ledger.turnBefore = undefined
    ledger.turnBeforeTruncated = false
    ledger.turnProvisional = false
    this.warn(`per-turn view disabled: ${reason}`)
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
      // "a file appeared" rows — and of the per-turn delta that must include
      // them (see `correctTurn`).
      await this.publish(ledger, true)
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
