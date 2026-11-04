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
import { readJsonBodyResult, writeJson, writeRouteError } from './http.ts'
import { isLoopbackRequest } from './loopback.ts'
import { REMOTE_API, MAX_SELECTION_DOWNLOAD, selectionDownloadName, type ExecStreamEvent, type ImportReport, type RemoteTimeouts } from './protocol.ts'
import type { HostPayload, RemoteStore } from './store.ts'
import type { RemotePool } from './pool.ts'
import type { RemoteWorlds } from './p2/worlds.ts'
import { RemoteFiles, WriteConflictError, attachmentHeader } from './sftp.ts'
import { directoryArchiveCommand, directoryArchiveName, selectionArchiveCommand } from './archive.ts'
import { bootstrap } from './keygen.ts'
import { helperAvailability, probe, pushPipeline } from './deploy.ts'
import { migrateDshSsh, parseSshConfig, readDefaultSshConfig, type ParsedImport } from './importers.ts'
import { TERMINAL_MAX_FRAME_BYTES, TerminalSessionRegistry } from './terminal.ts'
import { ForwardManager, validateForwardRequest } from './forward.ts'
import { LISTEN_PORTS_TIMEOUT_MS, listenPortsCommand, parseListenPorts } from './listen-ports.ts'
import { HostMonitor } from './monitor.ts'
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

/**
 * A caller mistake the route can name: well-formed HTTP, unusable payload.
 *
 * `/files` used to throw plain Errors for missing fields and map EVERY failure
 * to 502, so "your request had no path" was reported as "the remote host
 * failed". The class keeps that distinction at the HTTP status.
 */
class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

/**
 * Reject an oversized JSON body BEFORE reading it.
 *
 * A known Content-Length lets the route answer 413 without draining the body at
 * all (the GUI always sends one). A chunked body without the header is caught by
 * `readJsonBodyResult` after the read and answered with the same 413, so this
 * preflight is only the cheap path — not the only one.
 */
function bodyTooLarge(req: IncomingMessage, maxBytes: number): boolean {
  const raw = req.headers['content-length']
  if (typeof raw !== 'string') return false
  const length = Number(raw)
  return Number.isFinite(length) && length > maxBytes
}

/** Answer 413 and drain the rest of the body so the socket is not reset mid-response. */
function writePayloadTooLarge(req: IncomingMessage, res: ServerResponse, maxBytes: number): void {
  writeJson(res, 413, { error: `request body exceeds ${maxBytes} bytes` }, { connection: 'close' })
  req.resume()
}

/**
 * Read one JSON request body, answering the outcomes every route shares the same
 * way: an oversized body is a 413 (the connection closes), malformed JSON is a
 * 400. `{ ok: false }` means a response was already written — the handler returns.
 *
 * An EMPTY body still arrives as `null`, so each route keeps its own "missing
 * object" answer, and `objectOnly` is passed through unchanged.
 */
async function readBodyOrError<T>(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { maxBytes?: number; objectOnly?: boolean } = {},
): Promise<{ ok: true; body: T | null } | { ok: false }> {
  const result = await readJsonBodyResult(req, opts)
  if (result.kind === 'too-large') {
    writeJson(res, 413, { error: `request body exceeds ${result.maxBytes} bytes` }, { connection: 'close' })
    return { ok: false }
  }
  if (result.kind === 'invalid') {
    writeJson(res, 400, { error: 'invalid JSON body' })
    return { ok: false }
  }
  return { ok: true, body: result.kind === 'ok' ? (result.value as T) : null }
}

/** Body cap of the /files route (base64/UTF-8 file content). */
const FILES_BODY_LIMIT = 10 * 1024 * 1024

/** Body cap of the ssh_config import route (pasted config text). */
const SSH_CONFIG_BODY_LIMIT = 1024 * 1024

/**
 * Total budget for one archive stream (directory or multi-selection download).
 *
 * A hung remote `tar` (a stalled mount, a failing disk, a huge tree) otherwise
 * pins the Host channel until the CLIENT disconnects, and `channel.close()`
 * alone cannot stop a tar that is blocked on a read. Enforced on the remote side
 * so it survives a dead HTTP socket too.
 */
