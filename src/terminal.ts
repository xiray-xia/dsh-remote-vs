/**
 * Remote PTY terminal sessions: one ssh2 shell per session, surviving socket
 * detaches (reattach by id). Frames are JSON text (see protocol.ts).
 */
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
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
  /**
   * Output text waiting for the next coalesced frame, and its flush timer.
   *
   * A burst (a log tail, `cat` of a large file) delivers one ssh2 chunk at a
   * time; sending each chunk as its own JSON frame made the host stringify, the
   * socket frame and the browser parse once per chunk. Coalescing into one frame
   * per short window keeps the byte flow identical while cutting that overhead
   * by roughly an order of magnitude for exactly the commands that felt busy.
   */
  outBuffer: string
  outTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * Recent output already flushed to sockets, replayed to a REATTACHING socket.
   *
   * A PTY lives for ten minutes after its last socket, but the screen state
   * (the prompt, the last command's output) lives only in xterm on the client.
   * When a session switch remounts the sidebar, the new XTerm attaches to the
   * still-running shell and used to start BLANK — the shell was at its prompt,
   * but the prompt had been printed before the socket existed. Keeping the tail
   * of the stream lets `attach` hand the newcomer the screen it missed.
   *
   * Bounded: `REPLAY_MAX_CHARS` is enough for a prompt plus a screenful or two;
   * a `cat` of a huge file must not double the host's memory per session.
   */
  replay: string
  /**
   * When the last `out` frame went out.
   *
   * Used to tell an interactive ECHO from a burst: output that starts after a
   * quiet period is handed over immediately (a keystroke should not wait for the
   * coalescing window), while a continuous stream keeps coalescing.
   */
  lastFlushAt: number
  /**
   * Bytes handed to each socket that have not settled yet.
   *
   * `pending` alone cannot be released when a socket closes with frames still in
   * flight: ws never calls their send callbacks, so the missing bytes kept the
   * channel paused for the rest of the session (no echo at all until a reload).
   * Per-socket bookkeeping lets `detach` return exactly those bytes.
   */
  outstanding: Map<WebSocket, number>
  /** Fires once the last socket has been gone for EMPTY_SOCKET_TTL_MS. */
  reap: ReturnType<typeof setTimeout> | undefined
  /**
   * One decoder per stream: an SSH data chunk can end in the middle of a UTF-8
   * character (a CJK glyph is 3 bytes, an emoji 4), and `chunk.toString('utf8')`
   * would turn both halves into U+FFFD. `pool.ts` decodes exec output with the
   * same API for exactly this reason.
   */
  outDecoder: StringDecoder
  errDecoder: StringDecoder
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
 * The mark is RESPONSIVENESS, not just memory: everything already handed to a
 * socket has to be parsed and painted by the browser before a later keystroke's
 * echo can appear, so a large mark means "type during a huge dump and wait
 * seconds". 2 MiB still absorbs a burst comfortably (a keystroke is bytes) while
 * keeping the worst-case echo delay down; ssh2's own 2 MiB window is the part we
 * cannot shrink from here.
 *
 * The counter is per session, not per socket: one lagging socket pauses the
 * channel for every socket attached to that shell. That is deliberate — the
 * alternative is letting the slowest consumer grow the host process.
 */
const OUT_HIGH_WATER = 2 * 1024 * 1024
const OUT_LOW_WATER = 512 * 1024

/** Default window for coalescing output frames (0 = one frame per chunk). */
const OUT_COALESCE_MS = 8
/**
 * Flush immediately past this much buffered text (measured in UTF-16 code
 * units, i.e. `String.length`): a producer faster than the window must not turn
 * into an unbounded string copy (the channel backpressure bounds the bytes
 * handed to the SOCKETS, not this buffer).
 *
 * Code units rather than bytes on purpose: converting to a byte count would
 * copy the whole buffer on every chunk just to compare a threshold. CJK/emoji
 * output therefore flushes at up to ~3x this many bytes, which is still far
 * below the 1 MiB client-frame cap this path never approaches (it is the
 * client→host direction).
 */
const OUT_COALESCE_CHARS = 64 * 1024

/**
 * How long the output must have been quiet for the NEXT chunk to be sent at once.
 *
 * A terminal echoes what the user types. Holding that echo for the coalescing
 * window is invisible at 8 ms — but under load the window itself is a timer in
 * an event loop shared with the agent, and the delay adds up. After a quiet
 * period the chunk is therefore flushed synchronously; only a running stream
 * (where `lastFlushAt` is fresh) is batched.
 */
const OUT_ECHO_IDLE_MS = 24

/**
 * How much recent output a reattaching socket receives (see `Session.replay`).
 *
 * 128 Ki UTF-16 units is a few screens of logs plus the prompt line; the buffer
 * may grow to twice this between trims, so one terminal costs at most ~512 KiB
 * of the host's memory in replay state.
 */
const REPLAY_MAX_CHARS = 128 * 1024

/** Construction options (the terminal gate drives the registry directly). */
export interface TerminalRegistryOptions {
  /**
   * Output coalescing window in ms; `0` sends every chunk as its own frame.
   *
   * The existing checks use `0` so their assertions stay synchronous; one
   * dedicated check drives a non-zero window to pin the coalescing itself.
   */
  coalesceMs?: number
}

/**
 * The largest client frame accepted, in bytes.
 *
 * The only frame with a payload is `in` — keystrokes, and pastes, which the
 * client chunks to stay under this. The upgrade server (`routes.ts`) passes
 * this value as ws's `maxPayload`, so an oversized frame is refused before it
 * is buffered at all; the check in `hookSocket` is the second layer, and it is
 * what keeps such a frame from becoming a string plus an object graph in the
 * process that also runs the agent.
 */
export const TERMINAL_MAX_FRAME_BYTES = 1024 * 1024

/**
 * `WebSocket.OPEN` (RFC 6455 readyState 1).
 *
 * Used to detect a socket that closed while a shell was still being opened: the
 * library never replays a `close` event to a listener attached afterwards.
 */
const WS_OPEN = 1

export class TerminalSessionRegistry {
  private readonly sessions = new Map<string, Session>()

  constructor(
    private readonly pool: RemotePool,
    private readonly options: TerminalRegistryOptions = {},
  ) {}

  /** The window this registry coalesces within (`0` = every chunk is a frame). */
  private get coalesceMs(): number {
    return this.options.coalesceMs ?? OUT_COALESCE_MS
  }

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
      outBuffer: '',
      outTimer: undefined,
      replay: '',
      lastFlushAt: 0,
      outstanding: new Map(),
      reap: undefined,
      outDecoder: new StringDecoder('utf8'),
      errDecoder: new StringDecoder('utf8'),
    }
    this.sessions.set(id, session)
    channel.on('data', (chunk: Buffer) => {
      const text = session.outDecoder.write(chunk)
      if (text !== '') this.queueOut(session, text)
    })
    channel.stderr.on('data', (chunk: Buffer) => {
      const text = session.errDecoder.write(chunk)
      if (text !== '') this.queueOut(session, text)
    })
    channel.on('close', (code: number | null) => {
      session.alive = false
      session.exitCode = code
      // Flush the decoder-held tail BEFORE the exit frame: a command's last
      // character may still be sitting in the decoder when the channel closes.
      for (const tail of [session.outDecoder.end(), session.errDecoder.end()]) {
        if (tail !== '') this.queueOut(session, tail)
      }
      // …and flush anything the coalescing window is still holding, so the exit
      // frame can never overtake the last line the user was meant to see.
      this.flushOut(session)
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

  /**
   * Attach another socket to a live session; false when unknown/dead.
   *
   * The size in the URL is deliberately NOT applied here. It is the same
   * fixed 80x24 the view uses to open a shell, and re-applying it on every
   * reattach — which is what a page reload does — SHRANK a running shell:
   * SIGWINCH, and a full-screen program re-laying itself out at 80 columns,
   * until that tab became visible and refit. The session already has a size.
   * The socket sends a real `resize` frame as soon as it can measure itself
   * (`XTerm.pushSize`), which is the only place that knows how wide it is.
   *
   * The parameters stay because the upgrade handler owns the URL and passes
   * them on both paths; they matter to `open` (the PTY's initial size) only.
   */
  attach(ws: WebSocket, id: string, _cols: number, _rows: number): boolean {
    const session = this.sessions.get(id)
    if (session === undefined || !session.alive) return false
    this.hookSocket(session, ws)
    // Hand the newcomer the output this session produced before it attached
    // (the shell's prompt, the previous command's screen). It goes through the
    // same per-socket accounting as live output, so a huge replay cannot slip
    // past the backpressure ceiling.
    if (session.replay !== '') {
      this.sendOutTo(session, ws, JSON.stringify({ t: 'out', d: session.replay }))
    }
    // Deliver anything the coalescing window still holds to the newcomer too,
    // before its `ready`: it is output the shell already produced.
    this.flushOut(session)
    this.send(ws, { t: 'ready', id })
    return true
  }

  /** Close one session (kills the remote shell). */
  close(id: string): boolean {
    const session = this.sessions.get(id)
    if (session === undefined) return false
    this.sessions.delete(id)
    this.cancelReap(session)
    this.flushOut(session)
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
    // The sockets are gone; their unsettled frames will never settle.
    session.outstanding.clear()
    session.pending = 0
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
      // Refuse an oversized frame before parsing it — see
      // TERMINAL_MAX_FRAME_BYTES. 1009 is the protocol's "message too big".
      const bytes = Array.isArray(raw) ? raw.reduce((total, part) => total + part.byteLength, 0) : raw.byteLength
      if (bytes > TERMINAL_MAX_FRAME_BYTES) {
        try {
          ws.close(1009)
        } catch {
          // Already gone.
        }
        return
      }
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
      // Whatever the window is holding was produced while this socket was still
      // attached: hand it over before the socket leaves the set.
      this.flushOut(session)
      // Release the frames this socket never settled. `ws` does not call their
      // send callbacks after a close, and the leaked `pending` bytes used to keep
      // the channel paused for the rest of the session.
      const unsettled = session.outstanding.get(ws)
      if (unsettled !== undefined) {
        session.outstanding.delete(ws)
        session.pending = Math.max(0, session.pending - unsettled)
        if (session.pending <= OUT_LOW_WATER) this.setPaused(session, false)
      }
      session.sockets.delete(ws)
      if (session.sockets.size > 0) return
      // Nobody is watching any more. Release the brake first — a paused channel
      // would otherwise stay paused with no socket left to resume it — then
      // start the clock that ends the session (and with it the remote shell).
      session.pending = 0
      session.outstanding.clear()
      this.setPaused(session, false)
      this.armReap(session)
    }
    ws.on('close', detach)
    ws.on('error', detach)
    /**
     * The socket may have closed while `pool.shell()` was still dialing: a cold
     * connection takes seconds, and a page reload (or a closed tab) during it
     * happens well before those listeners exist. EventEmitter does not replay
     * events, so without this the socket would sit in `sockets` forever, no
     * detach would ever run, no reap would ever arm — and the session, its PTY
     * and the pooled connection's hold would leak for the life of the process.
     * `readyState` is the only way to observe "already gone" from here.
     */
    if (ws.readyState !== WS_OPEN) detach()
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

  /**
   * Queue one output chunk and schedule the coalesced frame.
   *
   * `coalesceMs === 0` broadcasts immediately (the checks rely on that
   * synchrony). A chunk that arrives after an idle gap is also sent at once —
   * that is the interactive echo path (a keystroke must not wait for the
   * window) — while a stream that keeps producing coalesces.
   */
  private queueOut(session: Session, text: string): void {
    if (text === '') return
    const idle = Date.now() - session.lastFlushAt >= OUT_ECHO_IDLE_MS
    session.outBuffer += text
    if (session.outBuffer.length >= OUT_COALESCE_CHARS || this.coalesceMs <= 0 || idle) {
      this.flushOut(session)
      return
    }
    if (session.outTimer !== undefined) return
    const timer = setTimeout(() => {
      session.outTimer = undefined
      this.flushOut(session)
    }, this.coalesceMs)
    timer.unref?.()
    session.outTimer = timer
  }

  /** Send the buffered output as ONE `out` frame (no-op when empty). */
  private flushOut(session: Session): void {
    if (session.outTimer !== undefined) {
      clearTimeout(session.outTimer)
      session.outTimer = undefined
    }
    if (session.outBuffer === '') return
    const text = session.outBuffer
    session.outBuffer = ''
    // Remember what was already delivered: a later reattach replays this.
    session.replay += text
    if (session.replay.length > REPLAY_MAX_CHARS * 2) {
      session.replay = session.replay.slice(-REPLAY_MAX_CHARS)
    }
    session.lastFlushAt = Date.now()
    this.broadcast(session, { t: 'out', d: text })
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
    for (const socket of session.sockets) {
      this.sendOutTo(session, socket, text)
    }
    if (session.pending > OUT_HIGH_WATER) this.setPaused(session, true)
  }

  /**
   * Send one already-stringified `out` frame to ONE socket with accounting.
   *
   * Shared by `broadcast` and by the replay on `attach`; the byte count must be
   * counted once per socket so the session's brake reflects every socket's
   * backlog (see `Session.pending`).
   */
  private sendOutTo(session: Session, socket: WebSocket, text: string): void {
    // Bytes, not UTF-16 code units: CJK and emoji output would otherwise be
    // undercounted by up to 3x and the brake would come on too late.
    const size = Buffer.byteLength(text, 'utf8')
    let settled = false
    // The send callback fires once the frame is on the wire. It is the only
    // public signal for "this socket has caught up", and it avoids relying on
    // ws internals (bufferedAmount does not report the socket write queue).
    const done = (): void => {
      if (settled) return
      settled = true
      // A socket that detached already had its outstanding bytes released
      // (its late callback must not decrement them a second time).
      const left = session.outstanding.get(socket)
      if (left === undefined) return
      const remaining = Math.max(0, left - size)
      if (remaining === 0) session.outstanding.delete(socket)
      else session.outstanding.set(socket, remaining)
      session.pending = Math.max(0, session.pending - size)
      if (session.pending <= OUT_LOW_WATER) this.setPaused(session, false)
    }
    session.pending += size
    session.outstanding.set(socket, (session.outstanding.get(socket) ?? 0) + size)
    try {
      socket.send(text, done)
    } catch {
      done()
    }
  }
}
