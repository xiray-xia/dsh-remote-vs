/**
 * Remote PTY terminal sessions: one ssh2 shell per session, surviving socket
 * detaches (reattach by id). Frames are JSON text (see protocol.ts).
 */
import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import type { ClientChannel } from 'ssh2'
import type { RemotePool } from './pool.ts'
import type { TerminalClientFrame, TerminalServerFrame } from './protocol.ts'

interface Session {
  id: string
  alias: string
  channel: ClientChannel
  alive: boolean
  exitCode: number | null
  sockets: Set<WebSocket>
  /** Bytes handed to sockets that have not flushed yet (see broadcast). */
  pending: number
  /** True while the channel is paused because a socket fell behind. */
  paused: boolean
  /** Fires once the last socket has been gone for EMPTY_SOCKET_TTL_MS. */
  reap: ReturnType<typeof setTimeout> | undefined
}

/**
 * A session with no attached socket is kept this long so that a page reload
 * can reattach by id. Past it the session closes and the remote shell dies.
 *
 * Without this sweep nothing ever released the session: its `pool.hold` never
 * returned to zero, so the connection could not idle out, and the remote sshd
 * session slot stayed taken for the life of the host process. Ten minutes is
 * far longer than a reload needs and far shorter than "until you restart DSH".
 */
const EMPTY_SOCKET_TTL_MS = 10 * 60_000

/**
 * Terminal output is a live stream with no natural end, so it needs a bound.
 * When a socket falls this far behind, pause the channel — that pushes the
 * brake all the way back to the remote command, instead of growing the host
 * process. Resume once the socket has drained.
 *
 * The pause is real backpressure, not a local buffer: ssh2 only sends a window
 * adjustment while the stream is flowing, so a paused channel lets the peer's
 * send window drain to zero and the remote command blocks on its own write.
 * The retained ceiling is therefore this mark plus ssh2's window (2 MiB) plus
 * whatever is in flight — bounded, but not exactly 4 MiB.
 *
 * The counter is per session, not per socket: one lagging socket pauses the
 * channel for every socket attached to that shell. That is deliberate — the
 * alternative is letting the slowest consumer grow the host process.
 */
const OUT_HIGH_WATER = 4 * 1024 * 1024
const OUT_LOW_WATER = 1 * 1024 * 1024

