/**
 * Transparent spill router: session-world-keyed delegation between the local
 * spill backend (private realm) and per-host remote spill dirs. Unknown
 * sessions stay local (system callers); tombstoned sessions fail closed and
 * the caller keeps its inline result.
 *
 * Retention: the remote artifacts used to live forever (one file per oversized
 * tool result, under `$HOME/.dsh-helpers/spills/session-<id>/`). They now get a
 * TTL sweep once per host per process, plus a per-session check when the session
 * is disposed — both best-effort, both outside the write's critical path (see
 * `spill-retention.ts` for the commands and why they are safe to aim).
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SpillStore, SpillLocator } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { RemoteWorlds, WorldRoute } from './worlds.ts'
import { runBestEffort, sessionSpillDir, spillTtlDays } from './spill-retention.ts'

/** Ceiling on tracked sessions, so a long-lived Host cannot grow this map forever. */
const TRACKED_SESSIONS_CAP = 200

/** Sanitize a suggested name to one safe segment (backend owns the rest). */
function safeName(suggested: string): string {
  const base = suggested.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64)
  return `${base === '' ? 'spill' : base}-${randomUUID().slice(0, 8)}.txt`
}

/** One remote spill directory this process wrote, kept for the dispose prune. */
interface SpillDirRecord {
  alias: string
  dir: string
}

export default class TransparentSpillStore extends SpillStore {
  static inject = ['localSpillStore', 'remoteWorlds']

  /** Hosts already TTL-swept by THIS process (one `find` per host, not per spill). */
  private readonly sweptAliases = new Set<string>()
  /** session id -> directories written for it, for the best-effort dispose prune. */
  private readonly sessionDirs = new Map<string, SpillDirRecord[]>()

  constructor(ctx: Context) {
    super(ctx)
    /**
     * Session end is the one moment a spill directory is provably dead for the
     * session that wrote it. The check still requires the DIRECTORY to be older
     * than the TTL (`spillDirSweepCommand`), because `dsh-spill` states that a
     * forked session inherits its parent's locators without copying them — a
     * young directory may still be read by a live child.
     */
    ctx.on('session/disposed', (session) => {
      this.pruneSession(String(session.id))
    })
  }

  private get local(): SpillStore {
    return (this.ctx as unknown as { localSpillStore: SpillStore }).localSpillStore
  }

  private get remote(): RemoteWorlds {
    return (this.ctx as unknown as { remoteWorlds: RemoteWorlds }).remoteWorlds
  }

  private effective(route: WorldRoute, what: string): WorldRoute {
    const mode = this.remote.mode
    if (mode === 'off') return { kind: 'local' }
    if (mode === 'shadow') {
      this.remote.note(route, what)
      return { kind: 'local' }
    }
    return route
  }

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    const route = this.effective(this.remote.sessionWorld(input.owner.sessionId), `spill ${input.suggestedName ?? ''}`)
    if (route.kind === 'local') return this.local.saveText(input)
    // Remote backend: mirror local semantics (private dir, derived name).
    const fs = await this.remote.fsFor(route.alias)
    const home = await this.remote.homeFor(route.alias)
    // Retention is scheduled BEFORE the write and never blocks it (P2-N6: the
    // first spill per host used to await a remote `find` with a 20 s budget).
    // The per-host marker is set synchronously inside `sweepOnce`, so concurrent
    // first spills still issue exactly one sweep; a slow/failed sweep only warns.
    void this.sweepOnce(route.alias, home)
    const dir = sessionSpillDir(home, input.owner.sessionId)
    await this.remote.mkdirRemote(route.alias, dir)
    const name = safeName(input.suggestedName ?? 'spill.txt')
    const fullPath = `${dir}/${name}`
    const target = await fs.resolve(fullPath, {})
    await fs.writeText(target, input.content, { kind: 'createIfAbsent' }, undefined, this.policyFor(dir))
    this.remember(String(input.owner.sessionId), route.alias, dir)
    const bytes = Buffer.byteLength(input.content, 'utf8')
    return {
      locator: SpillLocator(`remote:${route.alias}:${fullPath}`),
      bytes,
      retrievalHint: `remote spill on ${route.alias} (${bytes} bytes); read ${fullPath} with the read tool in this session`,
    }
  }

  /** Explicit remote policy: mirrored mode, spill dir as the fence root. */
  private policyFor(dir: string): SandboxExecutionPolicy {
    let mode: SandboxMode = 'danger-full-access'
    try {
      // Soft read (router executes under caller shadow; never wait, never throw).
      const svc = this.ctx.get('sandboxPolicy') as { resolve?: () => { mode?: unknown } } | undefined
      const resolved = svc?.resolve?.()?.mode
      if (resolved === 'read-only' || resolved === 'workspace-write' || resolved === 'danger-full-access') {
        mode = resolved
      }
    } catch {
      // Fall through to the permissive default.
    }
    return { mode, workspaceRoot: dir }
  }

  /**
   * Sweep one host's spill root once per process.
   *
   * The marker is set BEFORE awaiting so two concurrent first spills on the same
   * host cannot both issue the sweep; a failed sweep still leaves the host marked
   * (retention is a nicety, retrying it on every spill would be a tax).
   */
  private async sweepOnce(alias: string, home: string): Promise<void> {
    if (this.sweptAliases.has(alias)) return
    this.sweptAliases.add(alias)
    await runBestEffort(
      `ttl sweep on ${alias}`,
      () => this.remote.sweepSpillRoot(alias, home, spillTtlDays()),
      message => this.warn(message),
    )
  }

  /** Remember one written directory for the dispose prune (bounded, oldest first). */
  private remember(sessionId: string, alias: string, dir: string): void {
    const existing = this.sessionDirs.get(sessionId)
    if (existing === undefined) {
      if (this.sessionDirs.size >= TRACKED_SESSIONS_CAP) {
        const oldest = this.sessionDirs.keys().next().value
        if (oldest !== undefined) this.sessionDirs.delete(oldest)
      }
      this.sessionDirs.set(sessionId, [{ alias, dir }])
      return
    }
    if (!existing.some(record => record.alias === alias && record.dir === dir)) existing.push({ alias, dir })
  }

  /** Best-effort TTL check for the directories one session wrote. Never throws. */
  private pruneSession(sessionId: string): void {
    const records = this.sessionDirs.get(sessionId)
    if (records === undefined) return
    this.sessionDirs.delete(sessionId)
    for (const record of records) {
      void runBestEffort(
        `session prune of ${record.dir}`,
        () => this.remote.sweepSpillDir(record.alias, record.dir, spillTtlDays()),
        message => this.warn(message),
      )
    }
  }

  private warn(message: string): void {
    try {
      this.ctx.logger.warn(`[remote-vs] ${message}`)
    } catch {
      // Logging must never break a spill.
    }
  }
}
