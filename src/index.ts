/**
 * dsh-remote-vs — host half. Mounts the remote store ($DSH_HOME/dsh-remote.json),
 * the ssh2 connection pool, the /api/dsh-remote route family plus the terminal
 * WebSocket upgrade, the agent tools (remote_hosts, remote_exec, remote_ls,
 * remote_read, remote_write), an optional system-prompt announcement, a
 * per-session remote workspace-mapping context, and the P2
 * transparent-routing world manager (remoteWorlds service + kill-switch).
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { RemoteStore } from './store.ts'
import type { RemoteTimeouts } from './protocol.ts'
import { RemotePool } from './pool.ts'
import { ForwardManager } from './forward.ts'
import { seedHelperCache } from './deploy.ts'
import { makeRoutes } from './routes.ts'
import {
  DEFAULT_GIT_TIMEOUT_MS,
  DEFAULT_READ_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  resolveTimeouts,
} from './timeouts.ts'
import { RemoteWorlds, TombstonedError, type RoutingMode, type WorldRoute } from './p2/worlds.ts'
import {
  REMOTE_PRESET_ID,
  decidePresetSwitch,
  runPresetSwitchAttempts,
  type PresetSwitchAttempt,
  type PresetSwitchFacts,
} from './preset-switch.ts'
import { SessionChanges } from './changes/recorder.ts'
import {
  remoteExecTool,
  remoteHostsTool,
  remoteLsTool,
  remoteReadTool,
  remoteWriteTool,
} from './tools.ts'

/** Stable cordis plugin name. */
export const name = 'remote-vs'

/**
 * Services required before the remote surfaces can mount. MINIMAL ON PURPOSE
 * (2026-10-13 deadlock lesson): our routers REPLACE fs/subprocess/spillStore
 * at root, so anything downstream of them (workingDirectory, agents, …)
 * transitively waits on us — declaring them here cycles the whole Host
 * (remote-vs → workingDirectory → fs-router → remoteWorlds → remote-vs).
 * Every other service is read SOFT via ctx.get() at call time (the
 * tool-bash pattern: no startup wait, no throw, undefined when absent).
 */
export const inject = ['webServer', 'tools', 'systemPrompt']

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Volatile config values were committed into the running instance without a
     * remount (cordis-plugin-loader); dispatched to the owning fiber only.
     */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

/** Plugin config as a profile patch declares it, before schema resolution. */
export interface Config {
  /** Announce the remote tools to every agent (default false, keeps prompts clean). */
  announceToAgent?: boolean
  /** Master switch for the plugin (routes, tools, prompt section). */
  enabled?: boolean
  /**
   * P2 transparent-routing kill-switch: off = pure local passthrough;
   * shadow = log remote decisions but execute locally; enforce = route.
   *
   * The DEFAULT is `enforce`: the plugin exists to execute remote workspaces
   * remotely, and a fresh profile that silently kept executing locally was the
   * most common "why is nothing remote" report. `off`/`shadow` stay available as
   * explicit opt-outs for debugging and for hosts that must stay local.
   */
  routingMode?: RoutingMode
  /** Per-command timeout for git work on a remote host (ms). */
  gitTimeoutMs?: number
  /** Per-read timeout for remote file reads (ms). */
  readTimeoutMs?: number
}

/** The stable reference a `volatile()` config field resolves to. */
interface ConfigRef<T> {
  get(): T
}

type ConfigField<T> = ConfigRef<T> | T

/** The config the Host hands to {@link apply}. */
export interface ResolvedConfig {
  announceToAgent?: ConfigField<boolean>
  enabled?: ConfigField<boolean>
  routingMode?: ConfigField<RoutingMode>
  gitTimeoutMs?: ConfigField<number>
  readTimeoutMs?: ConfigField<number>
}

