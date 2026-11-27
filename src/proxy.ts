/**
 * Outbound proxy support for SSH dials.
 *
 * Why this is not just `HTTP_PROXY`: ssh2 dials a raw TCP socket, and the
 * harness's proxy plumbing (`@deepseek-ai/dsh-http-proxy`) only wraps `fetch`,
 * so a host that can only be reached through a proxy needs the tunnel built
 * here. Three flavours, in the order a user meets them:
 *
 *  - `http` — `CONNECT host:port`, optional `Proxy-Authorization: Basic …`;
 *  - `socks5` — greeting / optional user+password sub-negotiation / CONNECT;
 *  - jump (`ProxyJump` / `ProxyCommand ssh -W`) — NOT dialled here: the pool
 *    opens a `direct-tcpip` channel on ANOTHER pooled connection and hands it
 *    to ssh2 as its socket. This module only parses those specs into a target.
 *
 * **Error taxonomy is the point.** "The proxy refused the tunnel" and "the
 * target closed the port" and "your password is wrong" all fail the dial, and
 * the user debugs the wrong thing if they all read "connection failed". Each
 * failure therefore leaves as a `ProxyError` with a stable `reason` and one
 * actionable sentence.
 *
 * **Bytes are never lost.** A proxy may send tunnel bytes in the same packet as
 * its handshake reply; everything read past the handshake is pushed back onto
 * the socket before it is handed to ssh2, or the SSH banner would be swallowed
 * and the handshake would stall.
 *
 * @module
 */
import { createConnection, type Socket } from 'node:net'

/** Proxy flavours this plugin dials itself. A jump host is not one of them. */
export type ProxyKind = 'http' | 'socks5'

/** One validated proxy endpoint (secrets included: host-side only). */
export interface ProxyConfig {
  kind: ProxyKind
  /** Proxy hostname / IPv4 / IPv6 literal. */
  host: string
  port: number
  /** Basic auth (http) or user/password sub-negotiation (socks5). */
  username?: string
  password?: string
}

/** A `ProxyJump` / `ProxyCommand ssh -W` hop, parsed but not yet resolved. */
export interface JumpTarget {
  /** Login user named in the spec, when it had one. */
  user?: string
  host: string
  port: number
}

/** Every way a proxy dial can fail, as a stable value (not a message). */
export type ProxyFailure =
  /** The proxy itself could not be reached (TCP refused/unreachable). */
  | 'unreachable'
  /** The proxy accepted TCP but never finished talking to us. */
  | 'timeout'
  /** The proxy demanded credentials we do not have, or rejected ours. */
  | 'auth'
  /** The proxy answered, and refused the tunnel (bad status / SOCKS reply). */
  | 'refused'
  /** The proxy answered with something that is not the protocol we speak. */
  | 'protocol'
  /** The destination is not a legal target (bad port, empty host). */
  | 'target'

/** A proxy dial failure that knows which layer broke. */
export class ProxyError extends Error {
  constructor(
    readonly reason: ProxyFailure,
    message: string,
    /** Which proxy kind was attempted (absent for target validation). */
    readonly kind?: ProxyKind,
  ) {
    super(message)
    this.name = 'ProxyError'
  }
}

/** Hostname / IPv4 / IPv6 accepted as a proxy or destination. */
const HOST_RE = /^[A-Za-z0-9._:[\]%-]{1,255}$/

/** Longest credential string accepted (a proxy config, not a password manager). */
const MAX_CREDENTIAL = 255

function cleanCredential(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value === '') return undefined
  return value.length > MAX_CREDENTIAL ? value.slice(0, MAX_CREDENTIAL) : value
}

/**
 * Validate one proxy endpoint.
 *
 * @param input - value as it arrived from the browser / store file.
 * @returns the normalized config (empty credentials dropped).
 * @throws {ProxyError} `target` when a field is unusable, with the field named.
 */
