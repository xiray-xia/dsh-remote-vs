/**
 * Transparent file-reference router: agent-world-keyed delegation between the
 * stock local implementation (private realm) and per-host remote search. The
 * stock row is prompt-complete (it installs the @ guidance section for every
 * agent it sees), so this router only routes list() and never touches prompts.
 *
 * Reads are soft (ctx.get): declaring downstream services in inject would
 * cycle startup (see the remote-vs inject comment). A missing workingDirectory
 * degrades to the local implementation (which fails its own way if the
 * composition is truly broken); tombstoned sessions throw fail-closed.
 */
import { FileReferenceService } from '@deepseek-ai/dsh-file-reference'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type { RemoteWorlds, WorldRoute } from './worlds.ts'
import { RemoteFileSearch } from './file-refs.ts'

/**
 * Tools that only read the tree, so their result cannot have changed it.
 *
 * Deliberately a list of exemptions rather than a list of writers: a tool this
 * build has never heard of keeps the stock behaviour and invalidates, which is
 * what makes the narrowing safe — a bare query can never answer from an index
 * that predates a possible change.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read', 'read_image', 'glob', 'grep',
  'remote_ls', 'remote_read',
])

/** Ceiling for in-flight call bookkeeping; a settled call releases its slot. */
const PENDING_CALL_CAP = 256

export default class TransparentFileReferences extends FileReferenceService {
  static inject = ['localFileReferences', 'remoteWorlds']

  /** Agent-scoped remote searchers (auto-released with their agents). */
  private readonly remoteSearches = new WeakMap<object, { routeId: string; search: RemoteFileSearch }>()
  /** `session + call id` -> tool name, for calls whose result is still to come. */
  private readonly pendingCalls = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx)
    // Mirror the stock invalidation: a tool result may have changed the tree, so
    // the next bare query rebuilds instead of answering from an older index.
    // The stock service re-reads local directories, where that costs nothing;
    // here one rebuild is a whole remote `rg --files` traversal (up to 50k
    // entries / 16 MiB), a single turn produces dozens of tool results, and the
    // caret asks for a rebuild after each of them. Read-only tools are therefore
    // exempted — the tree cannot have moved — and everything else invalidates
    // exactly as before. Scoped queries always read live either way.
    ctx.on('session/event', (session, event) => {
      try {
        if (event.type === 'tool/call') {
          this.rememberCall(session.id, event.data.callId, event.data.name)
          return
        }
        if (event.type !== 'tool/result') return
        if (this.isReadOnlyResult(session.id, event.data.message.toolCallId)) return
        const agent = ctx.get('agents')?.get(session.id)
        if (agent === undefined) return
        this.remoteSearches.get(agent)?.search.invalidate()
      } catch {
        // Invalidation must never break the session.
      }
    })
  }

  /**
   * Whether this result is positively known to come from a tree reader. A call
   * we never saw start, an unrecognized tool, or a payload that does not even
   * parse all answer "no": skipping the invalidation is only safe on proof, and
   * everything else must keep the guarantee that a bare query cannot answer
   * from an index older than the last possible change.
   */
  private isReadOnlyResult(sessionId: string, callId: string): boolean {
    try {
      const tool = this.takeCall(sessionId, callId)
      return tool !== undefined && READ_ONLY_TOOLS.has(tool)
    } catch {
      return false
    }
  }

  /**
   * Remember which tool a call id belongs to. Keyed by session as well, because
   * a call id is only unique within the session that issued it — two sessions
   * (an agent and its teammate) can otherwise cross-talk and mask a write.
   */
  private rememberCall(sessionId: string, callId: string, tool: string): void {
    if (this.pendingCalls.size >= PENDING_CALL_CAP) {
      const oldest = this.pendingCalls.keys().next().value
      if (oldest !== undefined) this.pendingCalls.delete(oldest)
    }
    this.pendingCalls.set(`${sessionId}\u0000${callId}`, tool)
  }

  /** Name of the tool whose result this is (consume it: results arrive once). */
  private takeCall(sessionId: string, callId: string): string | undefined {
    const key = `${sessionId}\u0000${callId}`
    const tool = this.pendingCalls.get(key)
    this.pendingCalls.delete(key)
    return tool
  }

  private get local(): FileReferenceService {
    return (this.ctx as unknown as { localFileReferences: FileReferenceService }).localFileReferences
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

  override async list(agent: Agent, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    const workingDirectory = this.ctx.get('workingDirectory')
    if (workingDirectory === undefined) return this.local.list(agent, query, signal)
    let cwd: string
    try {
      cwd = workingDirectory.get(agent.session)
    } catch {
      return this.local.list(agent, query, signal)
    }
    // Tombstoned cwd throws here (fail-closed dead sessions).
    const route = this.effective(this.remote.routeDir(cwd), `@refs @ ${cwd}`)
    if (route.kind === 'local') return this.local.list(agent, query, signal)
    const search = await this.searchFor(agent, route)
    return search.list(query, signal)
  }

  /** Per-agent remote searcher, rebuilt when the binding changes. */
  private async searchFor(
    agent: Agent,
    route: Extract<WorldRoute, { kind: 'remote' }>,
  ): Promise<RemoteFileSearch> {
    const cached = this.remoteSearches.get(agent)
    if (cached !== undefined && cached.routeId === route.id) return cached.search
    cached?.search.dispose()
    const runtime = this.remote.procFor(route.alias)
    const search = new RemoteFileSearch({
      fs: await this.remote.fsFor(route.alias),
      spawn: (spec) => runtime.spawn(spec),
      remoteRoot: route.remotePath,
      warn: (message: string) => {
        try {
          this.ctx.logger.warn(message)
        } catch {
          // Logging must never break completion.
        }
      },
    })
    this.remoteSearches.set(agent, { routeId: route.id, search })
    return search
  }
}
