/**
 * The /api/dsh-remote route family: hosts, test, key bootstrap, exec, files,
 * workspaces, deploy pipeline, importers, and the WebSocket PTY upgrade.
 * Every route carries the loopback-only trust fence.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdirSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { readJsonBody, writeJson } from './http.ts'
import { isLoopbackRequest } from './loopback.ts'
import { REMOTE_API, type ImportReport } from './protocol.ts'
import type { HostPayload, RemoteStore } from './store.ts'
import type { RemotePool } from './pool.ts'
import type { RemoteWorlds } from './p2/worlds.ts'
import { RemoteFiles } from './sftp.ts'
import { bootstrap } from './keygen.ts'
import { helperAvailability, probe, pushPipeline } from './deploy.ts'
import { migrateDshSsh, parseSshConfig, readDefaultSshConfig, type ParsedImport } from './importers.ts'
import { TerminalSessionRegistry } from './terminal.ts'

/** One noServer WebSocket server for terminal upgrades (RFC 6455). */
const terminalWss = new WebSocketServer({ noServer: true })

function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

export interface RemoteRoutesDeps {
  store: RemoteStore
  pool: RemotePool
  worlds: RemoteWorlds
}

export function makeRoutes(deps: RemoteRoutesDeps): { routes: WebRoute[]; upgrade: WebUpgradeRoute; terminalSessions: TerminalSessionRegistry } {
  const { store, pool, worlds } = deps
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
        const timeoutMs = typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs)
          ? Math.min(Math.max(Math.floor(body.timeoutMs), 1000), 600_000)
          : undefined
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