export function normalizeProxy(input: unknown): ProxyConfig {
  if (typeof input !== 'object' || input === null) {
    throw new ProxyError('target', 'proxy must be an object')
  }
  const raw = input as Record<string, unknown>
  const kind = raw.kind
  if (kind !== 'http' && kind !== 'socks5') {
    throw new ProxyError('target', "proxy.kind must be 'http' or 'socks5'")
  }
  if (typeof raw.host !== 'string' || !HOST_RE.test(raw.host)) {
    throw new ProxyError('target', 'proxy.host must be a hostname or IP address')
  }
  const port = raw.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProxyError('target', 'proxy.port must be an integer between 1 and 65535')
  }
  const username = cleanCredential(raw.username)
  const password = cleanCredential(raw.password)
  return {
    kind,
    host: raw.host,
    port,
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
  }
}

/** True when a value looks like a proxy config at all (shape, not validity). */
export function looksLikeProxy(value: unknown): boolean {
  return typeof value === 'object' && value !== null
    && ((value as { kind?: unknown }).kind === 'http' || (value as { kind?: unknown }).kind === 'socks5')
}

/** One `user@host:port` hop of a ProxyJump chain. */
function parseHop(token: string): JumpTarget | undefined {
  const at = token.lastIndexOf('@')
  const user = at < 0 ? undefined : token.slice(0, at)
  const rest = at < 0 ? token : token.slice(at + 1)
  if (rest === '') return undefined
  if (rest.includes(' [') || /\s/.test(rest)) return undefined
  let host = rest
  let port = 22
  // A bare IPv6 literal has colons of its own; only `[v6]:port` and
  // `host:port` carry a real port.
  const bracket = /^\[(.+)\]:(\d+)$/.exec(rest)
  if (bracket !== null) {
    host = `[${bracket[1]}]`
    port = Number.parseInt(bracket[2] ?? '', 10)
  } else if (rest.startsWith('[') && rest.endsWith(']')) {
    host = rest
  } else {
    const colon = rest.lastIndexOf(':')
    if (colon > 0) {
      const tail = rest.slice(colon + 1)
      if (/^\d+$/.test(tail)) {
        host = rest.slice(0, colon)
        port = Number.parseInt(tail, 10)
      }
    }
  }
  if (!HOST_RE.test(host)) return undefined
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return { ...(user === undefined || user === '' ? {} : { user }), host, port }
}

/**
 * Parse an OpenSSH `ProxyJump` value (`jump`, `user@jump:2222`, `a,b`).
 *
 * Only a single hop is supported: the pool builds the tunnel on one existing
 * pooled connection, and a chain would need nested channels whose failure modes
 * we cannot explain to the user yet. Multi-hop is therefore a named refusal
 * rather than a silent half-feature.
 */
export function parseProxyJump(value: string): { ok: true; target: JumpTarget } | { ok: false; reason: string } {
  const hops = value.split(',').map(hop => hop.trim()).filter(hop => hop !== '')
  if (hops.length === 0) return { ok: false, reason: 'ProxyJump names no host' }
  if (hops.length > 1) {
    return { ok: false, reason: `ProxyJump with ${hops.length} hops is not supported (one jump host only)` }
  }
  const target = parseHop(hops[0] ?? '')
  if (target === undefined) return { ok: false, reason: 'ProxyJump must look like user@host:port' }
  return { ok: true, target }
}

/** One tokenized ProxyCommand word (quotes dropped, `%h`/`%p` kept verbatim). */
function tokenize(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  for (const char of command) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current !== '') out.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current !== '') out.push(current)
  return out
}

/** `host:port` used by nc/ncat proxy arguments. */
function parseProxyAddress(value: string): { host: string; port: number } | undefined {
  const colon = value.lastIndexOf(':')
  if (colon <= 0) return undefined
  const host = value.slice(0, colon)
  const port = Number.parseInt(value.slice(colon + 1), 10)
  if (!HOST_RE.test(host)) return undefined
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return { host, port }
}

