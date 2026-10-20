/**
 * The /api/dsh-remote route family: hosts, test, key bootstrap, exec, files,
 * workspaces, deploy pipeline, importers, and the WebSocket PTY upgrade.
 * Every route carries the loopback-only trust fence.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { readJsonBody, writeJson } from './http.ts'
import { isLoopbackRequest } from './loopback.ts'
import { REMOTE_API, type ImportReport, type RemoteTimeouts } from './protocol.ts'
import type { HostPayload, RemoteStore } from './store.ts'
import type { RemotePool } from './pool.ts'
import type { RemoteWorlds } from './p2/worlds.ts'
import { RemoteFiles } from './sftp.ts'
import { bootstrap } from './keygen.ts'
import { helperAvailability, probe, pushPipeline } from './deploy.ts'
import { migrateDshSsh, parseSshConfig, readDefaultSshConfig, type ParsedImport } from './importers.ts'
import { TERMINAL_MAX_FRAME_BYTES, TerminalSessionRegistry } from './terminal.ts'
import type { SessionChanges } from './changes/recorder.ts'
import { DEFAULT_TIMEOUTS, clampExecTimeout } from './timeouts.ts'

/** One noServer WebSocket server for terminal upgrades (RFC 6455). */
// `maxPayload` is the authoritative frame bound: without it ws buffers up to its
// 100 MiB default before the handler ever sees the message, in the process that
// also runs the agent. Terminal frames are small JSON control messages.
const terminalWss = new WebSocketServer({ noServer: true, maxPayload: TERMINAL_MAX_FRAME_BYTES })

function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/** This plugin's version from the shipped package.json (Settings display). */
let cachedVersion: string | undefined

function pluginVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion
  try {
    // Walk up from lib/: the first package.json on the way may belong to an
    // enclosing project (profile dir, workspace root), so the name gate is
    // load-bearing — never report a foreign version.
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let depth = 0; depth < 4; depth += 1) {
      const pkg = join(dir, 'package.json')
      try {
        if (existsSync(pkg)) {
          const raw = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: unknown; version?: unknown }
          if (raw.name === 'dsh-remote-vs' && typeof raw.version === 'string' && raw.version !== '') {
            cachedVersion = raw.version
            return cachedVersion
          }
        }
      } catch {
        // Keep walking.
      }
      dir = dirname(dir)
    }
  } catch {
    // Fall through to unknown.
  }
  cachedVersion = 'unknown'
  return cachedVersion
}

export interface RemoteRoutesDeps {
  store: RemoteStore
  pool: RemotePool
  worlds: RemoteWorlds
  /** Host context (soft reads only: loader/settings for the routing route). */
  ctx: Context
  /**
   * Effective timeouts, read per request so a `volatile()` config edit applies
   * live. Absent in tests and older wiring: the shared defaults then stand.
   */
  timeouts?: () => RemoteTimeouts
  /** Session change ledger, when the host half mounted one. */
  changes?: SessionChanges
}

/** Package name our loader row is mounted from (ns discovery key). */
const REMOTE_PACKAGE_NAME = 'dsh-remote-vs'

/**
 * This plugin's own loader entry id (the settings-form namespace).
 *
 * Settings are addressed by profile entry id, which is a mount choice, not
 * a package property — an aggregate bundle may mount this package under any
 * id. So the row is identified by package name plus fiber identity, with an
 * enabled same-name row as fallback (the dsh-better-sidebar pattern). All
 * reads are soft: unknown compositions answer undefined instead of throwing.
 */
function ownSettingsNs(ctx: Context): string | undefined {
  let fallback: string | undefined
  try {
    const loader = ctx.get('loader') as
      | { entries?: () => Iterable<{ options: { id?: unknown; name?: unknown }; fiber?: unknown; disabled?: unknown }> }
      | undefined
    if (typeof loader?.entries !== 'function') return undefined
    const self = (ctx as unknown as { fiber?: unknown }).fiber
    for (const entry of loader.entries()) {
      const id = entry.options.id
      if (entry.options.name !== REMOTE_PACKAGE_NAME || typeof id !== 'string' || id === '') continue
      if (self !== undefined && entry.fiber === self) return id
      if (entry.disabled !== true && fallback === undefined) fallback = id
    }
  } catch {
    return undefined
  }
  return fallback
}

