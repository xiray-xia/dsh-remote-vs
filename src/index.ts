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
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { RemoteStore } from './store.ts'
import type { RemoteTimeouts } from './protocol.ts'
import { RemotePool } from './pool.ts'
import { seedHelperCache } from './deploy.ts'
import { makeRoutes } from './routes.ts'
import {
  DEFAULT_GIT_TIMEOUT_MS,
  DEFAULT_READ_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  resolveTimeouts,
} from './timeouts.ts'
import { RemoteWorlds, type RoutingMode, type WorldRoute } from './p2/worlds.ts'
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
  routingMode: z.union(['off', 'shadow', 'enforce'] as const).default('off').volatile(),
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
    mode: () => readField(config?.routingMode, 'off' as RoutingMode),
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
  // boundaries, never from the request path: a snapshot on a monorepo can take
  // tens of seconds, and a turn must never wait for it. `cwd` is resolved here
  // because the recorder deliberately knows nothing about cordis.
  /**
   * Which sessions get a ledger.
   *
   * Subagent sessions are skipped on purpose, the same policy DSH's own
   * recorder uses: a delegated session writes into the same workspace, so its
   * files show up in the parent's snapshot diff anyway, while recording it
   * separately would run a snapshot per subagent turn (a Team run fans out and
   * a monorepo snapshot is the expensive one).
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
  ctx.effect(() => () => { changes.dispose() }, 'dsh-remote-vs: changes ledger')

  const { routes, upgrade, terminalSessions } = makeRoutes({
    store,
    pool,
    worlds,
    ctx,
    timeouts: resolveTimeoutsNow,
    changes,
  })

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
    if (!value.enabled) return
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
        return () => {
          for (const dispose of disposers) dispose()
          upgradeDisposer()
          terminalSessions.dispose()
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
  // Phase 4b auto-switch (race-free take 2, 2026-10-13): new sessions born in
  // a remote workspace switch to Remote once. Calling select() synchronously
  // from agent/created races the initial mount (both preset trees register
  // tools concurrently → `subagent already registered` → session creation
  // dies), so the listener DETACHES: it returns immediately (creation never
  // blocks) and a delayed attempt runs after mount fibers settle (ms-scale;
  // 2.5s is forever). Guards re-checked at fire time; a started turn (locked)
  // or any failure silently keeps standard (routing still works, bash tool
  // excepted) — manual selection remains the fallback. Nothing here can fail
  // session creation: the worst case is today's manual behavior plus a warn.
  ctx.on('agent/created', (payload) => {
    if (payload.source !== 'startup') return undefined
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const presets = ctx.get('agentPresets')
          if (presets === undefined) return
          if (worlds.mode !== 'enforce') return
          const current = presets.composedPreset(payload.agent.ctx)
          if (current !== presets.defaultId || current === 'remote') return
          const workingDirectory = ctx.get('workingDirectory')
          if (workingDirectory === undefined) return
          let cwd: string
          try {
            cwd = workingDirectory.get(payload.agent.session)
          } catch {
            return
          }
          let remote = false
          try {
            remote = worlds.routeDir(cwd).kind === 'remote'
          } catch {
            return
          }
          if (!remote) return
          await presets.select(payload.agent, 'remote')
          try {
            ctx.logger.info(`[remote-vs] new remote session entered ${cwd}; preset switched to remote`)
          } catch {
            // Logging must never break routing.
          }
        } catch (error) {
          // agent-preset/locked = user already started a turn: respect it.
          const locked = error instanceof Error && /locked|already started/i.test(error.message)
          if (locked) return
          try {
            ctx.logger.warn(`[remote-vs] preset auto-switch skipped: ${error instanceof Error ? error.message : String(error)}`)
          } catch {
            // Ignore.
          }
        }
      })()
    }, 2500)
    timer.unref?.()
    return undefined
  })
  sync()
}
