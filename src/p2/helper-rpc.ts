/**
 * Helper RPC over an ssh2 exec channel: the Windows-native transport for the
 * official helper wire protocol. Speaks stdio RPC (SshRpcPeer + official
 * schemas) to the deployed `dsh-ssh-helper` binary — no OpenSSH CLI, no POSIX
 * gates. One connection per host alias; heartbeats keep the helper lease alive.
 */
import { Client, type ClientChannel } from 'ssh2'
import { readFileSync } from 'node:fs'
import { SshRpcPeer, SSH_PROTOCOL_VERSION } from '@deepseek-ai/dsh-ssh/protocol'
import { helloSchema } from '@deepseek-ai/dsh-ssh/schemas'
import { z } from 'zod'
import type { RemoteHostEntry } from '../protocol.ts'
import { InFlightGate } from './in-flight-gate.ts'

export interface RpcDialOpts {
  entry: RemoteHostEntry
  /** Absolute remote path of the helper executable. */
  helperPath: string
  /** Expected sha256 of the helper binary (verified at hello). */
  helperHash: string
  /** Remote default workspace for the hello handshake. */
  workspace: string
  leaseMs?: number
}

export interface RpcHello {
  protocol: number
  kind: string
  hash: string
  platform: string
  nodeVersion: string
}

/**
 * SSH transport handshake budget.
 *
 * ssh2 fails with "Timed out while waiting for handshake" when this expires.
 * 15s proved too tight for a busy host: one measured case had the target at a
 * load average of 10.59 and the handshake missed the window with nothing
 * competing for it — no agent contention, the box was simply saturated — and the
 * caller's turn failed. 30s still fails fast for a host that is genuinely
 * unreachable.
 */
const CONNECT_READY_TIMEOUT_MS = 30_000

const MAX_FRAME = 64 * 1024 * 1024
const MAX_PENDING = 128

/**
 * In-flight helper requests allowed per connection — deliberately BELOW
 * `MAX_PENDING`.
 *
 * One helper connection is shared by everything that touches the same host, so
 * `MAX_PENDING` is reached by ordinary concurrency rather than by anything
 * pathological: several agents listing and reading at once is enough, and the
 * peer then rejects the next request outright with "SSH helper pending request
 * limit reached" (`@deepseek-ai/dsh-ssh`), failing the caller's turn. The work
 * itself is fine — it just has to wait — so this gate queues instead of failing
 * and keeps the peer's own ceiling out of reach, with headroom left for the
 * hello/heartbeat class that does not pass through here.
 */
const MAX_IN_FLIGHT = 64

/** How much of the helper's stderr to keep for error messages. */
const STDERR_TAIL_MAX = 2000

export class RpcConnection {
  private conn: Client | undefined
  private channel: ClientChannel | undefined
  private peer: SshRpcPeer | undefined
  private readyPromise: Promise<RpcHello> | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private dead: Error | undefined
  private disposed = false
  /**
   * The helper's own error output, kept so its reason survives.
   *
   * Nothing read this stream before, so a helper that died on startup took its
   * explanation with it and the caller only ever saw "channel closed". Reading
   * it also removes a real hazard: an undrained stderr pipe blocks the child
   * once its buffer fills. The tail is bounded because a chatty helper must not
   * grow host memory.
   */
  private stderrTail = ''
  /** Per-connection in-flight cap; see MAX_IN_FLIGHT. */
  private readonly gate = new InFlightGate(MAX_IN_FLIGHT)

  constructor(private readonly opts: RpcDialOpts) {}

  /** True while the channel is open and no fatal error occurred. */
  get alive(): boolean {
    return !this.disposed && this.dead === undefined && this.channel !== undefined && !this.channel.closed
  }

  /** Whatever the helper last wrote to stderr — empty when it said nothing. */
  get diagnostics(): string {
    return this.stderrTail.trim()
  }

  get ready(): Promise<RpcHello> {
    if (this.readyPromise === undefined) this.readyPromise = this.open()
    return this.readyPromise
  }