const ARCHIVE_TIMEOUT_SECONDS = 600

/**
 * Wrap one archive command in a remote-side deadline.
 *
 * The command is a single `tar` invocation with already-quoted operands
 * (`archive.ts` builders), so prefixing is syntactically safe and makes tar the
 * direct child of `timeout` — TERM (then KILL after 3 s) reaches tar itself, no
 * process-group id is needed (2026-10 audit, A16-1). Hosts without GNU `timeout`
 * (BSD/macOS) fall back to today's behaviour instead of failing the download.
 */
export function archiveCommandWithDeadline(command: string): string {
  return `if command -v timeout >/dev/null 2>&1; then timeout -k 3 ${ARCHIVE_TIMEOUT_SECONDS} ${command}; else ${command}; fi`
}

/**
 * Error for a failed archive stream.
 *
 * GNU `timeout` reports 124 when TERM sufficed and 137 when KILL was needed;
 * both mean "the remote budget ran out", which is more actionable than
 * `tar failed (124): no stderr`.
 */
export function archiveFailureMessage(exitCode: number | null | undefined, stderr: string): Error {
  if (exitCode === 124 || exitCode === 137) return new Error(`archive timed out after ${ARCHIVE_TIMEOUT_SECONDS}s`)
  const detail = stderr.trim() === '' ? 'no stderr' : stderr.trim().slice(0, 400)
  const code = exitCode === null || exitCode === undefined ? 'signal' : exitCode
  return new Error(`tar failed (${code}): ${detail}`)
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
  /**
   * Live local port forwards. Absent only in route-only probes (the gates build
   * `makeRoutes` with the minimum they need): the port routes then answer 503
   * instead of pretending the feature exists.
   */
  forwards?: ForwardManager
}

/** Package name our loader row is mounted from (ns discovery key). */
const REMOTE_PACKAGE_NAME = 'dsh-remote-vs'

/**
 * The working directory of one LIVE session, or undefined.
 *
 * Soft reads only: a composition without `agents`/`workingDirectory` answers
 * undefined instead of throwing, and the callers treat that as "unknown".
 */