export class TerminalSessionRegistry {
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly pool: RemotePool) {}

  /** Open a shell and attach the first socket. */
  async open(ws: WebSocket, alias: string, cols: number, rows: number): Promise<string> {
    const id = randomUUID().slice(0, 8)
    let channel: ClientChannel
    try {
      channel = await this.pool.shell(alias, { cols, rows })
    } catch (error) {
      this.send(ws, { t: 'error', message: error instanceof Error ? error.message : String(error) })
      try {
        ws.close(1011)
      } catch {
        // Ignore.
      }
      throw error
    }
    const session: Session = {
      id,
      alias,
      channel,
      alive: true,
      exitCode: null,
      sockets: new Set(),
      pending: 0,
      paused: false,
      reap: undefined,
    }
    this.sessions.set(id, session)
    channel.on('data', (chunk: Buffer) => {
      this.broadcast(session, { t: 'out', d: chunk.toString('utf8') })
    })
    channel.stderr.on('data', (chunk: Buffer) => {
      this.broadcast(session, { t: 'out', d: chunk.toString('utf8') })
    })
    channel.on('close', (code: number | null) => {
      session.alive = false
      session.exitCode = code
      this.broadcast(session, { t: 'exit', code })
      for (const socket of session.sockets) {
        try {
          socket.close(1000)
        } catch {
          // Ignore.
        }
      }
    })
    this.hookSocket(session, ws)
    this.send(ws, { t: 'ready', id })
    return id
  }

  /** Attach another socket to a live session; false when unknown/dead. */
  attach(ws: WebSocket, id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id)
    if (session === undefined || !session.alive) return false
    try {
      session.channel.setWindow(rows, cols, 0, 0)
    } catch {
      // Best effort.
    }
    this.hookSocket(session, ws)
    this.send(ws, { t: 'ready', id })
    return true
  }

  /** Close one session (kills the remote shell). */
  close(id: string): boolean {
    const session = this.sessions.get(id)
    if (session === undefined) return false
    this.sessions.delete(id)
    this.cancelReap(session)
    try {
      session.channel.close()
    } catch {
      // Ignore.
    }
    for (const socket of session.sockets) {
      try {
        socket.close(1000)
      } catch {
        // Ignore.
      }
    }
    session.sockets.clear()
    return true
  }

  /** Close every session (plugin unload). */
  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  list(): { id: string; alias: string; alive: boolean }[] {
    return [...this.sessions.values()].map(s => ({ id: s.id, alias: s.alias, alive: s.alive }))
  }

  private hookSocket(session: Session, ws: WebSocket): void {
    // A socket is back: the session is in use, so cancel any pending reap.
    this.cancelReap(session)
    session.sockets.add(ws)
    ws.on('message', (raw) => {
      let frame: TerminalClientFrame
      try {
        frame = JSON.parse(String(raw)) as TerminalClientFrame
      } catch {
        return
      }
      if (!session.alive) return
      if (frame.t === 'in' && typeof frame.d === 'string') {
        try {
          session.channel.write(frame.d)
        } catch {
          // Ignore.
        }
      } else if (frame.t === 'resize' && Number.isFinite(frame.cols) && Number.isFinite(frame.rows)) {
        try {
          session.channel.setWindow(frame.rows, frame.cols, 0, 0)
        } catch {
          // Ignore.
        }
      }
    })
    const detach = (): void => {
      session.sockets.delete(ws)
      if (session.sockets.size > 0) return
      // Nobody is watching any more. Release the brake first — a paused channel
      // would otherwise stay paused with no socket left to resume it — then
      // start the clock that ends the session (and with it the remote shell).
      session.pending = 0
      this.setPaused(session, false)
      this.armReap(session)
    }
    ws.on('close', detach)
    ws.on('error', detach)
  }

  /** Keep the shell for a while (reload can reattach), then close it for good. */
  private armReap(session: Session): void {
    this.cancelReap(session)
    const timer = setTimeout(() => {
      session.reap = undefined
      // A late detach can arm a timer for a session that close() already
      // removed; never act on an entry that is no longer the registered one.
      if (this.sessions.get(session.id) !== session) return
      if (session.sockets.size === 0) this.close(session.id)
    }, EMPTY_SOCKET_TTL_MS)
    timer.unref?.()
    session.reap = timer
  }

  private cancelReap(session: Session): void {
    if (session.reap === undefined) return
    clearTimeout(session.reap)
    session.reap = undefined
  }

  private setPaused(session: Session, paused: boolean): void {
    if (session.paused === paused) return
    session.paused = paused
    try {
      if (paused) session.channel.pause()
      else session.channel.resume()
    } catch {
      // The channel may already be gone; the flag still records the intent.
    }
  }

  private send(ws: WebSocket, frame: TerminalServerFrame): void {
    try {
      ws.send(JSON.stringify(frame))
    } catch {
      // Socket raced away.
    }
  }

  private broadcast(session: Session, frame: TerminalServerFrame): void {
    const text = JSON.stringify(frame)
    // Bytes, not UTF-16 code units: CJK and emoji output would otherwise be
    // undercounted by up to 3x and the brake would come on too late.
    const size = Buffer.byteLength(text, 'utf8')
    for (const socket of session.sockets) {
      let settled = false
      // The send callback fires once the frame is on the wire. It is the only
      // public signal for "this socket has caught up", and it avoids relying on
      // ws internals (bufferedAmount does not report the socket write queue).
      const done = (): void => {
        if (settled) return
        settled = true
        session.pending = Math.max(0, session.pending - size)
        if (session.pending <= OUT_LOW_WATER) this.setPaused(session, false)
      }
      session.pending += size
      try {
        socket.send(text, done)
      } catch {
        done()
      }
    }
    if (session.pending > OUT_HIGH_WATER) this.setPaused(session, true)
  }
}
