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
}

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
    const session: Session = { id, alias, channel, alive: true, exitCode: null, sockets: new Set() }
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
    ws.on('close', () => {
      session.sockets.delete(ws)
    })
    ws.on('error', () => {
      session.sockets.delete(ws)
    })
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
    for (const socket of session.sockets) {
      try {
        socket.send(text)
      } catch {
        // Drop dead sockets lazily on close.
      }
    }
  }
}
