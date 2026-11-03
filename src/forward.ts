/**
 * Local TCP port forwards (`ssh -L` semantics) for the port panel.
 *
 * Design contract (see `docs/.feasibility/ports.md` for the reasoning):
 *
 *  - **The listener is the resident object; every accepted TCP connection opens
 *    its own `direct-tcpip` channel.** That is what makes the feature compose
 *    with the rest of the plugin: the pool's 30-minute idle eviction, a host
 *    edit/delete (`drop`), and an `sync()`-driven route re-registration all
 *    leave the listener alone, and the next local connection simply re-dials
 *    through `RemotePool.forwardOut`.
 *  - **Loopback only.** The listener binds `127.0.0.1`, never `0.0.0.0`: this is
 *    `ssh -L`, so reach = the local machine's trust domain. `Expose on the LAN`
 *    is a different product decision and would need its own confirmation.
 *  - **Its own channel budget, not the pool's slot table.** Forward channels are
 *    long-lived by nature (a browser alone opens several per page); the pool's
 *    `CHANNEL_LIMIT` deliberately excludes long-lived channels from its own
 *    accounting, so the manager bounds them per alias and per rule instead of
 *    starving git/SFTP/terminal traffic.
 *  - **A failed connection is the RULE's error, not the link's.** A closed
 *    remote port or `AllowTcpForwarding no` must not paint the connection chip
 *    red; the row says which rule failed and the next attempt retries.
 *
 * The manager is deliberately not a cordis service: only this plugin's routes
 * consume it. It gets a fiber-scoped effect in `index.ts` so a settings-driven
 * route rebuild cannot tear down live forwards.
 */
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import type { ClientChannel } from 'ssh2'
import type { RemoteForwardRequest, RemoteForwardState } from './protocol.ts'

/** Most simultaneous forward rules one host may carry. */
export const FORWARD_MAX_PER_ALIAS = 16

/** Most TCP connections one rule accepts at once (browsers open several). */
export const FORWARD_MAX_CONNECTIONS = 32

/** What every forward binds to (never a LAN address). */
const LOOPBACK = '127.0.0.1'

/**
 * The pool surface the manager needs.
 *
 * Structural on purpose: the gate drives a fake pool without an SSH server, and
 * the manager never reaches into the pool beyond one call.
 */
export interface ForwardPoolLike {
  forwardOut(alias: string, dstHost: string, dstPort: number, srcPort?: number): Promise<ClientChannel>
}

export interface ForwardManagerDeps {
  pool: ForwardPoolLike
  /** Diagnostic sink; defaults to a no-op (the Host wires its logger). */
  log?: (level: 'info' | 'warn', message: string) => void
  /** Test seam: bound rules per alias. */
  maxPerAlias?: number
  /** Test seam: concurrent connections per rule. */
  maxConnections?: number
}

/** One validated rule request. */
export type ForwardValidation =
  | { ok: true; value: RemoteForwardRequest }
  | { ok: false; error: string }

/** Alias grammar (same rule the host store enforces). */
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * Hostname / IPv4 / IPv6 accepted as the REMOTE target.
 *
 * The string never reaches a shell — ssh2 hands it to the server as the
 * direct-tcpip destination — so this is a sanity fence (no whitespace, no
 * control characters, bounded length) rather than escaping. A hostname with
 * underscores and an IPv6 literal with brackets are both legal here.
 */
const REMOTE_HOST_RE = /^[A-Za-z0-9._:[\]%-]{1,255}$/

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '')
}

/**
 * Validate one request from the browser.
 *
 * `localPort` deliberately accepts 0 = "let the OS pick": the panel defaults to
 * auto-assignment because a fixed port invites EADDRINUSE from whatever else
 * the developer runs locally.
 */