  /** Send one helper operation (mirrors SshConnection.request for fs-ssh). */
  async request<T>(method: string, params: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const peer = await this.peerReady()
    // Queue rather than let the shared connection reject the call: every agent
    // on this host funnels through here, and "pending request limit reached"
    // used to fail a turn for work that only needed to wait its turn.
    await this.gate.acquire(signal)
    try {
      return await peer.request(method, params, schema, signal)
    } finally {
      this.gate.release()
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    try {
      this.peer?.close()
    } catch {
      // Ignore.
    }
    try {
      this.channel?.close()
    } catch {
      // Ignore.
    }
    try {
      this.conn?.end()
    } catch {
      // Ignore.
    }
  }

  private async peerReady(): Promise<SshRpcPeer> {
    await this.ready
    if (this.peer === undefined || this.dead !== undefined) {
      throw this.dead ?? new Error('helper RPC is not connected')
    }
    return this.peer
  }

  private async open(): Promise<RpcHello> {
    const { entry } = this.opts
    const conn = new Client()
    this.conn = conn
    await new Promise<void>((resolve, reject) => {
      let settled = false
      conn.on('ready', () => {
        if (!settled) {
          settled = true
          resolve()
        }
      })
      conn.on('error', (error: Error) => {
        if (!settled) {
          settled = true
          reject(error)
        } else {
          this.invalidate(error)
        }
      })
      conn.on('close', () => {
        this.invalidate(new Error('ssh connection closed'))
      })
      try {
        if (entry.auth.kind === 'key') {
          conn.connect({
            host: entry.host,
            port: entry.port,
            username: entry.user,
            privateKey: readFileSync(entry.auth.keyPath as string),
            passphrase: entry.auth.passphrase,
            readyTimeout: CONNECT_READY_TIMEOUT_MS,
            keepaliveInterval: 30000,
            keepaliveCountMax: 3,
          })
        } else {
          conn.connect({
            host: entry.host,
            port: entry.port,
            username: entry.user,
            password: entry.auth.password,
            readyTimeout: CONNECT_READY_TIMEOUT_MS,
            keepaliveInterval: 30000,
            keepaliveCountMax: 3,
          })
        }
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    if (this.disposed) throw new Error('disposed')
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      conn.exec(this.opts.helperPath, (error, stream) => {
        if (error !== undefined && error !== null) reject(error)
        else resolve(stream)
      })
    })
    this.channel = channel
    channel.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_MAX)
    })
    channel.on('close', () => {
      this.invalidate(new Error('helper channel closed'))
    })
    channel.on('error', (error: Error) => {
      this.invalidate(error)
    })
    const leaseMs = this.opts.leaseMs ?? 30000
    const peer = new SshRpcPeer(channel, channel, MAX_FRAME, MAX_PENDING)
    this.peer = peer
    const hello = await peer.request('hello', {
      protocol: SSH_PROTOCOL_VERSION,
      workspace: this.opts.workspace,
      leaseMs,
    }, helloSchema)
    if (hello.protocol !== SSH_PROTOCOL_VERSION) {
      throw new Error(`helper protocol mismatch: got ${hello.protocol}, want ${SSH_PROTOCOL_VERSION}`)
    }
    if (hello.kind !== 'executable') {
      throw new Error(`helper runtime mismatch: got ${hello.kind}, want executable`)
    }
    if (hello.hash !== this.opts.helperHash) {
      throw new Error('helper digest differs from the deployed artifact')
    }
    if (hello.bootstrapHash !== undefined) {
      throw new Error('helper reported an unexpected PTC bootstrap digest')
    }
    this.heartbeat = setInterval(() => {
      peer.request('heartbeat', {}, z.null(), AbortSignal.timeout(Math.floor(leaseMs / 2))).catch((error: unknown) => {
        this.invalidate(error instanceof Error ? error : new Error(String(error)))
      })
    }, Math.floor(leaseMs / 3))
    if (typeof this.heartbeat === 'object' && 'unref' in this.heartbeat) this.heartbeat.unref()
    return {
      protocol: hello.protocol,
      kind: hello.kind,
      hash: hello.hash,
      platform: hello.platform,
      nodeVersion: hello.nodeVersion,
    }
  }

  private invalidate(error: Error): void {
    if (this.dead !== undefined || this.disposed) return
    this.dead = error
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    try {
      this.peer?.close(error)
    } catch {
      // Ignore.
    }
  }
}
