/**
 * Per-session change ledger for remote workspaces.
 *
 * DSH already records "what did this turn change" — but only for local
 * sessions: `@deepseek-ai/dsh-workspace-changes` parses git's POSIX output with
 * host path semantics and stages its scratch index through `node:fs`, so on a
 * routed session the first baseline snapshot fails and the recorder returns
 * before appending anything (measured: 58 remote-bound sessions, 390 fs
 * writes, zero `workspace/changes` events). This class is the same idea
 * re-expressed for a remote host: a session baseline tree, a current tree, and
 * `git diff <tree> <tree>` in between.
 *
 * Two deliberate differences from the upstream recorder:
 *
 * - **Session baseline, not turn baseline.** The panel answers "what did this
 *   session touch", so it compares the first snapshot of the session with the
 *   latest one. A per-turn comparison is still available as `turn`.
 * - **Never on the turn's critical path.** Snapshots are queued in the
 *   background: a 40s `git add --all` on a monorepo must not delay a reply, and
 *   the panel already renders a "pending" state while one runs.
 */

import type { RemoteChangesDiff, RemoteChangedFile, RemoteChangesSummary, RemoteTimeouts } from '../protocol.ts'
import type { RemotePool } from '../pool.ts'
import type { RemoteWorlds, WorldRoute } from '../p2/worlds.ts'
import { parseUnifiedDiff } from '../git-ops.ts'
import {
  SNAPSHOT_EXIT,
  fileDiffCommand,
  headTreeCommand,
  parseNameStatus,
  parseNumstat,
  parseTreeId,
  snapshotCommand,
  splitDiffSections,
  treeDiffCommand,
} from './snapshot.ts'

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
  /** Cap on one file's git output, in bytes. */
  maxDiffBytes?: number
}