/**
 * Plugin config schema. Under the 0.1.7 settings model this schema IS the
 * entry's settings page; every field is `volatile()` so edits reach the
 * running instance without a remount.
 *
 * The two timeout fields exist because "large project" is host-specific: a cold
 * `git status` on a big monorepo outlived the old fixed 45 s client deadline,
 * so the limit is a setting rather than a constant. Both are clamped into
 * [MIN_TIMEOUT_MS, MAX_TIMEOUT_MS] (see `timeouts.ts`) on every read, so a bad
 * value degrades to the default instead of disabling the explorer.
 */
export const Config = z.object({
  announceToAgent: z.boolean().default(false).volatile(),
  enabled: z.boolean().default(true).volatile(),
  routingMode: z.union(['off', 'shadow', 'enforce'] as const).default('enforce').volatile(),
  gitTimeoutMs: z.number().step(1).min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS)
    .default(DEFAULT_GIT_TIMEOUT_MS).volatile(),
  readTimeoutMs: z.number().step(1).min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS)
    .default(DEFAULT_READ_TIMEOUT_MS).volatile(),
})

function readField<T>(field: ConfigField<T> | undefined, fallback: T): T {
  if (field === undefined) return fallback
  if (typeof field === 'object' && field !== null && typeof (field as ConfigRef<T>).get === 'function') {
    const value = (field as ConfigRef<T>).get()
    return value === undefined ? fallback : value
  }
  return field as T
}

const TOOL_NAMES = ['remote_hosts', 'remote_exec', 'remote_ls', 'remote_read', 'remote_write'] as const

const GUIDANCE = '本机已安装 dsh-remote-vs 插件（DSH 远程开发）：侧边栏「远程」tab 管理 SSH 主机与远端工作区。能力：主机配置存 $DSH_HOME/dsh-remote.json（证书/密码，与 dsh-ssh.json 独立）；remote_hosts 列出主机、remote_exec 执行远程命令、remote_ls/remote_read/remote_write 经 SFTP 读写远端文件；推送流水线做版本比对后推送 helper 可执行文件；Remote 预设提供远端 bash 工具集。限制：主机必须先在 GUI 里配好，agent 不可建主机；密码明文存于 0600 私有文件；远端输出原样返回，可能含敏感信息；只支持直连主机（跳板机/代理命令未排期）。'

/**
 * Per-session remote mapping block (dynamic runtime context provider).
 * Remote sessions under enforce get their alias→host→root mapping next to
 * the cwd block; everything else (local route, off/shadow mode, tombstoned
 * binding, missing host entry details) answers '' — empty text contributes
 * nothing, so local sessions stay noise-free.
 *
 * Evaluated at every assembly: sync memory reads only (mode flag, route
 * table scan, store maps — no I/O, no RPC), and it must never throw (an
 * assembly provider throwing fails the model step — callers wrap in
 * try/catch and treat any error as '').
 */
function workspaceMappingText(worlds: RemoteWorlds, store: RemoteStore, cwd: string): string {
  if (worlds.mode !== 'enforce') return ''
  let route: WorldRoute
  try {
    route = worlds.routeDir(cwd)
  } catch {
    return ''
  }
  if (route.kind !== 'remote') return ''
  const entry = store.get(route.alias)
  const host = entry !== undefined
    ? `${route.alias} (${entry.user}@${entry.host}:${entry.port})`
    : `${route.alias} (host entry missing)`
  return [
    `Remote workspace (transparent execution ON): session cwd ${route.aliasPath} is an empty local alias; tools resolve here:`,
    `- host: ${host}`,
    `- remote root: ${route.remotePath}`,
    'Relative paths and POSIX absolutes run on the remote host; the alias dir holds no real files.',
    // Clickable file references resolve against the workspace root, so a path
    // quoted relative to the model's CURRENT directory misses by whatever
    // segment the session cd'ed into (2026-10-19 user report: final-answer file
    // chips 404'd one directory away).
    '- File paths in your reply: use the remote absolute path (e.g. /home/...) or a path relative to the remote root above — never a path relative to your current directory; a click resolves against the remote root.',
  ].join('\n')
}