export function validateForwardRequest(input: unknown): ForwardValidation {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'a JSON object is required' }
  const raw = input as Record<string, unknown>
  if (typeof raw.alias !== 'string' || !ALIAS_RE.test(raw.alias)) {
    return { ok: false, error: 'alias must be 1-64 chars of letters/digits/._- and start with an alphanumeric' }
  }
  if (typeof raw.remoteHost !== 'string' || !REMOTE_HOST_RE.test(raw.remoteHost)) {
    return { ok: false, error: 'remoteHost must be a hostname or IP address' }
  }
  const remotePort = raw.remotePort
  if (typeof remotePort !== 'number' || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    return { ok: false, error: 'remotePort must be an integer between 1 and 65535' }
  }
  const localRaw = raw.localPort
  let localPort = 0
  if (localRaw !== undefined && localRaw !== null) {
    if (typeof localRaw !== 'number' || !Number.isInteger(localRaw) || localRaw < 0 || localRaw > 65535) {
      return { ok: false, error: 'localPort must be 0 (auto) or an integer between 1 and 65535' }
    }
    localPort = localRaw
  }
  return {
    ok: true,
    value: {
      alias: raw.alias,
      remoteHost: raw.remoteHost,
      remotePort,
      ...(localPort === 0 ? {} : { localPort }),
    },
  }
}

/**
 * Stable rule identity.
 *
 * `localPort` is the port the CALLER asked for (0 = auto), not the one the OS
 * assigned: asking twice for the same automatic rule must return the running
 * forward instead of opening a second listener on a second random port.
 */
export function forwardIdOf(alias: string, remoteHost: string, remotePort: number, localPort: number): string {
  return `${alias}|${remoteHost}|${remotePort}|${localPort}`
}

/** What the panel copies / opens for one forward. */
export function forwardLocalUrl(localPort: number): string {
  return `http://127.0.0.1:${localPort}/`
}

interface Forward {
  id: string
  alias: string
  remoteHost: string
  remotePort: number
  localPort: number
  server: Server
  sockets: Set<Socket>
  channels: Set<ClientChannel>
  bytesIn: number
  bytesOut: number
  lastError: string | undefined
  startedAt: number
}

/** Listens on loopback and proxies every accepted connection over SSH. */
export class ForwardManager {
  private readonly forwards = new Map<string, Forward>()
  /**
   * Rules whose listener is still BINDING.
   *
   * Two clicks (or a restore racing the panel's own poll) must share one bind:
   * without this map the second call binds a SECOND listener on a different
   * automatic port, overwrites the first entry in `forwards`, and leaves the
   * first listener orphaned — unreachable from the panel and never closed.
   */
  private readonly starting = new Map<string, Promise<RemoteForwardState>>()
  /** Set on unload so a bind that settles afterwards closes itself. */
  private disposed = false

  constructor(private readonly deps: ForwardManagerDeps) {}

  /**
   * Start one rule (idempotent for the same requested tuple).
   *
   * Resolves with the state once the local listener is BOUND; a bind failure
   * (EADDRINUSE, permission) rejects, which the route maps to a caller-visible
   * status. A remote-side failure cannot be known yet — the first connection
   * discovers it and records it on the rule.
   */
  async start(request: RemoteForwardRequest): Promise<RemoteForwardState> {
    const requestedLocalPort = request.localPort ?? 0
    const id = forwardIdOf(request.alias, request.remoteHost, request.remotePort, requestedLocalPort)
    const existing = this.forwards.get(id)
    if (existing !== undefined) return this.stateOf(existing)
    const inFlight = this.starting.get(id)
    if (inFlight !== undefined) return inFlight
    const pendingOnAlias = [...this.starting.keys()].filter(key => key.startsWith(`${request.alias}|`)).length
    const perAlias = [...this.forwards.values()].filter(forward => forward.alias === request.alias).length + pendingOnAlias
    const maxPerAlias = this.deps.maxPerAlias ?? FORWARD_MAX_PER_ALIAS
    if (perAlias >= maxPerAlias) {
      throw new Error(`host ${request.alias} already has ${maxPerAlias} local forwards; stop one first`)
    }
    const pending = this.bindForward(id, request, requestedLocalPort).then((forward) => {
      // Unloaded while the bind was in flight: nobody can ever stop this
      // listener, so it closes itself instead of leaking.
      if (this.disposed) {
        this.closeForward(forward)
        throw new Error('the port-forward manager was unloaded while the rule was binding')
      }
      this.forwards.set(id, forward)
      this.log('info', `forward ${id} listening on 127.0.0.1:${forward.localPort}`)
      return this.stateOf(forward)
    }).finally(() => {
      this.starting.delete(id)
    })
    this.starting.set(id, pending)
    return pending
  }