/** What a `ProxyCommand` line means to this plugin. */
export type ProxyCommandPlan =
  | { kind: 'proxy'; proxy: Omit<ProxyConfig, 'username' | 'password'> }
  | { kind: 'jump'; target: JumpTarget }
  | { kind: 'unsupported'; reason: string }

/**
 * Map the ProxyCommand forms users actually write onto a tunnel we can build.
 *
 * Recognised: `ssh … -W %h:%p [user@]host`, `nc -X connect -x host:port %h %p`
 * (http), `nc -x host:port %h %p` (socks5), `ncat --proxy … --proxy-type …`.
 * Everything else is refused by name — a ProxyCommand is a shell command, and
 * running one from a browser-supplied config is not a feature this plugin
 * offers.
 */
export function parseProxyCommand(command: string): ProxyCommandPlan {
  const words = tokenize(command)
  if (words.length === 0) return { kind: 'unsupported', reason: 'ProxyCommand is empty' }
  const program = (words[0] ?? '').split(/[\\/]/).pop() ?? ''
  if (program === 'ssh') {
    /**
     * `ssh -W %h:%p bastion` — the canonical ProxyCommand — puts the DESTINATION
     * in `-W`'s argument and the JUMP HOST in the positional argument. Reading
     * `-W`'s value as the jump host is the mistake this loop exists to avoid:
     * it is always the literal `%h:%p`.
     */
    let forwards = false
    let user: string | undefined
    let port: number | undefined
    let destination: string | undefined
    for (let index = 1; index < words.length; index += 1) {
      const word = words[index] ?? ''
      if (word === '-W' || word.startsWith('-W')) {
        forwards = true
        // `-W` takes `%h:%p` (what to forward), never the jump host. OpenSSH also
        // accepts the value attached (`ssh -W%h:%p bastion`), which is one word.
        if (word === '-W') index += 1
        continue
      }
      // Options that consume a following value we do not need.
      if (word === '-l' || word === '-p' || word === '-o' || word === '-i' || word === '-F' || word === '-J') {
        const value = words[index + 1]
        if (word === '-l') user = value
        if (word === '-p') {
          const parsedPort = Number.parseInt(value ?? '', 10)
          if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535) port = parsedPort
        }
        index += 1
        continue
      }
      if (word.startsWith('-')) continue
      destination ??= word
    }
    if (!forwards) return { kind: 'unsupported', reason: 'ProxyCommand ssh must use -W %h:%p' }
    if (destination === undefined) return { kind: 'unsupported', reason: 'ProxyCommand ssh -W names no jump host' }
    const parsed = parseHop(user === undefined || user === '' ? destination : `${user}@${destination}`)
    if (parsed === undefined) {
      return { kind: 'unsupported', reason: 'ProxyCommand ssh -W: the jump host is not a host name' }
    }
    return { kind: 'jump', target: { ...parsed, ...(port === undefined ? {} : { port }) } }
  }
  if (program === 'nc' || program === 'netcat') {
    const x = words.indexOf('-X')
    const xMode = x < 0 ? undefined : (words[x + 1] ?? '')
    const dash = words.indexOf('-x')
    const address = dash < 0 ? undefined : parseProxyAddress(words[dash + 1] ?? '')
    if (address === undefined) return { kind: 'unsupported', reason: 'ProxyCommand nc must name a proxy with -x host:port' }
    if (xMode === 'connect' || xMode === 'http') return { kind: 'proxy', proxy: { kind: 'http', ...address } }
    if (xMode === undefined || xMode === '5' || xMode === 'socks5') {
      return { kind: 'proxy', proxy: { kind: 'socks5', ...address } }
    }
    return { kind: 'unsupported', reason: `ProxyCommand nc -X ${xMode} is not supported` }
  }
  if (program === 'ncat') {
    const at = words.indexOf('--proxy')
    const address = at < 0 ? undefined : parseProxyAddress(words[at + 1] ?? '')
    if (address === undefined) return { kind: 'unsupported', reason: 'ProxyCommand ncat must name --proxy host:port' }
    const typeAt = words.indexOf('--proxy-type')
    const type = typeAt < 0 ? 'http' : (words[typeAt + 1] ?? 'http')
    if (type === 'http') return { kind: 'proxy', proxy: { kind: 'http', ...address } }
    if (type === 'socks5') return { kind: 'proxy', proxy: { kind: 'socks5', ...address } }
    return { kind: 'unsupported', reason: `ProxyCommand ncat --proxy-type ${type} is not supported` }
  }
  return {
    kind: 'unsupported',
    reason: `ProxyCommand program ${program === '' ? '(none)' : program} is not supported`
      + ' (only ssh -W, nc -X connect -x and ncat --proxy)',
  }
}