export function apply(ctx: Context, config?: ResolvedConfig): void {
  const store = new RemoteStore()
  const pool = new RemotePool(store)
  const worlds = new RemoteWorlds(ctx, {
    store,
    pool,
    // Keep the runtime fallback equal to the schema default: a Host that hands
    // the plugin a config object without this field must behave like a fresh
    // profile, not like the old opt-in (`off`) behaviour.
    mode: () => readField(config?.routingMode, 'enforce' as RoutingMode),
  })
  ctx.provide('remoteWorlds', worlds)
  ctx.effect(() => () => { pool.dispose() }, 'dsh-remote-vs: pool')
  ctx.effect(() => () => {
    void worlds.dispose().catch(() => undefined)
  }, 'dsh-remote-vs: worlds')
  // Materialize alias dirs + native registry entries (fire-and-forget).
  void worlds.syncWorkspaces().catch((error: unknown) => {
    try {
      ctx.logger.warn(`[remote-vs] workspace sync failed: ${error instanceof Error ? error.message : String(error)}`)
    } catch {
      // Ignore.
    }
  })
  // Seed the helper cache from vendored copies (fresh installs can push
  // without manual staging; copy-if-absent, never overwrites).
  try {
    const seed = seedHelperCache()
    if (!seed.vendorMissing && (seed.seeded.length > 0 || seed.failed.length > 0)) {
      try {
        ctx.logger.info(`[remote-vs] helper cache seeded: ${seed.seeded.length} copied, ${seed.skipped.length} kept${seed.failed.length > 0 ? `, FAILED: ${seed.failed.join(', ')}` : ''}`)
      } catch {
        // Ignore.
      }
    }
  } catch {
    // Best-effort only.
  }
  // Per-session remote mapping (dynamic runtime context, global provider —
  // the working-directory:current pattern): sits right under the cwd block
  // (100), required like it (the pair must survive runtime-context opt-out
  // together), literal text. The provider filters by agent at assembly;
  // local sessions see nothing. Deliberately NOT gated by announceToAgent
  // (that flag is plugin advertisement; the mapping is operational).
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'remote-vs:workspace-mapping',
    order: 105,
    required: true,
    interpolate: false,
    text: (context) => {
      try {
        const session = context.agent?.session
        if (session === undefined) return ''
        const workingDirectory = ctx.get('workingDirectory')
        if (workingDirectory === undefined) return ''
        let cwd: string
        try {
          cwd = workingDirectory.get(session)
        } catch {
          return ''
        }
        return workspaceMappingText(worlds, store, cwd)
      } catch {
        return ''
      }
    },
  }), 'dsh-remote-vs: workspace mapping')

  const resolve = (): { announceToAgent: boolean; enabled: boolean } => ({
    announceToAgent: readField(config?.announceToAgent, false),
    enabled: readField(config?.enabled, true),
  })

  // Read on every request, never captured: a `volatile()` edit must change the
  // timeouts of the running instance without a remount (same contract as the
  // routing mode). Clamped inside `resolveTimeouts`, so an out-of-range value
  // from a hand-edited patch cannot disable the explorer.
  const resolveTimeoutsNow = (): RemoteTimeouts => resolveTimeouts({
    gitTimeoutMs: readField(config?.gitTimeoutMs, DEFAULT_GIT_TIMEOUT_MS),
    readTimeoutMs: readField(config?.readTimeoutMs, DEFAULT_READ_TIMEOUT_MS),
  })

  // Session change ledger (the Cursor-style review panel). Fed from turn
  // boundaries, never from the request path: the git scans it runs cost
  // milliseconds in a small repository and over a minute in a monorepo, and a
  // turn must never wait for them. `cwd` is resolved here because the recorder
  // deliberately knows nothing about cordis.
  /**
   * Which sessions get a ledger.
   *
   * Subagent sessions are skipped on purpose, the same policy DSH's own
   * recorder uses: a delegated session writes into the same workspace, so its
   * files show up in the parent session's diff anyway, while recording it
   * separately would run the scans once per subagent turn (a Team run fans out,
   * and the scan is the expensive part).
   */
  const ledgerTarget = (session: {
    id: string
    header?: { cwd?: string; origin?: string; delegationDepth?: number }
  }): { sessionId: string; cwd: string } | undefined => {
    const header = session.header
    if (header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0) return undefined
    let cwd = header?.cwd ?? ''
    try {
      const workingDirectory = ctx.get('workingDirectory') as { get?: (session: unknown) => unknown } | undefined
      const current = workingDirectory?.get?.(session)
      if (typeof current === 'string' && current !== '') cwd = current
    } catch {
      // Soft read: the header cwd is the fallback.
    }
    return cwd === '' ? undefined : { sessionId: session.id, cwd }
  }
  const changes = new SessionChanges({
    pool,
    worlds,
    timeouts: resolveTimeoutsNow,
    log: (level, message) => {
      try {
        if (level === 'warn') ctx.logger.warn(`[remote-vs] changes: ${message}`)
        else ctx.logger.info(`[remote-vs] changes: ${message}`)
      } catch {
        // Logging must never break a turn.
      }
    },
  })
  ctx.on('session/event', (session, event) => {
    try {
      if (event.type !== 'turn/start' && event.type !== 'turn/end') return
      const target = ledgerTarget(session)
      if (target === undefined) return
      if (event.type === 'turn/start') changes.beginTurn(target)
      else changes.endTurn(target, event.data.turn)
    } catch {
      // Recording must never disturb the turn that is being recorded.
    }
  })
  ctx.on('session/disposed', (session) => { changes.forget(session.id) })
  // A second guarantee that a turn gets recorded. This fires as the turn is
  // about to close, so a `turn/end` this Host never delivered cannot leave the
  // panel showing the previous turn's list; the panel's poll self-heals on top
  // of that (see `SessionChanges.touch`).
  ctx.on('agent/turn-stopping', (payload) => {
    try {
      const target = ledgerTarget(payload.agent.session)
      if (target !== undefined) changes.endTurn(target, payload.turn)
    } catch {
      // Same rule as above: never disturb the turn being recorded.
    }
  })
  ctx.effect(() => () => { changes.dispose() }, 'dsh-remote-vs: changes ledger')

  /**
   * Local port forwards (`ssh -L`) — resident listeners with their own
   * lifecycle, on purpose.
   *
   * A forward's listener must survive `sync()` erasing and re-registering the
   * route table (a settings edit must not kill a tunnel), so the manager is not
   * created inside `makeRoutes`; the routes only see its CRUD face. Its effect
   * is registered BEFORE the routes effect, so unload closes routes first, then
   * the forwards (their channels still need a live pool), and the pool last.
   */
  const forwards = new ForwardManager({
    pool,
    log: (level, message) => {
      try {
        if (level === 'warn') ctx.logger.warn(`[remote-vs] forwards: ${message}`)
        else ctx.logger.info(`[remote-vs] forwards: ${message}`)
      } catch {
        // Logging must never break a forward.
      }
    },
  })

  const { routes, upgrade, terminalSessions } = makeRoutes({
    store,
    pool,
    worlds,
    ctx,
    timeouts: resolveTimeoutsNow,
    changes,
    forwards,
  })

  /**
   * PTY sessions own their own lifetime, separate from route registration.
   *
   * `sync()` rebuilds the route/tool registrations whenever a volatile config
   * value changes (`loader/volatile-update` fires for every settings edit), and a
   * cleanup that also closed terminals made "change one setting" kill every live
   * remote shell. So the registry gets a fiber-scoped effect of its own: it is
   * disposed exactly once — when the plugin is actually unloaded — and never by
   * the route re-registration in `sync()`.
   *
   * Cleanup order is load-bearing: this effect is registered AFTER the pool
   * effect but BEFORE the routes effect created in `sync()`, and cordis starts a
   * fiber's effect cleanups in reverse registration order (these cleanups are
   * synchronous) — so on unload the routes are unregistered first (no new shell
   * can be opened), then the terminals close (a channel close still has a live
   * pool), and the pool is disposed last.
   */
  ctx.effect(() => () => { terminalSessions.dispose() }, 'dsh-remote-vs: terminal sessions')

  /**
   * Forwards close after routes (no new local connection can arrive once the
   * route table is gone) and BEFORE the pool is disposed (a channel close still
   * needs a live connection). Registered before `sync()` creates the routes
   * effect, so the reverse-order cleanup above holds.
   */
  ctx.effect(() => () => { forwards.dispose() }, 'dsh-remote-vs: port forwards')

  let disposeRoutes: (() => void) | undefined

  const tools = [
    remoteHostsTool({ store, pool }),
    remoteExecTool({ store, pool }),
    remoteLsTool({ store, pool }),
    remoteReadTool({ store, pool }),
    remoteWriteTool({ store, pool }),
  ]
  let disposeTools: (() => void) | undefined
  let disposeSection: (() => void) | undefined

  const sync = (): void => {
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (disposeRoutes !== undefined) {
      disposeRoutes()
      disposeRoutes = undefined
    }
    if (disposeTools !== undefined) {
      disposeTools()
      disposeTools = undefined
    }
    const value = resolve()
    if (!value.enabled) {
      // Turning the plugin off must release the local ports too: with the
      // routes gone there is no panel left to stop a tunnel, and a listener
      // nobody can reach would keep its 127.0.0.1 port bound until restart.
      // `stopAll` (not `dispose`) keeps the manager reusable when re-enabled.
      forwards.stopAll()
      return
    }
    if (value.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-remote-vs',
        order: 60,
        text: () => {
          const names = TOOL_NAMES.filter(n => ctx.tools.get(n) !== undefined)
          if (names.length === 0) return ''
          return GUIDANCE
        },
      })
    }
    disposeRoutes = ctx.effect(
      () => {
        const disposers = routes.map(route => ctx.webServer.register(route))
        const upgradeDisposer = ctx.webServer.registerUpgrade(upgrade)
        // Route registration only: live PTY sessions are disposed by their own
        // effect (see above), so a volatile config edit cannot kill them.
        return () => {
          for (const dispose of disposers) dispose()
          upgradeDisposer()
        }
      },
      'dsh-remote-vs: routes',
    )
    disposeTools = ctx.effect(
      () => {
        const disposers = tools.map(tool => ctx.tools.register(tool))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-remote-vs: tools',
    )
  }

  ctx.on('loader/volatile-update', () => { sync() })
  /**
   * Preset auto-switch for a new session born in a remote workspace (Phase 4b).
   *
   * 2026-11-10, bug "sometimes no Remote preset ~3 s after creating a session":
   *
   * - The Web client does not always MINT a session. `createInWorkspace` reuses
   *   the first listed BLANK session of the workspace by passing its id, and the
   *   Host answers that through `agents.resume` → `agent/created` with source
   *   `'resume'`. The old `source !== 'startup'` guard silently skipped exactly
   *   those sessions. Blankness (no turn started) is the precondition the preset
   *   registry itself enforces, so it is what we check now — a resumed session
   *   with history is excluded by it.
   * - One 2.5 s shot also lost every transient state: the preset may not be
   *   composed yet, the working directory may be unreadable, or the workspace
   *   binding may not be listed. `runPresetSwitchAttempts` retries those for a
   *   bounded time and stops on terminal reasons (routing off, history, user's
   *   own preset, local directory).
   *
   * The listener still DETACHES: it returns immediately, so session creation
   * never waits for a switch (the original 2026-10-13 race: selecting during
   * creation while both preset trees register tools could kill the session).
   * Failure modes are logged, never thrown; manual selection stays the fallback.
   */
  const attemptPresetSwitch = async (agent: Agent): Promise<PresetSwitchAttempt> => {
    const presets = ctx.get('agentPresets')
    const agents = ctx.get('agents') as
      | { turnBoundaryOf?: (session: unknown) => { openTurnStartSeq: number | null; lastTurn: number } | undefined }
      | undefined
    const workingDirectory = ctx.get('workingDirectory') as
      | { get?: (session: unknown) => unknown }
      | undefined
    let boundary: { openTurnStartSeq: number | null; lastTurn: number } | undefined
    try {
      boundary = agents?.turnBoundaryOf?.(agent.session)
    } catch {
      boundary = undefined
    }
    let cwd = ''
    try {
      const current = workingDirectory?.get?.(agent.session)
      if (typeof current === 'string') cwd = current
    } catch {
      // Soft read: an unbound session stays unreadable and retries.
    }
    let remote: boolean | undefined
    let tombstoned = false
    if (cwd !== '') {
      try {
        remote = worlds.routeDir(cwd).kind === 'remote'
      } catch (error) {
        if (error instanceof TombstonedError) tombstoned = true
      }
    }
    // Service reads can throw during (re)mount; a throw is transient, so the
    // facts fall back to "not composed yet" and the loop retries instead of
    // losing the one chance (2026-11-10: that silent loss was the bug).
    let currentPreset: string | undefined
    let defaultPreset: string | undefined
    try {
      currentPreset = presets?.composedPreset(agent.ctx)
      defaultPreset = presets?.defaultId
    } catch {
      currentPreset = undefined
      defaultPreset = undefined
    }
    const facts: PresetSwitchFacts = {
      mode: worlds.mode,
      hasPresets: presets !== undefined,
      blank: boundary !== undefined && boundary.openTurnStartSeq === null && boundary.lastTurn === 0,
      cwd,
      remote,
      tombstoned,
      currentPreset,
      defaultPreset,
    }
    const step = decidePresetSwitch(facts)
    if (step.action !== 'switch') return { step, facts }
    if (presets === undefined) return { step: { action: 'stop', reason: 'presets-absent' }, facts }
    try {
      await presets.select(agent, REMOTE_PRESET_ID)
      return { step: { action: 'stop', reason: 'switched' }, facts }
    } catch (error) {
      // agent-preset/locked = the user already started a turn: respect it.
      const locked = error instanceof Error && /locked|already started/i.test(error.message)
      return { step: { action: locked ? 'stop' : 'retry', reason: locked ? 'locked' : 'select-failed' }, facts }
    }
  }
  ctx.on('agent/created', (payload) => {
    void (async () => {
      try {
        const { step, facts, attempts } = await runPresetSwitchAttempts(() => attemptPresetSwitch(payload.agent))
        try {
          if (step.reason === 'switched' && facts?.remote === true) {
            ctx.logger.info(`[remote-vs] remote session ${facts.cwd}: preset switched to ${REMOTE_PRESET_ID} after ${attempts} attempt(s)`)
          } else if (step.action === 'retry') {
            ctx.logger.warn(`[remote-vs] preset auto-switch gave up after ${attempts} attempt(s): ${step.reason}`)
          } else if (facts?.remote === true) {
            ctx.logger.info(`[remote-vs] preset auto-switch skipped for ${facts.cwd}: ${step.reason}`)
          }
        } catch {
          // Logging must never break routing.
        }
      } catch (error) {
        try {
          ctx.logger.warn(`[remote-vs] preset auto-switch skipped: ${error instanceof Error ? error.message : String(error)}`)
        } catch {
          // Ignore.
        }
      }
    })()
    return undefined
  })
  sync()
}