  /** Stop one rule. Returns false when the id is unknown (already stopped). */
  stop(id: string): boolean {
    const forward = this.forwards.get(id)
    if (forward === undefined) return false
    this.forwards.delete(id)
    this.closeForward(forward)
    this.log('info', `forward ${id} stopped`)
    return true
  }

  /**
   * Stop every rule for one host alias (the host was deleted).
   *
   * A deleted host disappears from the panel — there is no row left to press
   * "stop" on — so leaving its listeners bound would squat the local ports
   * until the Host restarts. Returns how many rules were closed.
   */
  stopAlias(alias: string): number {
    let stopped = 0
    for (const [id, forward] of [...this.forwards]) {
      if (forward.alias !== alias) continue
      this.forwards.delete(id)
      this.closeForward(forward)
      stopped += 1
    }
    if (stopped > 0) this.log('info', `stopped ${stopped} forward(s) for deleted host ${alias}`)
    return stopped
  }

  /**
   * Stop every rule but keep the manager alive (plugin disabled).
   *
   * `dispose()` is the unload path and flips a flag that makes later binds
   * throw; a settings toggle needs the listeners gone without burning the
   * instance, because re-enabling the plugin must be able to start rules again.
   */
  stopAll(): number {
    let stopped = 0
    for (const id of [...this.forwards.keys()]) {
      if (this.stop(id)) stopped += 1
    }
    return stopped
  }

  /** Every rule, optionally narrowed to one host alias. */
  list(alias?: string): RemoteForwardState[] {
    const all = [...this.forwards.values()]
      .filter(forward => alias === undefined || forward.alias === alias)
      .sort((left, right) => left.alias.localeCompare(right.alias) || left.localPort - right.localPort)
    return all.map(forward => this.stateOf(forward))
  }

  /** Close every listener and every proxied connection (plugin unload). */
  dispose(): void {
    this.disposed = true
    for (const id of [...this.forwards.keys()]) this.stop(id)
  }