/** One session's bookkeeping. */
interface Ledger {
  sessionId: string
  alias: string
  root: string
  scratch: string
  /** Tree of the session's first snapshot (the comparison baseline). */
  baseTree?: string
  /** Tree of the latest snapshot. */
  lastTree?: string
  turn: number
  files: RemoteChangedFile[]
  added: number
  deleted: number
  truncated: true | undefined
  at: number
  unavailable: string | undefined
  pending: boolean
  /** Serialized background work; a second schedule coalesces into one run. */
  queue: Promise<void>
  /** A run was requested while one was queued/running. */
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

/** Trailing-slash-free absolute POSIX dir. */
function posixDir(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.replace(/\/+$/, '') : path
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
    // The baseline is only meaningful once per session; a failed attempt leaves
    // `baseTree` unset and the next turn retries (a host may be briefly down).
    if (ledger.baseTree === undefined) this.schedule(ledger)
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
      pending: ledger.pending,
      ...(ledger.truncated === true ? { truncated: true as const } : {}),
      ...(ledger.unavailable === undefined ? {} : { unavailable: ledger.unavailable }),
    }
  }

  /**
   * Compare one listed file across the whole session.
   *
   * @param sessionId - live session owning the ledger.
   * @param path - the file's remote absolute path (as listed in the summary).
   * @returns hunks for decorations, or null when the session/file is unknown.
   */
  async diff(sessionId: string, path: string): Promise<RemoteChangesDiff | null> {
    const ledger = this.ledgers.get(sessionId)
    if (ledger === undefined) return null
    const listed = ledger.files.find(file => file.path === path)
    if (listed === undefined) return null
    const base = ledger.baseTree
    const last = ledger.lastTree
    if (base === undefined || last === undefined) return null
    const status = listed.status
    if (listed.binary === true) {
      return { kind: 'binary', path, display: listed.display, hunks: [], ...(status === undefined ? {} : { status }) }
    }
    const result = await this.run(ledger.alias, fileDiffCommand(ledger.root, ledger.scratch, base, last, listed.display))
    if (!result.ok) return null
    const capped = this.capBytes(result.stdout)
    const files = parseUnifiedDiff(capped.text)
    const block = files.find(file => file.path === listed.display || file.path === path) ?? files[0]
    if (block === undefined) return { kind: 'missing', path, display: listed.display, hunks: [], ...(status === undefined ? {} : { status }) }
    return {
      kind: 'text',
      path,
      display: listed.display,
      hunks: block.hunks,
      ...(status === undefined ? {} : { status }),
      ...(capped.truncated ? { truncated: true as const } : {}),
    }
  }

  /**
   * Resolve once every queued refresh has settled, including work that was
   * coalesced while one was running.
   *
   * The turn boundaries only ever queue background work, so this is what a test
   * (or a shutdown path that wants quiescence) waits on.
   */
  async settled(): Promise<void> {
    for (let guard = 0; guard < 100; guard += 1) {
      await Promise.all([...this.ledgers.values()].map(ledger => ledger.queue))
      if (![...this.ledgers.values()].some(ledger => ledger.pending)) return
    }
  }

  /** Drop one session's ledger and its remote scratch directory. */
  forget(sessionId: string): void {    const ledger = this.ledgers.get(sessionId)
    if (ledger === undefined) return
    this.ledgers.delete(sessionId)
    ledger.disposed = true
    void this.deps.pool
      .exec(ledger.alias, `rm -rf ${quote(ledger.scratch)} 2>/dev/null || true`, { timeoutMs: 10_000 })
      .catch(() => undefined)
  }

  /** Release every ledger (plugin unmount). */
  dispose(): void {
    this.disposed = true
    for (const sessionId of [...this.ledgers.keys()]) this.forget(sessionId)
  }

  // ------------------------------------------------------------- internals

  /** Resolve the routing target once per session, caching the ledger. */
  private ensure(target: LedgerTarget): Ledger | undefined {
    if (target.cwd.trim() === '') return undefined
    const existing = this.ledgers.get(target.sessionId)
    if (existing !== undefined && !existing.disposed) {
      if (existing.root !== '' && existing.alias !== '') return existing
      this.ledgers.delete(target.sessionId)
    }
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
    const root = posixDir(route.remotePath)
    const scratch = `/tmp/dsh-rvsnap-${target.sessionId.replace(/[^A-Za-z0-9]/g, '').slice(-12)}`
    const ledger: Ledger = {
      sessionId: target.sessionId,
      alias: route.alias,
      root,
      scratch,
      turn: 0,
      files: [],
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

  /** Take the snapshots this ledger needs and recompute the file list. */
  private async refresh(ledger: Ledger): Promise<void> {
    if (ledger.disposed || ledger.root === '' || ledger.alias === '') return
    const budget = this.execBudget()
    // 1. Baseline: the session's first tree. Degrades to HEAD so a repository
    // whose working tree was already dirty still shows *something* useful, and
    // only then reports "unavailable".
    if (ledger.baseTree === undefined) {
      const baseline = await this.snapshot(ledger, budget)
      if (baseline.ok) {
        // First observation of the session: the baseline IS the current state,
        // so there is nothing to compare yet. Taking a second snapshot right
        // after the first would double the first turn's round trips and could
        // only ever report "no changes".
        ledger.baseTree = baseline.tree
        ledger.lastTree = baseline.tree
        ledger.files = []
        ledger.added = 0
        ledger.deleted = 0
        ledger.truncated = undefined
        ledger.at = Date.now()
        return
      }
      const head = await this.treeOfHead(ledger, budget)
      if (head === undefined) {
        ledger.unavailable = baseline.reason
        return
      }
      ledger.baseTree = head
      this.warn(`baseline snapshot failed (${baseline.reason}); comparing against HEAD instead`)
    }
    // 2. Current tree.
    const current = await this.snapshot(ledger, budget)
    if (ledger.disposed) return
    if (!current.ok) {
      ledger.unavailable = current.reason
      return
    }
    ledger.lastTree = current.tree
    ledger.unavailable = undefined
    if (ledger.baseTree === current.tree) {
      ledger.files = []
      ledger.added = 0
      ledger.deleted = 0
      ledger.truncated = undefined
      ledger.at = Date.now()
      return
    }
    // 3. What changed between the two trees.
    const listed = await this.run(ledger.alias, treeDiffCommand(ledger.root, ledger.scratch, ledger.baseTree, current.tree))
    if (!listed.ok) {
      ledger.unavailable = listed.reason
      return
    }
    this.applyListing(ledger, listed.stdout)
  }

  /** Convert one numstat/name-status reply into the ledger's file list. */
  private applyListing(ledger: Ledger, stdout: string): void {
    const sections = splitDiffSections(stdout)
    const rows = parseNumstat(sections.numstat)
    const statuses = parseNameStatus(sections.nameStatus)
    const files: RemoteChangedFile[] = []
    let added = 0
    let deleted = 0
    for (const row of rows) {
      added += row.added
      deleted += row.deleted
      const status = statuses.get(row.path)
      files.push({
        path: posixJoin(ledger.root, row.path),
        display: row.path,
        added: row.added,
        deleted: row.deleted,
        ...(row.binary ? { binary: true as const } : {}),
        ...(status === undefined ? {} : { status }),
      })
    }
    files.sort((left, right) => left.display.localeCompare(right.display))
    const cap = this.deps.maxFiles ?? 500
    ledger.files = files.length > cap ? files.slice(0, cap) : files
    ledger.truncated = files.length > cap ? true : undefined
    ledger.added = added
    ledger.deleted = deleted
    ledger.at = Date.now()
  }

  /** Take one snapshot, mapping the script's exit codes to a reason. */
  private async snapshot(ledger: Ledger, budget: number): Promise<{ ok: true; tree: string } | { ok: false; reason: string }> {
    const result = await this.run(ledger.alias, snapshotCommand(ledger.root, ledger.scratch), budget)
    if (!result.ok) return { ok: false, reason: result.reason }
    const tree = parseTreeId(result.stdout)
    if (tree === undefined) return { ok: false, reason: `snapshot produced no tree id${result.stderr === '' ? '' : ` (${firstLine(result.stderr)})`}` }
    return { ok: true, tree }
  }

  /** `HEAD^{tree}`, the degraded baseline for a repository with no snapshot yet. */
  private async treeOfHead(ledger: Ledger, budget: number): Promise<string | undefined> {
    const result = await this.run(ledger.alias, headTreeCommand(ledger.root), budget)
    if (!result.ok) return undefined
    return parseTreeId(result.stdout)
  }

  /** Run one command on the host, normalizing failure into a reason string. */
  private async run(alias: string, command: string, budget = this.execBudget()): Promise<
    { ok: true; stdout: string; stderr: string } | { ok: false; reason: string; stderr: string }
  > {
    try {
      const result = await this.deps.pool.exec(alias, command, { timeoutMs: budget })
      const stdout = typeof result.stdout === 'string' ? result.stdout : ''
      const stderr = typeof result.stderr === 'string' ? result.stderr : ''
      if (result.success) return { ok: true, stdout, stderr }
      return { ok: false, reason: this.reasonOf(result.exitCode, stderr), stderr }
    } catch (error) {
      return { ok: false, reason: `host unreachable: ${messageOf(error)}`, stderr: '' }
    }
  }

  /** Turn a failed snapshot exit code into something a user can act on. */
  private reasonOf(exitCode: number | null | undefined, stderr: string): string {
    switch (exitCode) {
      case SNAPSHOT_EXIT.noRoot:
        return 'session directory is missing on the host'
      case SNAPSHOT_EXIT.noScratch:
        return 'cannot create the snapshot directory under /tmp'
      case SNAPSHOT_EXIT.noRepo:
        return 'not a git repository (change tracking needs git)'
      case SNAPSHOT_EXIT.noTree:
        return 'git write-tree failed'
      case SNAPSHOT_EXIT.addFailed:
        // The dominant cause on a monorepo: `git add --all` outran the budget.
        return `snapshot failed or timed out${stderr === '' ? '' : ` (${firstLine(stderr)})`}`
      default:
        return exitCode === null || exitCode === undefined
          ? 'snapshot did not finish (timeout or connection loss)'
          : `snapshot failed (exit ${exitCode})${stderr === '' ? '' : ` (${firstLine(stderr)})`}`
    }
  }

  /** One exec's budget: the git setting, clamped so a hung host cannot pile up jobs. */
  private execBudget(): number {
    let configured = 30_000
    try {
      configured = this.deps.timeouts().gitMs
    } catch {
      // Keep the default.
    }
    if (!Number.isFinite(configured) || configured <= 0) configured = 30_000
    return Math.max(5_000, Math.min(configured, 120_000))
  }

  private capBytes(text: string): { text: string; truncated: boolean } {
    const cap = this.deps.maxDiffBytes ?? 2 * 1024 * 1024
    if (Buffer.byteLength(text, 'utf8') <= cap) return { text, truncated: false }
    return { text: text.slice(0, cap), truncated: true }
  }

  private warn(message: string): void {
    try {
      this.deps.log?.('warn', message)
    } catch {
      // Logging must never break a turn.
    }
  }
}

/** POSIX single-quote for the cleanup command. */
function quote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`
}

function firstLine(text: string): string {
  const line = text.split('\n').find(candidate => candidate.trim() !== '') ?? ''
  return line.trim().slice(0, 160)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