/** How this module reaches a TCP socket (a seam for the gates). */
export type SocketFactory = (host: string, port: number) => Socket

/** One tunnel request. */
export interface OpenProxyOptions {
  /** Total budget for connect + handshake (default 8000 ms). */
  timeoutMs?: number
  /** Test seam: replaces `net.createConnection`. */
  connect?: SocketFactory
}

/** Default budget: a proxy that cannot answer in this long is not worth waiting for. */
export const PROXY_TIMEOUT_MS = 8_000

/** Buffered reads over one socket, keeping every byte it saw. */
class Reader {
  private buffer = Buffer.alloc(0)
  private waiter: (() => void) | undefined
  private ended = false
  private failure: Error | undefined
  /** Bound handlers, kept so `detach` can remove exactly what was added. */
  private readonly onData = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk])
    this.wake()
  }

  private readonly onError = (error: Error): void => {
    this.failure = error
    this.wake()
  }

  private readonly onClose = (): void => {
    this.ended = true
    this.wake()
  }

  constructor(private readonly socket: Socket) {
    socket.on('data', this.onData)
    socket.once('error', this.onError)
    socket.once('close', this.onClose)
  }

  private wake(): void {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }

  /** Wait for more bytes; false when the socket closed or failed. */
  private async more(): Promise<void> {
    if (this.failure !== undefined) throw this.failure
    if (this.ended) return
    await new Promise<void>((resolve) => { this.waiter = resolve })
  }

  /** Read until `marker` inclusive (used for the HTTP header block). */
  async until(marker: string): Promise<Buffer> {
    for (;;) {
      const at = this.buffer.indexOf(marker)
      if (at >= 0) {
        const end = at + marker.length
        const head = this.buffer.subarray(0, end)
        this.buffer = this.buffer.subarray(end)
        return head
      }
      await this.more()
      if (this.failure !== undefined) throw this.failure
      if (this.ended) throw new ProxyError('protocol', 'the proxy closed the tunnel before answering')
    }
  }

  /** Read exactly `count` bytes (SOCKS replies). */
  async exact(count: number): Promise<Buffer> {
    for (;;) {
      if (this.buffer.length >= count) {
        const head = this.buffer.subarray(0, count)
        this.buffer = this.buffer.subarray(count)
        return head
      }
      await this.more()
      if (this.failure !== undefined) throw this.failure
      if (this.ended) throw new ProxyError('protocol', 'the proxy closed the tunnel before answering')
    }
  }

  /** Push back tunnel bytes that arrived with the handshake reply. */
  release(): void {
    if (this.buffer.length > 0) {
      const leftover = this.buffer
      this.buffer = Buffer.alloc(0)
      this.socket.unshift(leftover)
    }
  }

  /**
   * Stop observing the socket after a successful handshake.
   *
   * Without this the `data` listener keeps appending every tunnelled byte to
   * `buffer` for the whole life of the connection — an unbounded leak on an SSH
   * session that moves a few files. The socket belongs to the caller from here on
   * (ssh2 becomes its only reader).
   *
   * Called BEFORE `release()`: an attached `data` listener would immediately
   * consume the pushed-back bytes into `buffer` again, and the handover would lose
   * the SSH banner it just rescued.
   */
  detach(): void {
    this.socket.off('data', this.onData)
    this.socket.off('error', this.onError)
    this.socket.off('close', this.onClose)
  }
}