function liveSessionCwd(ctx: Context, sessionId: string): string | undefined {
  try {
    const agents = ctx.get('agents') as { get?: (id: string) => unknown } | undefined
    const workingDirectory = ctx.get('workingDirectory') as
      | { get?: (session: unknown) => unknown }
      | undefined
    const agent = agents?.get?.(sessionId) as { session?: unknown } | undefined
    if (agent?.session !== undefined && typeof workingDirectory?.get === 'function') {
      const value = workingDirectory.get(agent.session)
      if (typeof value === 'string' && value !== '') return value
    }
  } catch {
    // Soft read.
  }
  return undefined
}

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
  // Cache/counters only (no timers, no listeners): a route rebuild losing it
  // costs one extra sample, so it is safe to construct here instead of owning a
  // fiber-scoped effect like the forward manager.
  const monitor = new HostMonitor(pool)
  const forwards = deps.forwards

  /**
   * Stream one remote `tar -czf -` command into a `.tar.gz` download response.
   *
   * Shared by the directory and multi-selection routes (they differ only in the
   * command and the attachment name). The archive is produced remotely; the
   * response has no length, backpressure pauses the channel, and a non-zero tar
   * exit destroys the response with the stderr tail.
   */
  const streamArchive = async (alias: string, command: string, res: ServerResponse, downloadName: string): Promise<void> => {
    let channel: Awaited<ReturnType<typeof pool.execChannel>>
    try {
      channel = await pool.execChannel(alias, archiveCommandWithDeadline(command))
    } catch (error) {
      writeRouteError(res, error)
      return
    }
    res.writeHead(200, {
      'content-type': 'application/gzip',
      'content-disposition': attachmentHeader(downloadName),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    // Send the headers now so the browser's save/stream starts immediately instead
    // of waiting for the remote tar to produce its first byte (A16-2).
    res.flushHeaders()
    let closed = false
    /** `undefined` until the remote process reports one. */
    let exitCode: number | null | undefined
    let stderr = ''
    /** Finish once: end on success, destroy on failure, close the remote channel either way. */
    const stop = (error?: Error): void => {
      if (closed) return
      closed = true
      try {
        channel.close()
      } catch {
        // Channel already gone.
      }
      if (error === undefined) {
        try {
          res.end()
        } catch {
          // Already gone.
        }
        return
      }
      res.destroy(error)
    }
    channel.stdout.on('data', (chunk: Buffer) => {
      if (closed) return
      try {
        // Backpressure reaches the remote tar via the channel window.
        if (!res.write(chunk)) channel.stdout.pause()
      } catch (error) {
        stop(error instanceof Error ? error : new Error(String(error)))
      }
    })
    res.on('drain', () => {
      if (!closed) {
        try {
          channel.stdout.resume()
        } catch {
          // Already closed.
        }
      }
    })
    channel.stderr.on('data', (chunk: Buffer) => {
      // Keep a bounded tail: it explains a non-zero tar exit to the client.
      if (stderr.length < 16_384) stderr += chunk.toString('utf8')
    })
    channel.on('error', (error: Error) => stop(error))
    ;(channel as unknown as { on(event: 'exit', listener: (code: number | null, signal?: string) => void): void })
      .on('exit', (code) => {
        exitCode = code
      })
    channel.on('close', () => {
      if (closed) return
      if (exitCode !== 0) {
        stop(archiveFailureMessage(exitCode, stderr))
        return
      }
      stop()
    })
    res.on('close', () => stop())
  }

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
          const read = await readBodyOrError<Record<string, unknown>>(req, res, { objectOnly: true })
          if (!read.ok) return
          const body = read.body
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
          // A deleted host has no panel row left to stop its forwards from, so
          // their listeners would keep the local ports bound until the Host
          // restarts. Close them BEFORE the connection they ride on goes away.
          forwards?.stopAlias(alias)
          pool.forget(alias)
          monitor.forget(alias)
          void worlds.dropHost(alias).catch(() => undefined)
          if (!store.remove(alias)) {
            writeJson(res, 404, { error: `unknown host alias: ${alias}` })
            return
          }
          void worlds.syncWorkspaces().catch(() => undefined)
          writeJson(res, 200, { ok: true })
          return
        }
        const read = await readBodyOrError<Record<string, unknown>>(req, res, { objectOnly: true })
        if (!read.ok) return
        const body = read.body
        if (body === null) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          pool.forget(alias)
          monitor.forget(alias)
          void worlds.dropHost(alias).catch(() => undefined)
          const entry = store.update(alias, body as Partial<HostPayload>)
          writeJson(res, 200, { host: store.summarize(entry) })
        } catch (error) {
          const status = (error instanceof Error ? error.message : '').startsWith('unknown host alias') ? 404 : 400
          writeJson(res, status, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ----------------------------------------------------------- status
    // Connection health for the browser's status chip. Read-only and dial-free:
    // it reports what the pool already knows, so polling it never opens a
    // connection or wakes a sleeping host.
    {
      kind: 'exact',
      path: REMOTE_API.status,
      handler: (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        writeJson(res, 200, { connections: pool.status() })
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
        const read = await readBodyOrError<{ alias?: unknown }>(req, res, { objectOnly: true })
        if (!read.ok) return
        const body = read.body
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
        const read = await readBodyOrError<{ alias?: unknown }>(req, res, { objectOnly: true })
        if (!read.ok) return
        const body = read.body
        if (body === null || typeof body.alias !== 'string') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        try {
          const result = await bootstrap(pool, store, body.alias)
          writeJson(res, 200, result)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // An unknown alias is the caller's mistake; everything else failed while
          // generating the keypair or pushing it to the host.
          writeJson(res, message.startsWith('unknown host alias') ? 404 : 502, { error: message })
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
        const read = await readBodyOrError<{
          alias?: unknown
          command?: unknown
          timeoutMs?: unknown
        }>(req, res, { objectOnly: true })
        if (!read.ok) return
        const body = read.body
        if (body === null || typeof body.alias !== 'string' || typeof body.command !== 'string' || body.command === '') {
          writeJson(res, 400, { error: 'alias and a non-empty command are required' })
          return
        }
        const timeoutMs = clampExecTimeout(body.timeoutMs)
        writeJson(res, 200, await pool.exec(body.alias, body.command, timeoutMs === undefined ? {} : { timeoutMs }))
      },
    },
    // ----------------------------------------------------- exec (streaming)
    {
      kind: 'exact',
      path: REMOTE_API.execStream,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const read = await readBodyOrError<{
          alias?: unknown
          command?: unknown
          timeoutMs?: unknown
        }>(req, res, { objectOnly: true })
        if (!read.ok) return
        const body = read.body
        if (body === null || typeof body.alias !== 'string' || typeof body.command !== 'string' || body.command === '') {
          writeJson(res, 400, { error: 'alias and a non-empty command are required' })
          return
        }
        const timeoutMs = clampExecTimeout(body.timeoutMs)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          // A reverse proxy must not buffer an event stream into uselessness.
          'X-Accel-Buffering': 'no',
        })
        // Headers must leave NOW: the client `fetch()` only resolves once they
        // arrive, and a silent command (a push waiting on the far end) would
        // otherwise keep the request unresolved until the first event or the
        // 15 s heartbeat (A16-2).
        res.flushHeaders()
        /** No more events to the client (finished, or the socket broke). */
        let outputClosed = false
        /** `res.end` already called. */
        let ended = false
        /** The client asked to stop: kill the remote even if the read is still opening. */
        let cancelRequested = false
        /** The cancel handle was invoked (only once). */
        let cancelSent = false
        let cancel: (() => void) | undefined
        /** Server-side forward cap: the client shows a scrolling tail anyway. */
        let sent = 0
        const FORWARD_CAP = 4 * 1024 * 1024
        /**
         * Stop the remote process group exactly once.
         *
         * The disconnect may happen while `pool.exec` is still acquiring the
         * channel (slot queue, setsid probe, connect) — the handle does not exist
         * yet then, so the request is latched and fired the moment `onCancel`
         * arrives; otherwise a push would finish unseen and uncancellable.
         */
        const abortRemote = (): void => {
          cancelRequested = true
          if (cancel === undefined || cancelSent) return
          cancelSent = true
          cancel()
        }
        const send = (event: ExecStreamEvent): void => {
          if (outputClosed) return
          try {
            res.write(`data: ${JSON.stringify(event)}\n\n`)
          } catch {
            // A broken socket means the client is gone: stop the remote git too.
            outputClosed = true
            abortRemote()
          }
        }
        const heartbeat = setInterval(() => {
          if (outputClosed) return
          try {
            // SSE comment: keeps an idle connection alive without inventing data.
            res.write(': ping\n\n')
          } catch {
            outputClosed = true
            abortRemote()
          }
        }, 15_000)
        heartbeat.unref?.()
        const stop = (): void => {
          if (ended) return
          ended = true
          outputClosed = true
          clearInterval(heartbeat)
          try {
            res.end()
          } catch {
            // Already gone.
          }
        }
        res.on('close', () => {
          // Client aborted (tab closed / cancel button / broken socket): stop the
          // remote git, not just our socket. Fires after a normal end too, where
          // it is a no-op because the run already settled.
          abortRemote()
          stop()
        })
        try {
          const result = await pool.exec(body.alias, body.command, {
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            onData: (stream, text) => {
              if (outputClosed || sent >= FORWARD_CAP) return
              sent += Buffer.byteLength(text, 'utf8')
              send({ t: stream, d: text })
            },
            onCancel: (handle) => {
              cancel = handle
              if (cancelRequested && !cancelSent) {
                cancelSent = true
                handle()
              }
            },
          })
          if (outputClosed) return
          send({
            t: 'exit',
            success: result.success,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            ...(result.error === undefined ? {} : { error: result.error }),
          })
        } catch (error) {
          send({
            t: 'exit',
            success: false,
            exitCode: null,
            timedOut: false,
            durationMs: 0,
            error: error instanceof Error ? error.message : String(error),
          })
        } finally {
          stop()
        }
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
        if (bodyTooLarge(req, FILES_BODY_LIMIT)) {
          writePayloadTooLarge(req, res, FILES_BODY_LIMIT)
          return
        }
        const read = await readBodyOrError<Record<string, unknown>>(req, res, { objectOnly: true, maxBytes: FILES_BODY_LIMIT })
        if (!read.ok) return
        const body = read.body
        if (body === null || typeof body.op !== 'string' || typeof body.alias !== 'string') {
          writeJson(res, 400, { error: 'op and alias are required' })
          return
        }
        const alias = body.alias as string
        try {
          switch (body.op) {
            case 'list': {
              if (typeof body.path !== 'string') throw new BadRequestError('path is required')
              writeJson(res, 200, { entries: await files.list(alias, body.path) })
              return
            }
            case 'stat': {
              if (typeof body.path !== 'string') throw new BadRequestError('path is required')
              writeJson(res, 200, { entry: await files.stat(alias, body.path) })
              return
            }
            case 'read': {
              if (typeof body.path !== 'string') throw new BadRequestError('path is required')
              writeJson(res, 200, await files.read(alias, body.path))
              return
            }
            case 'write': {
              if (typeof body.path !== 'string' || typeof body.content !== 'string') throw new BadRequestError('path and content are required')
              const encoding = body.encoding === 'base64' ? 'base64' : 'utf8'
              /**
               * Optional optimistic lock. `expectMtime` is the version the client
               * loaded; when present the Host refuses a file that changed since.
               * Requests without it (helpers, deploy, the agent's write tool)
               * keep the old unconditional semantics — the guard protects a
               * human's buffer, it must not make programmatic writes fail.
               */
              const expectMtime = body.expectMtime
              const expectSize = body.expectSize
              /**
               * A malformed baseline is a CALLER mistake, not "no baseline".
               *
               * Silently dropping it would turn `{expectMtime: "123"}` (a client
               * bug, a serializer change) into an UNGUARDED write — the exact
               * overwrite the caller was asking to be protected from, reported as
               * a success.
               */
              if (expectMtime !== undefined && (typeof expectMtime !== 'number' || !Number.isFinite(expectMtime))) {
                throw new BadRequestError('expectMtime must be a finite number')
              }
              if (expectSize !== undefined && (typeof expectSize !== 'number' || !Number.isFinite(expectSize))) {
                throw new BadRequestError('expectSize must be a finite number')
              }
              const guard = typeof expectMtime === 'number'
                ? { expectMtime, ...(typeof expectSize === 'number' ? { expectSize } : {}) }
                : undefined
              writeJson(res, 200, await files.write(alias, body.path, body.content, encoding, guard))
              return
            }
            case 'mkdir': {
              if (typeof body.path !== 'string') throw new BadRequestError('path is required')
              await files.mkdir(alias, body.path)
              writeJson(res, 200, { ok: true })
              return
            }
            case 'rm': {
              if (typeof body.path !== 'string') throw new BadRequestError('path is required')
              await files.remove(alias, body.path, body.recursive === true)
              writeJson(res, 200, { ok: true })
              return
            }
            case 'rename': {
              if (typeof body.from !== 'string' || typeof body.to !== 'string') throw new BadRequestError('from and to are required')
              await files.rename(alias, body.from, body.to)
              writeJson(res, 200, { ok: true })
              return
            }
            default:
              writeJson(res, 400, { error: `unknown op: ${body.op}` })
          }
        } catch (error) {
          /**
           * A save the remote side refused because the file moved on.
           *
           * 409, not 502: the operation did not fail, it was DECLINED — and the
           * client needs the current version to offer overwrite / reload / see
           * the difference. Collapsing this into the generic remote-error path
           * is how a silent overwrite becomes a red toast nobody can act on.
           */
          if (error instanceof WriteConflictError) {
            writeJson(res, 409, { error: error.message, code: 'conflict', conflict: error.conflict })
            return
          }
          // Caller mistakes are 400; only the remote side deserves 502.
          const status = error instanceof BadRequestError ? 400 : 502
          writeJson(res, status, { error: error instanceof Error ? error.message : String(error) })
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
          writeRouteError(res, error)
        }
      },
    },
    // ----------------------------------------------------------- download
    // Streaming binary download (the upload route's mirror): the response body
    // IS the file, so a multi-GB file never passes through base64 or Host
    // memory. The stat preflight lives in the client (`files` op=stat) so an
    // error keeps a readable JSON body instead of a saved error page.
    {
      kind: 'exact',
      path: REMOTE_API.download,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = url.searchParams.get('alias') ?? ''
        const path = url.searchParams.get('path') ?? ''
        if (alias === '' || path === '') {
          writeJson(res, 400, { error: 'alias and path query parameters are required' })
          return
        }
        if (!path.startsWith('/')) {
          // The client passes an absolute remote path; a relative one would
          // silently resolve against the SFTP home and download some other file.
          writeJson(res, 400, { error: `path must be absolute: ${path}` })
          return
        }
        try {
          await files.download(alias, path, res)
        } catch (error) {
          // The stat/stream start can still fail before any byte goes out, and
          // then the client expects its JSON error; once the body started (or
          // the connection is already gone) the only honest answer is closing
          // the connection.
          if (!res.headersSent && !res.destroyed) writeRouteError(res, error)
          else res.destroy(error instanceof Error ? error : undefined)
        }
      },
    },
    // ---------------------------------------------- download (directory)
    // A directory has no byte stream of its own: the archive is produced ON the
    // remote host (`tar -czf -`) and piped straight into the response, so the
    // Host never builds it in memory or on disk. The size is unknown (chunked),
    // which the client renders as an indeterminate progress bar; the stat
    // preflight keeps a missing path a JSON error instead of a truncated .tar.gz.
    {
      kind: 'exact',
      path: REMOTE_API.downloadDir,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = url.searchParams.get('alias') ?? ''
        const path = url.searchParams.get('path') ?? ''
        if (alias === '' || path === '') {
          writeJson(res, 400, { error: 'alias and path query parameters are required' })
          return
        }
        if (!path.startsWith('/')) {
          writeJson(res, 400, { error: `path must be absolute: ${path}` })
          return
        }
        let command: string
        try {
          const entry = await files.stat(alias, path)
          if (!entry.isDir) {
            writeJson(res, 400, { error: `not a directory: ${path}` })
            return
          }
          command = directoryArchiveCommand(path)
        } catch (error) {
          writeRouteError(res, error)
          return
        }
        await streamArchive(alias, command, res, directoryArchiveName(path))
      },
    },
    // ---------------------------------------- download (multi selection)
    // A selection is archived on the remote host as ONE tar stream (repeated
    // `path` params): every entry is validated before the response starts, so
    // the client shows one save dialog instead of N downloads and a missing
    // entry is a JSON error rather than a truncated archive.
    {
      kind: 'exact',
      path: REMOTE_API.downloadMany,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = url.searchParams.get('alias') ?? ''
        const paths = url.searchParams.getAll('path')
        if (alias === '' || paths.length === 0) {
          writeJson(res, 400, { error: 'alias and at least one path query parameter are required' })
          return
        }
        if (paths.length > MAX_SELECTION_DOWNLOAD) {
          writeJson(res, 400, { error: `too many entries: ${paths.length} (max ${MAX_SELECTION_DOWNLOAD})` })
          return
        }
        for (const path of paths) {
          if (!path.startsWith('/')) {
            writeJson(res, 400, { error: `path must be absolute: ${path}` })
            return
          }
        }
        let command: string
        try {
          // Validate every entry BEFORE the archive starts: a vanished/renamed
          // entry would otherwise surface as a truncated download.
          for (const path of paths) await files.stat(alias, path)
          command = selectionArchiveCommand(paths)
        } catch (error) {
          writeRouteError(res, error)
          return
        }
        await streamArchive(alias, command, res, selectionDownloadName(paths.length))
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
          const read = await readBodyOrError<Record<string, unknown>>(req, res, { objectOnly: true })
          if (!read.ok) return
          const body = read.body
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
        const read = await readBodyOrError<{ sessionId?: unknown }>(req, res, { objectOnly: true })
        if (!read.ok) return
        const body = read.body
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') {
          writeJson(res, 400, { error: 'sessionId must be a non-empty string' })
          return
        }
        const cwd = liveSessionCwd(ctx, sessionId)
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
        const read = await readBodyOrError<Record<string, unknown>>(req, res, { objectOnly: true })
        if (!read.ok) return
        const body = read.body
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
        // The repository directory the Source Control panel stores is an explicit
        // user choice, so it outranks anything the ledger would infer.
        if (typeof body?.repoSubdir === 'string' || body?.repoSubdir === null) {
          ledger.useRepoSubdir(sessionId, typeof body.repoSubdir === 'string' ? body.repoSubdir : undefined)
        }
        if (op === 'list') {
          // A session with no ledger yet is not a dead end. The ledger is created
          // by turn events, so a conversation that was already mid-turn when this
          // Host started (or one resumed from an older process) has none — and
          // the panel would then sit empty for the rest of that turn. Attaching
          // here costs one `git status` and makes the panel work immediately.
          if (ledger.summary(sessionId) === null) {
            const cwd = liveSessionCwd(ctx, sessionId)
            if (cwd !== undefined) ledger.beginTurn({ sessionId, cwd })
          }
          // `force` runs the slow untracked scan now instead of waiting for the
          // cadence — which is what the panel's refresh button means. A plain
          // poll still self-heals data that has gone stale, so a missed turn
          // boundary costs seconds rather than a manual click.
          if (body?.force === true) ledger.rescan(sessionId)
          else ledger.touch(sessionId)
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
          // Reading the diff is a remote (git) round trip: it failed upstream.
          writeRouteError(res, error)
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
        const read = await readBodyOrError<Record<string, unknown>>(req, res, { objectOnly: true })
        if (!read.ok) return
        const body = read.body
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
          writeRouteError(res, error)
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
              writeRouteError(res, error)
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
        const read = await readBodyOrError<{ alias?: unknown; version?: unknown }>(req, res, { objectOnly: true })
        if (!read.ok) return
        const body = read.body
        if (body === null || typeof body.alias !== 'string') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        try {
          writeJson(res, 200, await pushPipeline(pool, store, body.alias, typeof body.version === 'string' ? { version: body.version } : {}))
        } catch (error) {
          writeRouteError(res, error)
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
        if (bodyTooLarge(req, SSH_CONFIG_BODY_LIMIT)) {
          writePayloadTooLarge(req, res, SSH_CONFIG_BODY_LIMIT)
          return
        }
        const read = await readBodyOrError<{ text?: unknown }>(req, res, { maxBytes: SSH_CONFIG_BODY_LIMIT })
        if (!read.ok) return
        const body = read.body
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
        const read = await readBodyOrError<{ id?: unknown }>(req, res, { objectOnly: true })
        if (!read.ok) return
        const body = read.body
        if (body === null || typeof body.id !== 'string' || body.id === '') {
          writeJson(res, 400, { error: 'id is required' })
          return
        }
        writeJson(res, 200, { ok: terminalSessions.close(body.id) })
      },
    },
    // ---------------------------------------------- port forwards
    // Local TCP forwards (`ssh -L`): the listener lives in the ForwardManager
    // (its own fiber-scoped lifecycle), so this route family is a thin CRUD
    // face plus the remote listening-port probe. Local ports are loopback-only;
    // see `src/forward.ts` for why.
    {
      kind: 'exact',
      path: REMOTE_API.forwards,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (forwards === undefined) {
          writeJson(res, 503, { error: 'port forwarding is not available in this composition' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (req.method === 'GET') {
          const alias = queryParam(url, 'alias')
          writeJson(res, 200, { forwards: forwards.list(alias === undefined || alias === '' ? undefined : alias) })
          return
        }
        if (req.method === 'DELETE') {
          const id = queryParam(url, 'id')
          if (id === undefined || id === '') {
            writeJson(res, 400, { error: 'id query parameter is required' })
            return
          }
          writeJson(res, 200, { ok: forwards.stop(id) })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const read = await readBodyOrError<unknown>(req, res, { objectOnly: true })
        if (!read.ok) return
        const validated = validateForwardRequest(read.body)
        if (!validated.ok) {
          writeJson(res, 400, { error: validated.error })
          return
        }
        try {
          writeJson(res, 200, { forward: await forwards.start(validated.value) })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // Caller-actionable refusals get 409: a taken local port, a privileged
          // port this process may not bind, and the per-alias rule ceiling
          // ("already has 16 local forwards; stop one first") — all three are
          // fixed by stopping/changing something locally. Everything else here
          // is the ssh side refusing or failing to connect: 502.
          const local = /EADDRINUSE|EACCES|already in use|already has \d+ local forwards|permission denied|not permitted/i.test(message)
          writeJson(res, local ? 409 : 502, { error: message })
        }
      },
    },
    // ------------------------------------------------ remote listen ports
    {
      kind: 'exact',
      path: REMOTE_API.listenPorts,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = queryParam(url, 'alias')
        if (alias === undefined || alias === '') {
          writeJson(res, 400, { error: 'alias query parameter is required' })
          return
        }
        try {
          const result = await pool.exec(alias, listenPortsCommand(), { timeoutMs: LISTEN_PORTS_TIMEOUT_MS })
          // `exec` answers transport failures as a RESULT; only a real command
          // run can be parsed. A missing tool is the command's own answer
          // (`@@RVS-PORTS none`), not an error.
          if (result.error !== undefined) {
            writeJson(res, 502, { error: result.error })
            return
          }
          // A capped/dead run must not be parsed as a complete one: `timedOut`
          // means the exec deadline cut the command (a partial `ss` table would
          // read as "these are all the ports"), and a null exit code means the
          // channel closed without telling us how the command ended. Both are
          // "cannot enumerate", which the panel renders as an explanation.
          if (result.timedOut) {
            writeJson(res, 200, {
              tool: 'unknown',
              ports: [],
              error: `the remote probe did not finish within ${LISTEN_PORTS_TIMEOUT_MS / 1000}s`,
            })
            return
          }
          if (result.exitCode === null) {
            writeJson(res, 200, {
              tool: 'unknown',
              ports: [],
              error: 'the remote probe ended without an exit status (the SSH channel closed)',
            })
            return
          }
          writeJson(res, 200, parseListenPorts(result.stdout, result.exitCode))
        } catch (error) {
          writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ------------------------------------------------------- host metrics
    // Live CPU/RAM/disk/net/temperature for the monitor panel. One bounded
    // POSIX probe per host (no helper, no Python on the remote); `HostMonitor`
    // caches a sample for a few seconds and diffs the CPU/net counters, so a
    // poll storm costs one channel and the first sample honestly says "unknown"
    // for the two deltas instead of inventing numbers.
    //
    // `alias` selects one host; omitting it samples every configured host (the
    // panel asks per host, so this is a convenience/tooling shape, not a
    // browser fan-out). Loopback-fenced like every other route.
    {
      kind: 'exact',
      path: REMOTE_API.metrics,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = queryParam(url, 'alias')
        const refresh = queryParam(url, 'refresh') === '1'
        if (alias !== undefined && alias !== '' && store.get(alias) === undefined) {
          writeJson(res, 404, { error: `unknown host alias: ${alias}` })
          return
        }
        const aliases = alias === undefined || alias === ''
          ? store.list().map(host => host.alias)
          : [alias]
        try {
          const hosts = await Promise.all(aliases.map(host => monitor.sample(host, refresh)))
          writeJson(res, 200, { hosts })
        } catch (error) {
          writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) })
        }
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