  /** Bind the loopback listener. Split out so the error path is one place. */
  private async bindForward(id: string, request: RemoteForwardRequest, requestedLocalPort: number): Promise<Forward> {
    const server = createServer()
    const forward: Forward = {
      id,
      alias: request.alias,
      remoteHost: request.remoteHost,
      remotePort: request.remotePort,
      localPort: 0,
      server,
      sockets: new Set(),
      channels: new Set(),
      bytesIn: 0,
      bytesOut: 0,
      lastError: undefined,
      startedAt: Date.now(),
    }
    server.on('connection', (socket) => { this.accept(forward, socket) })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      // Loopback only — see the module docstring. `requestedLocalPort === 0`
      // lets the OS assign, and the actual port is read back below.
      server.listen(requestedLocalPort, LOOPBACK)
    })
    forward.localPort = (server.address() as AddressInfo).port
    // Errors AFTER a successful bind (rare: the listener never fails on its
    // own, but a platform may emit one) must not throw into nothing.
    server.on('error', (error) => {
      forward.lastError = messageOf(error)
      this.log('warn', `forward ${id} listener error: ${forward.lastError}`)
    })
    return forward
  }

  /** One accepted local TCP connection: bound, or refused when the rule is full. */
  private accept(forward: Forward, socket: Socket): void {
    const maxConnections = this.deps.maxConnections ?? FORWARD_MAX_CONNECTIONS
    if (forward.sockets.size >= maxConnections) {
      forward.lastError = `too many simultaneous connections (limit ${maxConnections}); close one and retry`
      this.log('warn', `forward ${forward.id}: ${forward.lastError}`)
      socket.destroy()
      return
    }
    forward.sockets.add(socket)
    /**
     * A reset in the DIAL WINDOW must never crash the Host.
     *
     * `finish` — the handler that owns the socket/channel pair and absorbs both
     * errors — is attached only AFTER a channel exists. A cold dial takes
     * seconds (up to the 15 s channel-open deadline), and a client that resets
     * in that window emits `error` on a socket with no listener: Node turns
     * that into an `uncaughtException`, and the DSH Host exits on those. This
     * accept-time handler ends the local half; the later `finish` closes the
     * channel if the dial wins the race.
     */
    const dropSocket = (): void => {
      forward.sockets.delete(socket)
      socket.destroy()
    }
    socket.once('close', dropSocket)
    socket.once('error', dropSocket)
    void this.connect(forward, socket)
  }

  /**
   * Open one direct-tcpip channel for a local socket and pipe both ways.
   *
   * The channel is opened through the pool, so a dropped SSH connection is
   * re-dialed per new local connection; an in-flight one fails with the pool's
   * reason and is recorded on the rule.
   */
  private async connect(forward: Forward, socket: Socket): Promise<void> {
    let channel: ClientChannel
    try {
      channel = await this.deps.pool.forwardOut(forward.alias, forward.remoteHost, forward.remotePort)
    } catch (error) {
      forward.lastError = messageOf(error)
      this.log('warn', `forward ${forward.id} -> ${forward.remoteHost}:${forward.remotePort} failed: ${forward.lastError}`)
      forward.sockets.delete(socket)
      socket.destroy()
      return
    }
    // The local socket can be gone by the time the channel opens (a cold dial
    // takes seconds); never leak a channel for nobody.
    if (socket.destroyed) {
      try {
        channel.close()
      } catch {
        // Already gone.
      }
      return
    }
    forward.channels.add(channel)
    forward.lastError = undefined
    // Byte counters are diagnostic only: `prependListener` would duplicate the
    // pipe; a plain listener sees the same chunks without consuming them.
    socket.on('data', (chunk: Buffer) => { forward.bytesIn += chunk.length })
    channel.on('data', (chunk: Buffer) => { forward.bytesOut += chunk.length })
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      forward.sockets.delete(socket)
      forward.channels.delete(channel)
      socket.destroy()
      try {
        channel.close()
      } catch {
        // Already gone.
      }
    }
    socket.once('close', finish)
    socket.once('error', finish)
    channel.once('close', finish)
    channel.once('error', finish)
    // `pipe` carries backpressure in both directions; a close on either side
    // ends both halves.
    socket.pipe(channel)
    channel.pipe(socket)
  }

  /** Tear one rule down: listener, then every proxied connection. */
  private closeForward(forward: Forward): void {
    try {
      forward.server.close()
    } catch {
      // Already closed.
    }
    for (const socket of [...forward.sockets]) {
      try {
        socket.destroy()
      } catch {
        // Already gone.
      }
    }
    forward.sockets.clear()
    for (const channel of [...forward.channels]) {
      try {
        channel.close()
      } catch {
        // Already gone.
      }
    }
    forward.channels.clear()
  }

  private stateOf(forward: Forward): RemoteForwardState {
    return {
      id: forward.id,
      alias: forward.alias,
      remoteHost: forward.remoteHost,
      remotePort: forward.remotePort,
      localPort: forward.localPort,
      localUrl: forwardLocalUrl(forward.localPort),
      state: forward.lastError === undefined ? 'listening' : 'error',
      connections: forward.sockets.size,
      bytesIn: forward.bytesIn,
      bytesOut: forward.bytesOut,
      ...(forward.lastError === undefined ? {} : { lastError: forward.lastError }),
      startedAt: forward.startedAt,
    }
  }

  private log(level: 'info' | 'warn', message: string): void {
    try {
      this.deps.log?.(level, message)
    } catch {
      // Logging must never break a forward.
    }
  }
}