/** The four octets of a dotted-quad IPv4 literal, or `undefined`. */
function ipv4Octets(value: string): number[] | undefined {
  const parts = value.split('.')
  if (parts.length !== 4) return undefined
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const octet = Number.parseInt(part, 10)
    if (octet > 255) return undefined
    octets.push(octet)
  }
  return octets
}

/**
 * Expand one IPv6 literal into its eight 16-bit groups, or `undefined`.
 *
 * A SOCKS5 CONNECT carries the target as BYTES, so the literal has to be
 * expanded before it is encoded — and `::` is what makes that non-obvious. The
 * first cut appended a single `'0'` group wherever the text was short, so every
 * compressed form encoded a DIFFERENT address than it names (`2001:db8::1` became
 * `2001:db8:0:0:1:0:0:0`, `::1` became `0:0:0:1:0:0:0:0`): the tunnel opened,
 * nothing errored, and the dial reached a host nobody asked for. Handing back
 * `undefined` for an unexpandable literal is the point — the caller refuses the
 * dial instead of encoding something.
 *
 * Accepted: exactly one `::` anywhere (leading / middle / trailing), eight
 * explicit groups when there is no `::`, and a dotted IPv4 in the LAST group
 * (RFC 4291 §2.2.3, e.g. `::ffff:1.2.3.4`). Two `::`, too many or too few
 * groups, bad hex and a bad quad are all `undefined`, never a guess.
 */
function expandIPv6(value: string): number[] | undefined {
  const halves = value.split('::')
  if (halves.length > 2) return undefined
  const compressed = halves.length === 2
  const readGroups = (part: string | undefined): number[] | undefined => {
    if (part === undefined || part === '') return []
    const groups = part.split(':')
    const out: number[] = []
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index] as string
      if (group.includes('.')) {
        // A dotted quad may only be the LAST group of the whole literal.
        if (index !== groups.length - 1) return undefined
        const octets = ipv4Octets(group)
        if (octets === undefined) return undefined
        const [a = 0, b = 0, c = 0, d = 0] = octets
        out.push((a << 8) | b, (c << 8) | d)
        continue
      }
      if (!/^[0-9A-Fa-f]{1,4}$/.test(group)) return undefined
      out.push(Number.parseInt(group, 16))
    }
    return out
  }
  const head = readGroups(halves[0])
  const tail = compressed ? readGroups(halves[1]) : []
  if (head === undefined || tail === undefined) return undefined
  const explicit = head.length + tail.length
  if (!compressed) return explicit === 8 ? head : undefined
  // `::` must stand for at least ONE zero group: `1:2:3:4:5:6:7:8::` is invalid.
  if (explicit > 7) return undefined
  return [...head, ...Array.from({ length: 8 - explicit }, () => 0), ...tail]
}

/** Encode one SOCKS5 target address (domain / IPv4 / IPv6). */
function socksAddress(host: string, port: number): Buffer {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  const portBytes = Buffer.alloc(2)
  portBytes.writeUInt16BE(port, 0)
  const octets = ipv4Octets(bare)
  if (octets !== undefined) {
    return Buffer.concat([Buffer.from([0x01]), Buffer.from(octets), portBytes])
  }
  if (bare.includes(':')) {
    const groups = expandIPv6(bare)
    if (groups === undefined) {
      // Encoding it as a DOMAIN NAME would silently dial a host the user did not
      // name, which is exactly how the compressed-form bug above behaved.
      // A scoped literal (`fe80::1%eth0`) is refused for a real reason — a zone
      // id means nothing once the bytes leave this machine — so say that rather
      // than calling a well-formed address "invalid".
      throw new ProxyError(
        'target',
        bare.includes('%')
          ? `destination ${JSON.stringify(host)} is scoped (link-local); SOCKS5 cannot carry a zone id`
          : `destination ${JSON.stringify(host)} is not a valid IPv6 address`,
        'socks5',
      )
    }
    const bytes = groups.flatMap(group => [(group >> 8) & 0xff, group & 0xff])
    return Buffer.concat([Buffer.from([0x04]), Buffer.from(bytes), portBytes])
  }
  const name = Buffer.from(bare, 'utf8')
  return Buffer.concat([Buffer.from([0x03, name.length]), name, portBytes])
}

