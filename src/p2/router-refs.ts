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

export default class TransparentFileReferences extends FileReferenceService {
  static inject = ['localFileReferences', 'remoteWorlds']

  /** Agent-scoped remote searchers (auto-released with their agents). */
  private readonly remoteSearches = new WeakMap<object, { routeId: string; search: RemoteFileSearch }>()

  constructor(ctx: Context) {
    super(ctx)
    // Mirror the stock invalidation: any tool result may have changed the
    // tree, so the next bare query rebuilds. Scoped queries always read live.
    ctx.on('session/event', (session, event) => {
      try {
        if (event.type !== 'tool/result') return
        const agent = ctx.get('agents')?.get(session.id)
        if (agent === undefined) return
        this.remoteSearches.get(agent)?.search.invalidate()
      } catch {
        // Invalidation must never break the session.
      }
    })
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
