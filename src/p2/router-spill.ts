/**
 * Transparent spill router: session-world-keyed delegation between the local
 * spill backend (private realm) and per-host remote spill dirs. Unknown
 * sessions stay local (system callers); tombstoned sessions fail closed and
 * the caller keeps its inline result.
 */
import { randomUUID } from 'node:crypto'
import { SpillStore, SpillLocator } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { RemoteWorlds, WorldRoute } from './worlds.ts'

/** Sanitize a suggested name to one safe segment (backend owns the rest). */
function safeName(suggested: string): string {
  const base = suggested.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64)
  return `${base === '' ? 'spill' : base}-${randomUUID().slice(0, 8)}.txt`
}

export default class TransparentSpillStore extends SpillStore {
  static inject = ['localSpillStore', 'remoteWorlds']

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
    const dir = `${home}/.dsh-helpers/spills/session-${input.owner.sessionId}`
    await this.remote.mkdirRemote(route.alias, dir)
    const name = safeName(input.suggestedName ?? 'spill.txt')
    const fullPath = `${dir}/${name}`
    const target = await fs.resolve(fullPath, {})
    await fs.writeText(target, input.content, { kind: 'createIfAbsent' }, undefined, this.policyFor(dir))
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
}