/** One SOCKS5 reply code as an actionable failure. */
function socksReplyError(code: number): ProxyError {
  switch (code) {
    case 0x02: return new ProxyError('refused', 'the proxy does not allow this connection (SOCKS5 rule denied)', 'socks5')
    case 0x03: return new ProxyError('refused', 'the proxy cannot reach the network (SOCKS5: network unreachable)', 'socks5')
    case 0x04: return new ProxyError('refused', 'the proxy cannot reach the host (SOCKS5: host unreachable)', 'socks5')
    case 0x05: return new ProxyError('refused', 'the connection was refused by the target host (via SOCKS5)', 'socks5')
    case 0x06: return new ProxyError('refused', 'the connection timed out at the proxy (SOCKS5: TTL expired)', 'socks5')
    case 0x07: return new ProxyError('refused', 'the proxy does not support CONNECT (SOCKS5: command not supported)', 'socks5')
    case 0x08: return new ProxyError('protocol', 'the proxy does not accept this address type (SOCKS5)', 'socks5')
    default: return new ProxyError('refused', `the proxy refused the tunnel (SOCKS5 reply ${code})`, 'socks5')
  }
}

/**
 * Dial `host:port` through `proxy` and hand back the tunnelled socket.
 *
 * The caller owns the socket (ssh2 takes it as its transport). Everything read
 * past the handshake is pushed back, so the SSH banner is not swallowed.
 *
 * @throws {ProxyError} when the proxy layer — not SSH — is what failed.
 */
export async function openProxySocket(
  proxy: ProxyConfig,
  host: string,
  port: number,
  options: OpenProxyOptions = {},
): Promise<Socket> {
  if (host === '' || !HOST_RE.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProxyError('target', `destination must be host:port, got ${JSON.stringify(`${host}:${port}`)}`)
  }
  const budget = options.timeoutMs ?? PROXY_TIMEOUT_MS
  const connect = options.connect ?? ((target, targetPort) => createConnection({ host: target, port: targetPort }))
  const socket = connect(proxy.host, proxy.port)
  const reader = new Reader(socket)
  const timer = setTimeout(() => {
    socket.destroy(new ProxyError('timeout', `the proxy ${proxy.host}:${proxy.port} did not answer within ${budget / 1000}s`, proxy.kind))
  }, budget)
  timer.unref?.()
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', (error: Error) => {
        const code = (error as NodeJS.ErrnoException).code
        const unreachable = code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH'
          || code === 'EACCES' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ETIMEDOUT'
        reject(unreachable
          ? new ProxyError('unreachable', `cannot reach the proxy ${proxy.host}:${proxy.port} (${code ?? error.message})`, proxy.kind)
          : error)
      })
    })
    if (proxy.kind === 'http') await httpTunnel(socket, reader, proxy, host, port)
    else await socks5Tunnel(socket, reader, proxy, host, port)
    reader.detach()
    reader.release()
    return socket
  } catch (error) {
    try {
      socket.destroy()
    } catch {
      // Already gone.
    }
    throw error instanceof ProxyError ? error : new ProxyError('protocol', error instanceof Error ? error.message : String(error), proxy.kind)
  } finally {
    clearTimeout(timer)
  }
}

