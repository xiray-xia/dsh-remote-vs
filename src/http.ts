/**
 * Small JSON body/response helpers for the /api/dsh-remote route family.
 */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { drainHostNotices, takeHostNotices, type HostNotice } from './notices.ts'
import { DeadlineError } from './timeouts.ts'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
} satisfies OutgoingHttpHeaders

/**
 * Extra bytes a too-large body may stream past its cap before the socket is
 * dropped. Draining the rest keeps the caller's error response readable; the
 * hard stop below refuses to read an unbounded body from a stuck/hostile client.
 */
const DRAIN_LIMIT_BYTES = 8 * 1024 * 1024

/**
 * Outcome of one bounded body read.
 *
 * The discriminant exists because `null` collapsed three very different cases
 * (empty, malformed, too large) into one, and the caller could only answer them
 * all the same way. `too-large` is what a 413 should be built from.
 */
export type JsonBodyResult =
  | { kind: 'ok'; value: unknown }
  | { kind: 'empty' }
  | { kind: 'invalid' }
  | { kind: 'too-large'; maxBytes: number }

/**
 * Bounded body reader with a truthful outcome.
 *
 * Oversize no longer destroys the request immediately: returning early from the
 * `for await` loop would tear the socket down, and the caller's 400/413 then
 * reaches the client as a connection reset (the reported A11 symptom). The body
 * is drained instead, up to `DRAIN_LIMIT_BYTES`, so the route can answer with a
 * readable JSON error; an absurd stream is still cut off with `destroy()`.
 */
export async function readJsonBodyResult(
  req: IncomingMessage,
  opts: { maxBytes?: number; objectOnly?: boolean } = {},
): Promise<JsonBodyResult> {
  const maxBytes = opts.maxBytes ?? 64 * 1024
  const chunks: Buffer[] = []
  let size = 0
  let tooLarge = false
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (!tooLarge && size > maxBytes) {
      // Stop buffering at the cap; keep consuming so the connection stays usable.
      tooLarge = true
      chunks.length = 0
    }
    if (tooLarge) {
      if (size > maxBytes + DRAIN_LIMIT_BYTES) {
        req.destroy()
        return { kind: 'too-large', maxBytes }
      }
      continue
    }
    chunks.push(buffer)
  }
  if (tooLarge) return { kind: 'too-large', maxBytes }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return { kind: 'empty' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'invalid' }
  }
  if (opts.objectOnly === true && !isJsonObject(parsed)) return { kind: 'invalid' }
  return { kind: 'ok', value: parsed }
}

/**
 * Lenient bounded body reader: parse a request body as JSON, or null on an
 * empty body, invalid JSON, or a body past maxBytes (default 64 KiB).
 *
 * Facade over {@link readJsonBodyResult} for the existing route call sites; new
 * code should use the result form so `too-large` can be answered with a 413.
 */
export async function readJsonBody(
  req: IncomingMessage,
  opts: { maxBytes?: number; objectOnly?: boolean } = {},
): Promise<unknown | null> {
  const result = await readJsonBodyResult(req, opts)
  return result.kind === 'ok' ? result.value : null
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The host alias one response is about (consumed by {@link writeJson}).
 *
 * A response may only carry news about the host it concerns, otherwise one
 * window shows another window's silent helper push and the queue loses it for
 * the window that caused it. `null` is the explicit "about no single host"
 * answer (a hosts/workspaces listing): it leaves the queue alone. An untouched
 * response keeps the historical drain-all answer — only this plugin's route
 * table marks its responses, and every route states what it is about.
 */
const noticeAliasOf = new WeakMap<ServerResponse, string | null>()

/** Declare which host the response being written concerns (`null` = no host). */
export function scopeHostNotices(res: ServerResponse, alias: string | null): void {
  noticeAliasOf.set(res, alias === '' ? null : alias)
}

/** The notices this response may carry and consume. */
function noticesFor(res: ServerResponse, attachable: boolean, status: number): HostNotice[] {
  // A failed response is never read by the client's notice dispatcher, so
  // draining into it would silently drop the notice; leave it queued for the
  // next successful response about the same host.
  if (!attachable || status >= 400) return []
  if (!noticeAliasOf.has(res)) return drainHostNotices()
  const alias = noticeAliasOf.get(res)
  return typeof alias === 'string' && alias !== '' ? takeHostNotices(alias) : []
}

/** Write one JSON response. */
export function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: OutgoingHttpHeaders = {},
): void {
  // Piggyback Host notices (an automatic helper push happened during this
  // request) on any plain-object body: the browser's API wrapper renders them
  // after parsing, so the user learns about the push without opening Settings.
  // Only the host-scoped ones ride along (see `scopeHostNotices`): the browser
  // toasts them in the window that made the request, so a critical detail is
  // that the request is about that host. Arrays and scalars cannot carry extra
  // keys — their notices stay queued for the next object response instead of
  // being silently dropped.
  const attachable = typeof body === 'object' && body !== null && !Array.isArray(body)
  const notices = noticesFor(res, attachable, status)
  const payload = notices.length > 0
    ? { ...body as Record<string, unknown>, notices }
    : body
  res.writeHead(status, { ...JSON_HEADERS, ...headers })
  res.end(JSON.stringify(payload))
}

/**
 * Write one failed-operation response, tagging a budget that merely ran out.
 *
 * `code: 'deadline'` is what lets the browser tell "this one request was too
 * slow" from "the link is down": the client keeps the status chip green and the
 * editor editable, while the operation still fails with a readable reason. Only
 * the error object carries that distinction — the message is prose, and matching
 * on prose stops working the moment the sentence changes.
 */
export function writeRouteError(res: ServerResponse, error: unknown): void {
  writeJson(res, 502, {
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof DeadlineError ? { code: 'deadline' } : {}),
  })
}
