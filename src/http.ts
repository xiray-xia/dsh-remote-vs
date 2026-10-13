/**
 * Small JSON body/response helpers for the /api/dsh-remote route family.
 */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
} satisfies OutgoingHttpHeaders

/**
 * Lenient bounded body reader: parse a request body as JSON, or null on an
 * empty body, invalid JSON, or a body past maxBytes (default 64 KiB).
 */
export async function readJsonBody(
  req: IncomingMessage,
  opts: { maxBytes?: number; objectOnly?: boolean } = {},
): Promise<unknown | null> {
  const maxBytes = opts.maxBytes ?? 64 * 1024
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) {
      req.destroy()
      return null
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (opts.objectOnly && !isJsonObject(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Write one JSON response. */
export function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: OutgoingHttpHeaders = {},
): void {
  res.writeHead(status, { ...JSON_HEADERS, ...headers })
  res.end(JSON.stringify(body))
}