/** HTTP CONNECT: one request line, optional Basic auth, then a 2xx. */
async function httpTunnel(
  socket: Socket,
  reader: Reader,
  proxy: ProxyConfig,
  host: string,
  port: number,
): Promise<void> {
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]:${port}` : `${host}:${port}`
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`]
  if (proxy.username !== undefined) {
    const token = Buffer.from(`${proxy.username}:${proxy.password ?? ''}`, 'utf8').toString('base64')
    lines.push(`Proxy-Authorization: Basic ${token}`)
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)
  const head = (await reader.until('\r\n\r\n')).toString('latin1')
  const statusLine = head.split('\r\n')[0] ?? ''
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine)
  if (match === null) {
    throw new ProxyError('protocol', `the proxy did not answer with HTTP (got ${JSON.stringify(statusLine.slice(0, 60))})`, 'http')
  }
  const status = Number.parseInt(match[1] ?? '', 10)
  if (status === 200 || status === 201) return
  if (status === 407) {
    throw new ProxyError(
      'auth',
      proxy.username === undefined
        ? 'the proxy requires a username and password (HTTP 407)'
        : 'the proxy rejected the username and password (HTTP 407)',
      'http',
    )
  }
  if (status === 403) throw new ProxyError('refused', 'the proxy refused this destination (HTTP 403)', 'http')
  if (status === 405) throw new ProxyError('refused', 'the proxy does not allow CONNECT (HTTP 405)', 'http')
  if (status === 502 || status === 503 || status === 504) {
    throw new ProxyError('refused', `the proxy could not reach ${authority} (HTTP ${status})`, 'http')
  }
  throw new ProxyError('refused', `the proxy refused the tunnel (HTTP ${status})`, 'http')
}

/** SOCKS5: greeting, optional user/password, CONNECT, reply. */
async function socks5Tunnel(
  socket: Socket,
  reader: Reader,
  proxy: ProxyConfig,
  host: string,
  port: number,
): Promise<void> {
  const wantsAuth = proxy.username !== undefined
  socket.write(Buffer.from(wantsAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]))
  const greeting = await reader.exact(2)
  if (greeting[0] !== 0x05) {
    throw new ProxyError('protocol', 'the proxy did not answer SOCKS5 (version byte mismatch)', 'socks5')
  }
  const method = greeting[1]
  if (method === 0xff) {
    throw new ProxyError(
      'auth',
      wantsAuth ? 'the proxy rejected the offered SOCKS5 auth methods' : 'the proxy requires SOCKS5 username/password',
      'socks5',
    )
  }
  if (method === 0x02) {
    if (proxy.username === undefined) {
      throw new ProxyError('auth', 'the proxy requires a SOCKS5 username and password', 'socks5')
    }
    const user = Buffer.from(proxy.username, 'utf8').subarray(0, 255)
    const pass = Buffer.from(proxy.password ?? '', 'utf8').subarray(0, 255)
    socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]))
    const reply = await reader.exact(2)
    if (reply[0] !== 0x01 || reply[1] !== 0x00) {
      throw new ProxyError('auth', 'the proxy rejected the SOCKS5 username and password', 'socks5')
    }
  } else if (method !== 0x00) {
    throw new ProxyError('protocol', `the proxy chose an unknown SOCKS5 auth method (${method})`, 'socks5')
  }
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), socksAddress(host, port)]))
  const head = await reader.exact(4)
  if (head[0] !== 0x05) throw new ProxyError('protocol', 'the proxy answered SOCKS5 CONNECT with a bad version', 'socks5')
  const code = head[1] ?? 0
  const atyp = head[3]
  const addressBytes = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? (await reader.exact(1))[0] ?? 0 : -1
  if (addressBytes < 0) throw new ProxyError('protocol', 'the proxy answered SOCKS5 with an unknown address type', 'socks5')
  await reader.exact(addressBytes + 2)
  if (code !== 0x00) throw socksReplyError(code)
}