export function makeRoutes(deps: RemoteRoutesDeps): { routes: WebRoute[]; upgrade: WebUpgradeRoute; terminalSessions: TerminalSessionRegistry } {
  const { store, pool, worlds, ctx } = deps
  /** Timeouts for this request (a volatile config edit must apply live). */
  const timeouts = (): RemoteTimeouts => deps.timeouts?.() ?? DEFAULT_TIMEOUTS
  const files = new RemoteFiles(pool)
  const terminalSessions = new TerminalSessionRegistry(pool)

  /** Apply parsed import payloads; per-entry errors become skips. */
  const applyImport = (parsed: ParsedImport): ImportReport => {
    const imported: string[] = []
    const skipped = [...parsed.skipped]
    for (const payload of parsed.payloads) {
      if (store.get(payload.alias) !== undefined) {
        skipped.push({ alias: payload.alias, reason: 'alias already exists' })
        continue
      }
      try {
        store.create(payload as HostPayload)
        imported.push(payload.alias)
      } catch (error) {
        skipped.push({ alias: payload.alias, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    return { imported, skipped }
  }

  const routes: WebRoute[] = [
    // ------------------------------------------------------------ hosts
    {
      kind: 'exact',
      path: REMOTE_API.hosts,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const method = req.method ?? 'GET'
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (method === 'GET') {
          writeJson(res, 200, { hosts: store.list().map(h => store.summarize(h)) })
          return
        }
        if (method === 'POST') {
          const body = (await readJsonBody(req, { objectOnly: true })) as Record<string, unknown> | null
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          try {
            const entry = store.create(body as unknown as HostPayload)
            writeJson(res, 201, { host: store.summarize(entry) })
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (method !== 'PATCH' && method !== 'DELETE') {
          writeJson(res, 405, { error: `method not allowed: ${method}` })
          return
        }
        const alias = queryParam(url, 'alias')
        if (alias === undefined || alias === '') {
          writeJson(res, 400, { error: 'alias query parameter is required' })
          return
        }
        if (method === 'DELETE') {
          pool.drop(alias)
          void worlds.dropHost(alias).catch(() => undefined)
          if (!store.remove(alias)) {
            writeJson(res, 404, { error: `unknown host alias: ${alias}` })
            return
          }
          void worlds.syncWorkspaces().catch(() => undefined)
          writeJson(res, 200, { ok: true })
          return
        }
        const body = (await readJsonBody(req, { objectOnly: true })) as Record<string, unknown> | null
        if (body === null) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          pool.drop(alias)
          void worlds.dropHost(alias).catch(() => undefined)
          const entry = store.update(alias, body as Partial<HostPayload>)
          writeJson(res, 200, { host: store.summarize(entry) })
        } catch (error) {
          const status = (error instanceof Error ? error.message : '').startsWith('unknown host alias') ? 404 : 400
          writeJson(res, status, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ------------------------------------------------------------- test
    {
      kind: 'exact',
      path: REMOTE_API.test,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const body = (await readJsonBody(req, { objectOnly: true })) as { alias?: unknown } | null
        if (body === null || typeof body.alias !== 'string') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        writeJson(res, 200, await pool.test(body.alias))
      },
    },
    // ----------------------------------------------------------- keygen
    {
      kind: 'exact',
      path: REMOTE_API.keygen,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const body = (await readJsonBody(req, { objectOnly: true })) as { alias?: unknown } | null
        if (body === null || typeof body.alias !== 'string') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        try {
          const result = await bootstrap(pool, store, body.alias)
          writeJson(res, 200, result)
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // -------------------------------------------------------------- exec
    {
      kind: 'exact',
      path: REMOTE_API.exec,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const body = (await readJsonBody(req, { objectOnly: true })) as {
          alias?: unknown
          command?: unknown
          timeoutMs?: unknown
        } | null
        if (body === null || typeof body.alias !== 'string' || typeof body.command !== 'string' || body.command === '') {
          writeJson(res, 400, { error: 'alias and a non-empty command are required' })
          return
        }
        const timeoutMs = clampExecTimeout(body.timeoutMs)
        writeJson(res, 200, await pool.exec(body.alias, body.command, timeoutMs === undefined ? {} : { timeoutMs }))
      },
    },
    // ------------------------------------------------------------- files
    {
      kind: 'exact',
      path: REMOTE_API.files,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const body = (await readJsonBody(req, { objectOnly: true, maxBytes: 10 * 1024 * 1024 })) as Record<string, unknown> | null
        if (body === null || typeof body.op !== 'string' || typeof body.alias !== 'string') {
          writeJson(res, 400, { error: 'op and alias are required' })
          return
        }
        const alias = body.alias as string
        try {
          switch (body.op) {
            case 'list': {
              if (typeof body.path !== 'string') throw new Error('path is required')
              writeJson(res, 200, { entries: await files.list(alias, body.path) })
              return
            }
            case 'stat': {
              if (typeof body.path !== 'string') throw new Error('path is required')
              writeJson(res, 200, { entry: await files.stat(alias, body.path) })
              return
            }
            case 'read': {
              if (typeof body.path !== 'string') throw new Error('path is required')
              writeJson(res, 200, await files.read(alias, body.path))
              return
            }
            case 'write': {
              if (typeof body.path !== 'string' || typeof body.content !== 'string') throw new Error('path and content are required')
              const encoding = body.encoding === 'base64' ? 'base64' : 'utf8'
              writeJson(res, 200, await files.write(alias, body.path, body.content, encoding))
              return
            }
            case 'mkdir': {
              if (typeof body.path !== 'string') throw new Error('path is required')
              await files.mkdir(alias, body.path)
              writeJson(res, 200, { ok: true })
              return
            }
            case 'rm': {
              if (typeof body.path !== 'string') throw new Error('path is required')
              await files.remove(alias, body.path, body.recursive === true)
              writeJson(res, 200, { ok: true })
              return
            }
            case 'rename': {
              if (typeof body.from !== 'string' || typeof body.to !== 'string') throw new Error('from and to are required')
              await files.rename(alias, body.from, body.to)
              writeJson(res, 200, { ok: true })
              return
            }
            default:
              writeJson(res, 400, { error: `unknown op: ${body.op}` })
          }
        } catch (error) {
          writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ------------------------------------------------------------- upload
    // Streaming binary upload for the explorer's drag & drop and "Upload…"
    // actions. The body IS the file (no base64, no JSON envelope): a dropped
    // file must not hit the 10 MiB JSON cap, pay the 33 % base64 tax, or be
    // buffered whole in Host memory.
    {
      kind: 'exact',
      path: REMOTE_API.upload,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = url.searchParams.get('alias') ?? ''
        const path = url.searchParams.get('path') ?? ''
        const overwrite = url.searchParams.get('overwrite') === '1'
        if (alias === '' || path === '') {
          writeJson(res, 400, { error: 'alias and path query parameters are required' })
          return
        }
        if (!path.startsWith('/')) {
          // The client joins absolute remote paths itself; anything else is a
          // caller bug, and writing it would land relative to the SFTP home.
          writeJson(res, 400, { error: `path must be absolute: ${path}` })
          return
        }
        try {
          if (!overwrite) {
            // The client asks once per batch and then retries with overwrite=1;
            // a 409 carrying `exists` lets it count conflicts without a second
            // round trip per file.
            const exists = await files.stat(alias, path).then(() => true, () => false)
            if (exists) {
              writeJson(res, 409, { error: `${path} already exists`, exists: true })
              return
            }
          }
          const written = await files.upload(alias, path, req, undefined, overwrite)
          writeJson(res, 200, { ok: true, size: written.size })
        } catch (error) {
          writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // -------------------------------------------------------- workspaces
    {
      kind: 'exact',
      path: REMOTE_API.workspaces,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const method = req.method ?? 'GET'
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (method === 'GET') {
          const bindings = store.listWorkspaces()
          const aliasPaths: Record<string, string> = {}
          for (const b of bindings) aliasPaths[b.id] = worlds.aliasPathFor(b.id)
          // Lazy registry ensure: a boot-time sync may have run before the
          // workspace registry was ready (soft-skipped); the GUI always GETs
          // on load, long after readiness, so re-sync here best-effort.
          void worlds.syncWorkspaces().catch(() => undefined)
          writeJson(res, 200, {
            workspaces: bindings,
            mode: worlds.mode,
            aliasPaths,
            tombstones: store.listTombstones(),
            version: pluginVersion(),
            // The client's own deadlines must match what this Host would allow,
            // otherwise a raised `gitTimeoutMs` still died at the client's 45 s
            // deadline (2026-10-19: large-repo `git status` looked like a hang).
            timeouts: timeouts(),
          })
          return
        }
        if (method === 'POST') {
          const body = (await readJsonBody(req, { objectOnly: true })) as Record<string, unknown> | null
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          try {
            const binding = store.createWorkspace(
              body as unknown as { name: string; alias: string; remotePath: string },
            )
            // Phase 4: the native directory-flow occupant needs the alias path
            // synchronously (it hands it to onPicked for Host adoption), so
            // materialize before responding instead of fire-and-forget. The
            // alias dir itself is created DIRECTLY here (in-try, loud errors):
            // syncWorkspaces stays best-effort for registry entries, but a
            // missing dir must never surface downstream as a cryptic owner
            // ENOENT again (2026-10-13 post-restart incident).
            const aliasPath = worlds.aliasPathFor(binding.id)
            try {
              mkdirSync(aliasPath, { recursive: true })
            } catch (error) {
              throw new Error(`cannot materialize alias dir ${aliasPath}: ${error instanceof Error ? error.message : String(error)}`)
            }
            await worlds.syncWorkspaces().catch(() => undefined)
            writeJson(res, 201, { workspace: binding, aliasPath })
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (method !== 'DELETE') {
          writeJson(res, 405, { error: `method not allowed: ${method}` })
          return
        }
        const id = queryParam(url, 'id')
        if (id === undefined || id === '') {
          writeJson(res, 400, { error: 'id query parameter is required' })
          return
        }
        if (!store.removeWorkspace(id)) {
          writeJson(res, 404, { error: `unknown workspace id: ${id}` })
          return
        }
        void worlds.syncWorkspaces().catch(() => undefined)
        writeJson(res, 200, { ok: true })
      },
    },
    // ------------------------------------- session cwd (click resolution)
    // A file reference the model prints is usually relative to the directory
    // the model actually worked in, while DSH resolves the click against the
    // SESSION WORKSPACE ROOT — one cd away and the click misses. The client
    // interceptor asks for the live session's current directory here so it can
    // try the model-relative spelling as a second candidate. Reads are soft:
    // a non-live/unknown session answers an empty body, and the client keeps
    // the plain workspace-root base (the previous behaviour).
    {
      kind: 'exact',
      path: REMOTE_API.sessionCwd,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if ((req.method ?? 'GET') !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${req.method ?? 'GET'}` })
          return
        }
        const body = (await readJsonBody(req, { objectOnly: true })) as { sessionId?: unknown } | null
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') {
          writeJson(res, 400, { error: 'sessionId must be a non-empty string' })
          return
        }
        let cwd: string | undefined
        try {
          const agents = ctx.get('agents') as { get?: (id: string) => unknown } | undefined
          const workingDirectory = ctx.get('workingDirectory') as
            | { get?: (session: unknown) => unknown }
            | undefined
          const agent = agents?.get?.(sessionId) as { session?: unknown } | undefined
          if (agent?.session !== undefined && typeof workingDirectory?.get === 'function') {
            const value = workingDirectory.get(agent.session)
            if (typeof value === 'string' && value !== '') cwd = value
          }
        } catch {
          // Soft read: any composition without these services answers no cwd.
        }
        writeJson(res, 200, { cwd })
      },
    },
    // ------------------------------------------- session change ledger
    // What one live session changed on its remote host. The ledger itself is
    // fed by turn events (see index.ts); the browser only ever reads it, which
    // is why both ops are side-effect free and answer null instead of 404 when
    // the session has no ledger yet (the panel shows its pending/absent state).
    {
      kind: 'exact',
      path: REMOTE_API.changes,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if ((req.method ?? 'GET') !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${req.method ?? 'GET'}` })
          return
        }
        const body = (await readJsonBody(req, { objectOnly: true })) as Record<string, unknown> | null
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        const op = typeof body?.op === 'string' ? body.op : ''
        if (sessionId === '' || (op !== 'list' && op !== 'diff')) {
          writeJson(res, 400, { error: 'op (list|diff) and a non-empty sessionId are required' })
          return
        }
        const ledger = deps.changes
        if (ledger === undefined) {
          writeJson(res, 200, { summary: null, diff: null })
          return
        }
        if (op === 'list') {
          writeJson(res, 200, { summary: ledger.summary(sessionId) })
          return
        }
        const path = typeof body?.path === 'string' ? body.path : ''
        if (path === '') {
          writeJson(res, 400, { error: 'path is required for op=diff' })
          return
        }
        try {
          writeJson(res, 200, { diff: await ledger.diff(sessionId, path) })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // --------------------------------------------- routing mode (volatile)
    // The Settings UI flips off/shadow/enforce here instead of editing the
    // profile patch by hand. The write goes through the official settings
    // service (same channel the Settings dialog uses): it validates against
    // our Config schema, persists to the profile patch, and volatile
    // reconciliation applies it live — no restart, survives restarts.
    {
      kind: 'exact',
      path: REMOTE_API.routing,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if ((req.method ?? 'GET') !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${req.method ?? 'GET'}` })
          return
        }
        const body = (await readJsonBody(req, { objectOnly: true })) as Record<string, unknown> | null
        const mode = body?.mode
        if (mode !== 'off' && mode !== 'shadow' && mode !== 'enforce') {
          writeJson(res, 400, { error: `mode must be one of off/shadow/enforce (got ${JSON.stringify(mode) ?? 'missing'})` })
          return
        }
        try {
          const settings = ctx.get('settings') as
            | { update?: (ns: string, patch: Record<string, unknown>) => Promise<void> }
            | undefined
          if (typeof settings?.update !== 'function') {
            writeJson(res, 503, { error: 'settings service unavailable (cannot persist routing mode)' })
            return
          }
          const ns = ownSettingsNs(ctx) ?? 'remote-vs'
          await settings.update(ns, { routingMode: mode })
          writeJson(res, 200, { mode: worlds.mode })
        } catch (error) {
          writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ------------------------------------------------------------ deploy
    {
      kind: 'exact',
      path: REMOTE_API.deploy,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const method = req.method ?? 'GET'
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (method === 'GET') {
          const alias = queryParam(url, 'alias')
          const view = queryParam(url, 'view') ?? 'status'
          if (alias === undefined || alias === '') {
            writeJson(res, 400, { error: 'alias query parameter is required' })
            return
          }
          if (view === 'probe') {
            try {
              writeJson(res, 200, await probe(pool, alias))
            } catch (error) {
              writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) })
            }
            return
          }
          if (view === 'status') {
            try {
              const entry = store.require(alias)
              writeJson(res, 200, { deploy: entry.deploy ?? { status: 'not-deployed' }, helpers: helperAvailability() })
            } catch (error) {
              writeJson(res, 404, { error: error instanceof Error ? error.message : String(error) })
            }
            return
          }
          writeJson(res, 400, { error: `unknown view: ${view}` })
          return
        }
        if (method !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${method}` })
          return
        }
        const body = (await readJsonBody(req, { objectOnly: true })) as { alias?: unknown; version?: unknown } | null
        if (body === null || typeof body.alias !== 'string') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        try {
          writeJson(res, 200, await pushPipeline(pool, store, body.alias, typeof body.version === 'string' ? { version: body.version } : {}))
        } catch (error) {
          writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // --------------------------------------------------- import ssh_config
    {
      kind: 'exact',
      path: REMOTE_API.importSshConfig,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const body = (await readJsonBody(req, { maxBytes: 1024 * 1024 })) as { text?: unknown } | null
        try {
          const text = body !== null && typeof body.text === 'string' ? body.text : readDefaultSshConfig()
          writeJson(res, 200, applyImport(parseSshConfig(text)))
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // --------------------------------------------------- import dsh-ssh
    {
      kind: 'exact',
      path: REMOTE_API.importDshSsh,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        try {
          writeJson(res, 200, applyImport(migrateDshSsh()))
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---------------------------------------------- terminal close
    {
      kind: 'exact',
      path: REMOTE_API.terminalClose,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const body = (await readJsonBody(req, { objectOnly: true })) as { id?: unknown } | null
        if (body === null || typeof body.id !== 'string' || body.id === '') {
          writeJson(res, 400, { error: 'id is required' })
          return
        }
        writeJson(res, 200, { ok: terminalSessions.close(body.id) })
      },
    },
  ]

  // ---------------------------------------------- terminal (upgrade)
  const upgrade: WebUpgradeRoute = {
    path: REMOTE_API.terminal,
    handler: (req, socket, head) => {
      if (!isLoopbackRequest(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const alias = queryParam(url, 'alias')
      const sessionId = queryParam(url, 'session')
      if (alias === undefined && sessionId === undefined) {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const cols = Number.parseInt(queryParam(url, 'cols') ?? '80', 10)
      const rows = Number.parseInt(queryParam(url, 'rows') ?? '24', 10)
      const size = {
        cols: Number.isFinite(cols) && cols > 0 ? Math.min(cols, 500) : 80,
        rows: Number.isFinite(rows) && rows > 0 ? Math.min(rows, 200) : 24,
      }
      terminalWss.handleUpgrade(req, socket, head, (ws) => {
        if (sessionId !== undefined) {
          if (terminalSessions.attach(ws, sessionId, size.cols, size.rows)) return
          try {
            ws.send(JSON.stringify({ t: 'error', message: 'terminal session expired' }))
          } catch {
            // Socket raced away.
          }
          try {
            ws.close(1000)
          } catch {
            // Already closed.
          }
          return
        }
        void terminalSessions.open(ws, alias as string, size.cols, size.rows).then(
          () => undefined,
          () => undefined,
        )
      })
    },
  }

  return { routes, upgrade, terminalSessions }
}
