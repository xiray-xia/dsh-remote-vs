/**
 * Persistent ssh2 connection pool: one long-lived connection per host alias,
 * dropped after 30 idle minutes. All remote ops (exec / shell / sftp) ride it.
 *
 * Trust model (P0): host keys are accepted on first use (TOFU); a changed key
 * for a known host is logged loudly but the connection still proceeds. Strict
 * known-hosts enforcement is P1 work.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2'
import type { RemoteStore } from './store.ts'
import type { RemoteExecResult, RemoteHostEntry } from './protocol.ts'

/** Idle time after which a pooled connection is closed. */
const IDLE_MS = 30 * 60 * 1000

/**
 * Connection establishment timeout, including authentication.
 *
 * This was 15s, which is not a handshake budget so much as a CPU budget: on a
 * two-core host running a build, sshd could not complete a PASSWORD exchange
 * inside it, and every call failed with "Timed out while waiting for handshake"
 * while the banner was arriving in 15ms. Key auth fixed the common case (~1s),
 * but a loaded host is still slow enough to be worth headroom.
 *
 * Override with DSH_REMOTE_VS_CONNECT_TIMEOUT_MS (milliseconds, >= 1000).
 */
const READY_TIMEOUT_MS = (() => {
  const raw = Number(process.env.DSH_REMOTE_VS_CONNECT_TIMEOUT_MS)
  return Number.isFinite(raw) && raw >= 1_000 ? raw : 45_000
})()

/** Per-stream output cap (stdout/stderr each); overflow truncates with a marker. */
const OUTPUT_CAP = 2 * 1024 * 1024

/**
 * Wall-clock cap for one SFTP callback body. SSH gives no request timeout of
 * its own, so a server that never answers would hold the session (and the
 * pooled connection's hold count) open forever — the leak that eventually
 * exhausts the server's channel budget. The timeout rejects so the caller's
 * `finally` still ends the session and releases the connection.
 */
const SFTP_OP_TIMEOUT_MS = 60_000

/**
 * No-progress budget for a bulk upload. Deliberately an *idle* timeout rather
 * than a wall clock: the point is to catch a stream that stopped moving, not
 * to give up on a large file that is transferring fine on a slow link.
 * `fastPut` resets it on every chunk via its `step` callback.
 */
const UPLOAD_IDLE_MS = 60_000

const TRUNCATED_MARKER = '\n[... truncated: output exceeded 2 MiB ...]\n'

/** Leading line the session wrapper prints so the timeout can kill its group. */
const PGID_MARKER = 'RV_PID='

/** One-shot `setsid --wait` capability probe (see RemotePool.supportsSetsid). */
const SETSID_PROBE = "setsid --wait sh -c 'exit 7' 2>/dev/null; test $? -eq 7 && echo RV_SETSID=1"
const SETSID_PROBE_MARK = 'RV_SETSID=1'

/** Deadline for the probe and for a group kill; both are one tiny command. */
const CONTROL_TIMEOUT_MS = 15_000

/**
 * How long a killed group gets to report its exit before TERM escalates to
 * KILL. Without the escalation a command that ignores TERM would survive the
 * timeout, which is the leak this kill exists to close (p2/ssh-proc.ts uses
 * the same grace before its own escalation).
 */
const GROUP_KILL_GRACE_MS = 3_000

/**
 * Concurrent channels the pool opens per alias. The server's own `MaxSessions`
 * (10 on the hosts this was measured against) is the real ceiling, and running
 * past it fails the extra channels hard — "open failed / administratively
 * prohibited" — with nobody retrying. Six is chosen to leave room for what is
 * deliberately NOT counted here: PTY terminals, the processes the subprocess
 * runtime owns, and the helper's channel.
 */
const CHANNEL_LIMIT = 6

/**
 * How long an operation waits for a channel slot before failing. Bounded on
 * purpose: queueing forever behind a peer that never finishes is worse than a
 * readable error that tells the user to retry.
 */
const CHANNEL_WAIT_MS = 30_000

/**
 * Idle time after which the shared BROWSE SFTP session is closed.
 *
 * Browsing is bursty (open a folder, look around, edit for a while, browse
 * again), so a channel that survives only the burst costs one channel-open
 * round trip per burst and saves one per request inside it. Two minutes covers
 * the burst without keeping a channel slot parked for a five-minute pause. The
 * slot it holds is the one a per-request session took, so peak channel usage
 * against the server's MaxSessions does not change; the parked-slot trade-off
 * is spelled out in withBrowseSftp's docstring.
 */
const BROWSE_IDLE_MS = 2 * 60 * 1000

interface Pooled {
  conn: Client
  timer: ReturnType<typeof setTimeout> | undefined
  lastUse: number
  connecting: Promise<Client> | undefined
  /** Live users (channels/sessions); idle eviction only fires at zero. */
  held: number
}

/**
 * The per-alias BROWSE SFTP session (see `withBrowseSftp`).
 *
 * `active` counts operations in flight; the idle timer only runs at zero.
 * `stale` means an operation hit its deadline, so the channel must not be
 * reused once the current operations drain — a session whose request never
 * answered is not worth trusting, and closing it under a peer still using it
 * would fail that peer instead.
 */
interface BrowseChannel {
  session: SFTPWrapper | undefined
  opening: Promise<SFTPWrapper> | undefined
  active: number
  stale: boolean
  /** This channel holds one channel slot and one connection hold. */
  leased: boolean
  idle: ReturnType<typeof setTimeout> | undefined
}

export interface ExecOptions {
  timeoutMs?: number
  /**
   * Live sink for the command's output (the streaming network verbs). Called
   * with already-decoded text so a multi-byte character split across ssh2
   * chunks is never mangled; the accumulated `stdout`/`stderr` on the result
   * keep the same bytes.
   */
  onData?: (stream: 'out' | 'err', text: string) => void
  /** Receives the cancel handle once the run is under way (see `cancel`). */
  onCancel?: (cancel: () => void) => void
  /**
   * Internal: send the line exactly as given — no session wrapper, and no group
   * kill when it times out. Only the two commands the pool sends on its own
   * behalf (the setsid probe and the group kill) use it; wrapping those would
   * recurse into the machinery that dispatched them.
   */
  bare?: boolean
}

export interface ShellOptions {
  cols?: number
  rows?: number
}

export interface SftpOptions {
  /**
   * Wall-clock cap for the callback body. `0` disables it for an operation that
   * is bounded by progress instead (a bulk upload: see putFile); a fixed wall
   * clock there only turns a healthy transfer on a slow link into a timeout.
   * Omitted means the per-operation default. The session-open deadline applies
   * either way, so a server that never answers cannot pin the connection.
   */
  timeoutMs?: number
}

/** One queued operation waiting for a channel slot. */
interface SlotWaiter {
  /** Claimed by whichever acts first, the handover or the timeout. */
  granted: boolean
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined
}

interface Slots {
  /** Slots handed out and not yet given back. */
  active: number
  /** FIFO of operations waiting for one. */
  queue: SlotWaiter[]
}

export class RemotePool {
  private readonly conns = new Map<string, Pooled>()
  /** TOFU fingerprints observed this process (alias -> sha256). */
  private readonly hostKeys = new Map<string, string>()
  /** Per-alias `setsid --wait` capability, probed once (see supportsSetsid). */
  private readonly setsidProbes = new Map<string, Promise<boolean>>()
  /** Per-alias channel slots and the queue waiting for one (see acquireSlot). */
  private readonly slots = new Map<string, Slots>()
  /** Per-alias BROWSE SFTP session (see withBrowseSftp). */
  private readonly browsed = new Map<string, BrowseChannel>()

  constructor(private readonly store: RemoteStore) {}

  /** Drop one pooled connection (call after host update/delete). */
  drop(alias: string): void {
    // Order matters: the open browse channel must give its slot and hold back
    // while the pooled entry still exists, or the release would be a no-op.
    this.evictBrowse(alias)
    const pooled = this.conns.get(alias)
    // The host entry can change under an alias, so the capability answer goes
    // with the connection; the next exec probes again.
    this.setsidProbes.delete(alias)
    if (pooled === undefined) return
    this.conns.delete(alias)
    if (pooled.timer !== undefined) clearTimeout(pooled.timer)
    try {
      pooled.conn.end()
    } catch {
      // Already gone.
    }
  }

  /** Close every pooled connection. */
  dispose(): void {
    for (const alias of [...this.conns.keys()]) this.drop(alias)
  }

  /** Test a connection without disturbing the pool. */
  async test(alias: string): Promise<{ ok: boolean; banner?: string; error?: string; durationMs: number }> {
    const started = Date.now()
    try {
      const conn = await this.acquire(alias)
      this.hold(alias)
      this.release(alias)
      void conn
      return { ok: true, durationMs: Date.now() - started }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started }
    }
  }

  /**
   * Run one non-interactive command.
   *
   * The command needs a channel slot: a burst of SCM or search calls is exactly
   * how a host runs past `MaxSessions`, where the surplus channels fail instead
   * of queueing. The pool's own housekeeping (`bare`: the setsid probe and the
   * group kill) is exempt — a kill that waits behind user traffic would be a
   * worse bug than the one it fixes.
   */
  async exec(alias: string, command: string, opts: ExecOptions = {}): Promise<RemoteExecResult> {
    if (opts.bare === true) return this.runExec(alias, command, opts)
    const started = Date.now()
    try {
      await this.acquireSlot(alias)
    } catch (error) {
      return {
        success: false, exitCode: null, timedOut: false, stdout: '', stderr: '',
        durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error),
      }
    }
    try {
      return await this.runExec(alias, command, opts)
    } finally {
      this.releaseSlot(alias)
    }
  }

  /** The exec body, run while the caller already holds a channel slot. */
  private async runExec(alias: string, command: string, opts: ExecOptions = {}): Promise<RemoteExecResult> {
    const started = Date.now()
    const timeoutMs = opts.timeoutMs ?? 60_000
    // Run the line in its own session, or the timeout below has nothing to kill
    // (see sessionLine). The probe is one extra channel per alias, not per
    // call; a remote that cannot host the wrapper keeps working unwrapped.
    const session = opts.bare === true ? false : await this.supportsSetsid(alias)
    let conn: Client
    try {
      conn = await this.acquire(alias)
      this.hold(alias)
    } catch (error) {
      return {
        success: false, exitCode: null, timedOut: false, stdout: '', stderr: '',
        durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error),
      }
    }
    try {
      return await new Promise<RemoteExecResult>((resolve) => {
        let settled = false
        let timedOut = false
        /** Server-confirmed child exit; a bare channel close is not proof. */
        let exited = false
        /** Session/process-group id, from the wrapper's leading marker line. */
        let pgid: number | undefined
        let markerPending = session
        let warned = false
        /** Say once, and only once, that the timeout could not reach the command. */
        const warnOnce = (): void => {
          if (warned) return
          warned = true
          warnDetached(alias)
        }
        const finish = (result: Omit<RemoteExecResult, 'durationMs'>): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.release(alias)
          resolve({ ...result, durationMs: Date.now() - started })
        }
        /**
         * Signal the command's process group over a fresh channel: the timed-out
         * channel is closing, and `channel.signal()` would only reach the outer
         * shell anyway. `bare` keeps the kill out of the wrapper — a kill that
         * hung would otherwise try to kill its own group.
         */
        const killGroup = (signal: 'TERM' | 'KILL'): void => {
          if (pgid === undefined) return
          void this.exec(alias, `kill -${signal} -- -${pgid}`, { timeoutMs: CONTROL_TIMEOUT_MS, bare: true }).catch(() => undefined)
        }
        const terminateGroup = (): void => {
          killGroup('TERM')
          setTimeout(() => {
            if (!exited) killGroup('KILL')
          }, GROUP_KILL_GRACE_MS).unref?.()
        }
        const timer = setTimeout(() => {
          timedOut = true
          try {
            stream?.close()
          } catch {
            // Ignore.
          }
          // Closing the channel releases our side only: a `git` or `rg` that is
          // still working never notices and keeps burning remote CPU until it
          // finishes on its own. Kill the group instead — p2/ssh-proc.ts:9-25
          // is the same lesson learned in the subprocess runtime.
          if (pgid !== undefined) terminateGroup()
          else if (!session) warnOnce()
          // Session without a group id yet: the channel is still opening, and
          // the data handler below kills the group as soon as the marker names
          // it (the close handler warns if it never does).
          finish({ success: false, exitCode: null, timedOut: true, stdout: out, stderr: err })
        }, timeoutMs)
        let stream: ClientChannel | undefined
        let out = ''
        let err = ''
        /** Set by the cancel handle: closed + group-killed, reported as error. */
        let cancelled = false
        const outDecoder = new StringDecoder('utf8')
        const errDecoder = new StringDecoder('utf8')
        /** Wrapper marker never reaches the live log (see the data handler). */
        let pendingForward = ''
        const forward = (kind: 'out' | 'err', text: string): void => {
          if (text !== '' && opts.onData !== undefined) opts.onData(kind, text)
        }
        /**
         * Cancel the run: close our channel and kill the remote process group.
         *
         * `finish` reports it as an error rather than a timeout — "the user
         * stopped it" and "the budget ran out" are different stories, and the
         * UI must not blame the host for the former.
         */
        const cancel = (): void => {
          if (settled) return
          cancelled = true
          try {
            stream?.close()
          } catch {
            // Already gone.
          }
          if (pgid !== undefined) terminateGroup()
          // No session wrapper means no process group to signal: say so, like the
          // timeout path does, instead of a silent "cancelled" with git still up.
          else if (!session) warnOnce()
          finish({ success: false, exitCode: null, timedOut: false, stdout: out, stderr: err, error: 'cancelled by user' })
        }
        opts.onCancel?.(cancel)
        conn.exec(session ? sessionLine(command) : command, (execError, channel) => {
          if (execError !== undefined && execError !== null) {
            finish({ success: false, exitCode: null, timedOut: false, stdout: '', stderr: '', error: execError.message })
            return
          }
          // The timeout may already have fired while the channel was opening
          // (ssh2 offers no channel-open timeout). The command may be running,
          // so listen for the marker and let the handler below kill the group;
          // a bounded give-up closes the channel so a line that never names a
          // group cannot hold a server slot until it finishes on its own.
          if (settled) {
            setTimeout(() => {
              if (pgid === undefined) warnOnce()
              try {
                channel.close()
              } catch {
                // Already gone.
              }
            }, GROUP_KILL_GRACE_MS).unref?.()
          } else {
            stream = channel
          }
          channel.on('close', (code: number | null, signalName?: string | null) => {
            // An exit status is the server's proof the child is gone; the close
            // we send ourselves is not.
            if ((code !== null && code !== undefined) || (signalName !== null && signalName !== undefined)) exited = true
            if (timedOut && session && pgid === undefined) warnOnce()
            // A channel can close before the marker is parsed (or in the middle
            // of a single-line command's output): flush the held-back text so the
            // live log does not lose its tail. A partial marker line itself is
            // bookkeeping and stays hidden.
            if (pendingForward !== '') {
              const newline = pendingForward.indexOf('\n')
              const visible = markerPending
                ? pendingForward.startsWith(PGID_MARKER)
                  ? (newline < 0 ? '' : pendingForward.slice(newline + 1))
                  : pendingForward
                : pendingForward
              pendingForward = ''
              forward('out', visible)
            }
            // Flush a decoder-held partial character before the final result.
            const tailOut = outDecoder.end()
            const tailErr = errDecoder.end()
            if (tailOut !== '') { out = appendCapped(out, tailOut); forward('out', tailOut) }
            if (tailErr !== '') { err = appendCapped(err, tailErr); forward('err', tailErr) }
            finish({ success: code === 0, exitCode: code, timedOut: false, stdout: out, stderr: err })
          })
          channel.on('data', (chunk: Buffer) => {
            const text = outDecoder.write(chunk)
            out = appendCapped(out, text)
            if (pgid !== undefined || !markerPending) {
              forward('out', text)
              return
            }
            // The wrapper's group-marker line is bookkeeping, not command
            // output: hold output until the marker is resolved, then forward
            // only what the command itself printed.
            pendingForward += text
            const marker = takePgid(out)
            if (marker.pgid !== undefined) {
              pgid = marker.pgid
              out = marker.out
              markerPending = false
              // Only reachable when the timeout fired before this channel was
              // open: the group had no id then, so kill it now that it has one.
              if (timedOut) terminateGroup()
              if (cancelled) terminateGroup()
              const newline = pendingForward.indexOf('\n')
              const visible = newline < 0 ? '' : pendingForward.slice(newline + 1)
              pendingForward = ''
              forward('out', visible)
              return
            }
            if (out.includes('\n') || pendingForward.length > 8192) {
              // The first line is the command's own output, not our marker.
              markerPending = false
              const visible = pendingForward
              pendingForward = ''
              forward('out', visible)
            }
          })
          channel.stderr.on('data', (chunk: Buffer) => {
            const text = errDecoder.write(chunk)
            err = appendCapped(err, text)
            forward('err', text)
          })
        })
      })
    } catch (error) {
      this.release(alias)
      return {
        success: false, exitCode: null, timedOut: false, stdout: '', stderr: '',
        durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** Open an interactive PTY shell. The caller owns the channel lifecycle. */
  async shell(alias: string, opts: ShellOptions = {}): Promise<ClientChannel> {
    const conn = await this.acquire(alias)
    this.hold(alias)
    try {
      const channel = await new Promise<ClientChannel>((resolve, reject) => {
        conn.shell({ cols: opts.cols ?? 80, rows: opts.rows ?? 24, term: 'xterm-256color' }, (error, stream) => {
          if (error !== undefined && error !== null) reject(error)
          else resolve(stream)
        })
      })
      channel.once('close', () => this.release(alias))
      return channel
    } catch (error) {
      this.release(alias)
      throw error
    }
  }

  /** Open one exec channel. The caller owns the channel lifecycle. */
  async execChannel(alias: string, command: string): Promise<ClientChannel> {
    const conn = await this.acquire(alias)
    this.hold(alias)
    try {
      const channel = await new Promise<ClientChannel>((resolve, reject) => {
        conn.exec(command, (error, stream) => {
          if (error !== undefined && error !== null) reject(error)
          else resolve(stream)
        })
      })
      channel.once('close', () => this.release(alias))
      return channel
    } catch (error) {
      this.release(alias)
      throw error
    }
  }

  /** Run one callback with a fresh SFTP session (closed afterwards). */
  async withSftp<T>(alias: string, fn: (sftp: SFTPWrapper) => Promise<T>, opts: SftpOptions = {}): Promise<T> {
    // An SFTP session IS a channel, so it takes a slot too: the burst that put
    // a host at its channel ceiling before was concurrent SFTP listings.
    await this.acquireSlot(alias)
    let conn: Client
    try {
      conn = await this.acquire(alias)
    } catch (error) {
      this.releaseSlot(alias)
      throw error
    }
    // Hold BEFORE the first await: holding after it leaves a window where the
    // connection has no hold count and is not yet recorded as in use, so the
    // idle timer armed by a concurrent release() could evict it mid-call.
    this.hold(alias)
    try {
      const sftp = await this.openSession(conn)
      try {
        const limit = opts.timeoutMs ?? SFTP_OP_TIMEOUT_MS
        if (limit <= 0) return await fn(sftp)
        return await withDeadline(fn(sftp), limit, `SFTP operation timed out after ${limit / 1000}s`)
      } finally {
        try {
          sftp.end()
        } catch {
          // Ignore close errors.
        }
      }
    } finally {
      this.release(alias)
      this.releaseSlot(alias)
    }
  }

  /**
   * Run one bulk-transfer callback with a dedicated SFTP session, plus extra
   * channel windows on demand (`addChannel`).
   *
   * Why extra channels: ssh2 (Channel.js `MAX_WINDOW`) and OpenSSH cap ONE SSH
   * channel's window at 2 MiB, so a single channel can never hold 8 MiB of READs
   * in flight however much concurrency the caller asks for; the rest queue
   * client-side. Each extra session is another 2 MiB window. Measured against a
   * real host (96 MiB file, 256 KiB chunks, same total concurrency):
   * 1 channel 28.6 MiB/s, 2 channels 46.1, 4 channels 51.3 — two channels take
   * most of the gain, four cost twice the channels for little more. Uploads
   * showed no such gain (server-side write bound: 46.0 → 50.4 MiB/s), so only
   * downloads spread out.
   *
   * `addChannel` is best-effort and late on purpose: a small download must not
   * pay for a second channel, so the caller opens one only after it has the
   * size. It never queues for a channel slot (a 30 s wait would stall a body that
   * is already streaming) and a late call after the callback settled is a no-op.
   * Every session opened here is closed, and every slot/hold released, when the
   * callback settles — including a partially successful `addChannel`.
   *
   * There is no wall-clock deadline of its own: streaming is progress-bounded by
   * the caller, and the caller also bounds the one-shot SFTP calls it makes
   * around the stream (metadata phase, optional channel opens), because nothing
   * there produces progress to watch.
   */
  async withTransferSftp<T>(
    alias: string,
    fn: (sftp: SFTPWrapper, addChannel: () => Promise<SFTPWrapper | undefined>) => Promise<T>,
  ): Promise<T> {
    const sessions: SFTPWrapper[] = []
    let slots = 0
    let holds = 0
    /** Set when the callback settles: a late `addChannel` must not leak resources. */
    let closed = false
    let conn: Client
    try {
      // An SFTP session IS a channel, so each one takes a slot: the ceiling this
      // protects is the server's MaxSessions, not our own bookkeeping.
      await this.acquireSlot(alias)
      slots += 1
      conn = await this.acquire(alias)
      // Hold BEFORE the first await (same reason as withSftp).
      this.hold(alias)
      holds += 1
      sessions.push(await this.openSession(conn))
      const addChannel = async (): Promise<SFTPWrapper | undefined> => {
        if (closed) return undefined
        // NEVER queue for an optional channel: a busy host would otherwise delay
        // the body of a download that is already streaming by up to
        // CHANNEL_WAIT_MS, which is worse than one channel.
        if (!this.tryAcquireSlot(alias)) return undefined
        slots += 1
        this.hold(alias)
        holds += 1
        try {
          const extra = await this.openSession(conn)
          if (closed) {
            // The transfer settled while this channel was opening; the finally
            // already returned its slot and hold, so close it here.
            try {
              extra.end()
            } catch {
              // Already gone.
            }
            return undefined
          }
          sessions.push(extra)
          return extra
        } catch {
          // The slot and hold this attempt took are released by the finally; one
          // channel still streams the file, so this is not a failure.
          return undefined
        }
      }
      return await fn(sessions[0] as SFTPWrapper, addChannel)
    } finally {
      closed = true
      for (const session of sessions) {
        try {
          session.end()
        } catch {
          // Ignore close errors.
        }
      }
      for (let i = 0; i < holds; i += 1) this.release(alias)
      for (let i = 0; i < slots; i += 1) this.releaseSlot(alias)
    }
  }

  /**
   * Run one callback on this alias's long-lived BROWSE SFTP session.
   *
   * Why: every list/stat/read used to open its own SFTP session, which is a
   * whole channel-open round trip BEFORE the operation's own round trip. A single
   * folder open is one list plus a stat per entry the explorer probes, and the
   * panel's revision refresh re-lists every open directory, so that open/close
   * churn sat directly on the click-to-pixels path. The session is shared by
   * every browse request for the alias; ssh2 multiplexes concurrent requests
   * over one channel by packet id (the same request map fastGet/fastPut use).
   *
   * Only read-only browse operations use it (`RemoteFiles.list/stat/read`):
   * writes, uploads and downloads keep their own short-lived session, so a
   * mutation never inherits a channel that a previous request may have left in
   * an odd state.
   *
   * The session holds one channel slot and one connection hold while it exists,
   * which is what a per-request session took too, so peak channel usage against
   * the server's MaxSessions does not change. The trade-off is that the slot
   * stays PARKED for up to `BROWSE_IDLE_MS` after the last request: the extras a
   * bulk transfer asks for use `tryAcquireSlot`, so they never wait on it.
   */
  async withBrowseSftp<T>(alias: string, fn: (sftp: SFTPWrapper) => Promise<T>, opts: SftpOptions = {}): Promise<T> {
    const lease = await this.leaseBrowse(alias)
    const limit = opts.timeoutMs ?? SFTP_OP_TIMEOUT_MS
    try {
      if (limit <= 0) return await fn(lease.sftp)
      return await withDeadline(fn(lease.sftp), limit, `SFTP operation on ${alias} timed out after ${limit / 1000}s`)
    } catch (error) {
      // A request that never answered stays queued inside ssh2, and this session
      // was already handed to other browse operations. Mark it stale: the next
      // lease retires it (leaseBrowse), and operations sharing it fail fast
      // instead of waiting out their own deadlines.
      if (error instanceof DeadlineError) {
        lease.state.stale = true
      }
      throw error
    } finally {
      this.touchBrowse(alias, lease.state)
    }
  }

  /** Upload one local file to an absolute remote path (parallel fastPut). */
  async putFile(alias: string, localPath: string, remotePath: string): Promise<void> {
    // A bulk upload must NOT run under the per-operation deadline: the helper
    // tarball is ~45 MB, so a fixed 60 s wall clock aborts a healthy transfer on
    // a slow link and reports it as a timeout. That was the intent all along —
    // but `withSftp` wrapped this callback in its own 60 s deadline anyway, so
    // the opt-out below is what makes it true. Progress is the bound instead:
    // any chunk resets the clock, and a stream that stops moving for
    // UPLOAD_IDLE_MS is the actual failure.
    await this.withSftp(alias, async (sftp) => {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const finish = (error?: Error): void => {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          if (error === undefined) resolve()
          else reject(error)
        }
        const arm = (): void => {
          if (timer !== undefined) clearTimeout(timer)
          timer = setTimeout(() => {
            try {
              sftp.end()
            } catch {
              // Ignore close errors; finish() still rejects.
            }
            finish(new Error(`SFTP upload stalled: no progress for ${UPLOAD_IDLE_MS / 1000}s`))
          }, UPLOAD_IDLE_MS)
          timer.unref?.()
        }
        arm()
        // ssh2's fastPut defaults to 64 concurrent WRITEs but only 32 KiB per
        // chunk; 256 KiB chunks amortise the two round trips per write (request
        // + status) and are what the sibling Tauri tool measured fastest for the
        // same library. Progress still arms the idle bound on every step.
        sftp.fastPut(localPath, remotePath, {
          concurrency: 64,
          chunkSize: 256 * 1024,
          step: () => { arm() },
        }, (error) => {
          finish(error === undefined || error === null ? undefined : new Error(error.message))
        })
      })
      // `timeoutMs: 0` = no wall clock; the idle timer above is the bound.
    }, { timeoutMs: 0 })
  }

  // ------------------------------------------------------------ internals

  /**
   * Open one SFTP session under its own deadline.
   *
   * ssh2 has no channel-open timeout: a server that never answers leaves this
   * promise pending forever, which pins the connection's hold count and blocks
   * idle re-arming (the "SSH looks dead" symptom) while the HTTP request hangs.
   */
  private openSession(conn: Client): Promise<SFTPWrapper> {
    return withDeadline(
      new Promise<SFTPWrapper>((resolve, reject) => {
        conn.sftp((error, session) => {
          if (error !== undefined && error !== null) reject(error)
          else resolve(session)
        })
      }),
      SFTP_OP_TIMEOUT_MS,
      `SFTP session open timed out after ${SFTP_OP_TIMEOUT_MS / 1000}s`,
    )
  }

  /**
   * Take the browse channel for one operation (open it on first use).
   *
   * The returned lease counts as one in-flight operation; the caller's `finally`
   * calls touchBrowse(). An open failure takes neither a slot nor a hold, so a
   * failed host does not leave the pool's accounting skewed.
   */
  private async leaseBrowse(alias: string): Promise<{ state: BrowseChannel; sftp: SFTPWrapper }> {
    const state = this.browseState(alias)
    // A session whose request hit its deadline is not trusted any more: retire it
    // NOW instead of handing it to the request that just arrived. Waiting for the
    // operations on it to drain looked safer, but any continuous browse traffic
    // (a hover prefetch every few seconds is enough) keeps `active` above zero and
    // postpones the retirement forever, so every subsequent list/stat/read paid
    // the full 60 s deadline. Peers sharing the retired session fail fast (the
    // close settles their requests) instead of waiting each of them out.
    if (state.stale) {
      this.evictBrowse(alias, state)
      return this.leaseBrowse(alias)
    }
    if (state.idle !== undefined) {
      clearTimeout(state.idle)
      state.idle = undefined
    }
    if (state.session !== undefined) {
      state.active += 1
      return { state, sftp: state.session }
    }
    if (state.opening === undefined) state.opening = this.openBrowse(alias, state)
    const opening = state.opening
    try {
      const sftp = await opening
      state.active += 1
      return { state, sftp }
    } finally {
      // Several callers may await the same open; clearing the shared field is
      // safe because each of them holds its own reference to the promise, and
      // the successful path has already stored `session` by now.
      if (state.opening === opening) state.opening = undefined
    }
  }

  /**
   * Open the browse session: a channel slot + a connection hold + the SFTP
   * session itself, all released together by evictBrowse().
   */
  private async openBrowse(alias: string, state: BrowseChannel): Promise<SFTPWrapper> {
    await this.acquireSlot(alias)
    let conn: Client
    try {
      conn = await this.acquire(alias)
    } catch (error) {
      this.releaseSlot(alias)
      throw error
    }
    // Hold before the first await, for the same reason withSftp does: a
    // concurrent release() must not arm idle eviction mid-open.
    this.hold(alias)
    state.leased = true
    try {
      const sftp = await this.openSession(conn)
      // The host can be dropped while the session is opening: the slot and hold
      // are already returned and nobody would ever close this channel, so refuse
      // it instead of handing out a session on a dead connection.
      if (this.browsed.get(alias) !== state || !state.leased) {
        try {
          sftp.end()
        } catch {
          // Already gone.
        }
        throw new Error(`host ${alias} was disconnected while opening the browse session`)
      }
      state.session = sftp
      // The channel can die on its own (remote restart, network blip). Clearing
      // bookkeeping here means the next browse operation reopens instead of
      // talking to a dead wrapper; a close we initiated is ignored because the
      // session has already been detached by evictBrowse().
      sftp.on('close', () => {
        if (state.session !== sftp) return
        state.session = undefined
        this.evictBrowse(alias, state)
      })
      return sftp
    } catch (error) {
      this.evictBrowse(alias, state)
      throw error
    }
  }

  /** One completed browse operation: idle-close the channel when it is unused. */
  private touchBrowse(alias: string, state: BrowseChannel): void {
    if (state.active > 0) state.active -= 1
    if (state.active > 0) return
    if (state.stale) {
      // The operation that timed out has settled, so nobody else is using the
      // channel: drop it now and let the next request open a fresh session.
      this.evictBrowse(alias, state)
      return
    }
    if (state.idle !== undefined) clearTimeout(state.idle)
    state.idle = setTimeout(() => {
      state.idle = undefined
      // The state may have been evicted (and replaced by a NEW session) while
      // this timer was pending — a tied eviction would close that successor.
      if (state.active === 0) this.evictBrowse(alias, state)
    }, BROWSE_IDLE_MS)
    state.idle.unref?.()
  }

  /**
   * Close the browse session and give its slot and hold back. Idempotent; every
   * way the session can end (idle, open failure, channel close, connection drop)
   * goes through here so the accounting cannot drift.
   *
   * `expected` ties the eviction to ONE session object: a timer or a channel
   * `close` event that fires after the state was already replaced must not close
   * its successor. Callers that end the connection (drop/dispose) omit it.
   */
  private evictBrowse(alias: string, expected?: BrowseChannel): void {
    const state = this.browsed.get(alias)
    if (state === undefined) return
    if (expected !== undefined && state !== expected) return
    this.browsed.delete(alias)
    if (state.idle !== undefined) {
      clearTimeout(state.idle)
      state.idle = undefined
    }
    const session = state.session
    state.session = undefined
    if (session !== undefined) {
      try {
        session.end()
      } catch {
        // Already gone.
      }
    }
    if (state.leased) {
      state.leased = false
      this.release(alias)
      this.releaseSlot(alias)
    }
  }

  private browseState(alias: string): BrowseChannel {
    const existing = this.browsed.get(alias)
    if (existing !== undefined) return existing
    const created: BrowseChannel = { session: undefined, opening: undefined, active: 0, stale: false, leased: false, idle: undefined }
    this.browsed.set(alias, created)
    return created
  }

  /**
   * Take one channel slot for `alias`, waiting FIFO when the limit is reached.
   * The wait is bounded: waiting forever behind a peer that never finishes is
   * worse than a readable error naming the cause and what to do about it.
   */
  private async acquireSlot(alias: string): Promise<void> {
    const state = this.slotState(alias)
    if (state.active < CHANNEL_LIMIT) {
      state.active += 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: SlotWaiter = { granted: false, resolve, reject, timer: undefined }
      waiter.timer = setTimeout(() => {
        // Whoever gets here first wins: a handover that already ran has taken
        // this waiter out of the queue and granted it, so the timeout must not
        // reject a slot its caller is about to use.
        if (waiter.granted) return
        waiter.granted = true
        const index = state.queue.indexOf(waiter)
        if (index >= 0) state.queue.splice(index, 1)
        reject(new Error(
          `remote host ${alias} is busy: ${CHANNEL_LIMIT} operations already hold channels `
          + `(this one waited ${CHANNEL_WAIT_MS / 1000}s — retry once the earlier work finishes)`,
        ))
      }, CHANNEL_WAIT_MS)
      waiter.timer.unref?.()
      state.queue.push(waiter)
    })
  }

  /**
   * Take one channel slot only if one is free RIGHT NOW; never queue.
   *
   * Optional work (a bulk transfer's second channel) must not wait behind
   * `CHANNEL_WAIT_MS` of other operations: a "best effort" extra channel that
   * delays the body of an already-streaming download by 30 s is worse than the
   * one channel the transfer would have used anyway. A queued waiter also blocks
   * the attempt on purpose — it has been waiting longer, and stealing its slot
   * would just move the wait.
   */
  private tryAcquireSlot(alias: string): boolean {
    const state = this.slotState(alias)
    if (state.active >= CHANNEL_LIMIT || state.queue.length > 0) return false
    state.active += 1
    return true
  }

  /** Give a slot back, handing it straight to the longest-waiting operation. */
  private releaseSlot(alias: string): void {
    const state = this.slots.get(alias)
    if (state === undefined) return
    const waiter = state.queue.shift()
    if (waiter !== undefined) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer)
      waiter.granted = true
      waiter.resolve()
      return
    }
    if (state.active > 0) state.active -= 1
    if (state.active === 0) this.slots.delete(alias)
  }

  private slotState(alias: string): Slots {
    const existing = this.slots.get(alias)
    if (existing !== undefined) return existing
    const created: Slots = { active: 0, queue: [] }
    this.slots.set(alias, created)
    return created
  }

  /**
   * Whether this alias offers a util-linux-style `setsid --wait` — the only
   * shape that both detaches the command into its own session AND reports its
   * exit code (p2/ssh-proc.ts:7-21 learned that plain `setsid` double-forks and
   * the channel then reports the wrapper's exit 0, which would turn every exit
   * fact into fiction). The probe also verifies status propagation, so a broken
   * setsid fails it instead of quietly corrupting exit codes.
   *
   * Probed once per alias: the probe is a whole extra channel, and exec is the
   * hot path (SCM polling, search, agent tools). A remote without a compatible
   * setsid keeps the pre-existing behaviour, where a timeout can only close the
   * channel, and says so in the log.
   *
   * Only SUCCESS is remembered. A failed probe means "this host has no
   * setsid OR this one call did not get through", and folding the second case
   * into the first would be permanent: a single transient blip — a dropped
   * connection, a 15 s probe timeout on a slow link — would silently switch the
   * alias to the unwrapped path for the rest of the process, i.e. quietly
   * disable the kill this wrapper exists to perform. Every other backoff in
   * this codebase retries rather than blacklisting; so does this one now.
   */
  private supportsSetsid(alias: string): Promise<boolean> {
    const cached = this.setsidProbes.get(alias)
    if (cached !== undefined) return cached
    const probe = this.exec(alias, SETSID_PROBE, { timeoutMs: CONTROL_TIMEOUT_MS, bare: true })
      .then(result => result.stdout.includes(SETSID_PROBE_MARK), () => false)
    this.setsidProbes.set(alias, probe)
    void probe.then((supported) => {
      // Forget a negative answer so the next exec probes again; a positive one
      // is a property of the host and stays until the connection is dropped.
      if (!supported && this.setsidProbes.get(alias) === probe) this.setsidProbes.delete(alias)
    })
    return probe
  }

  /** Hold the connection against idle eviction (balanced by release). */
  private hold(alias: string): void {
    const pooled = this.conns.get(alias)
    if (pooled === undefined) return
    pooled.held += 1
    pooled.lastUse = Date.now()
    if (pooled.timer !== undefined) {
      clearTimeout(pooled.timer)
      pooled.timer = undefined
    }
  }

  private release(alias: string): void {
    const pooled = this.conns.get(alias)
    if (pooled === undefined) return
    if (pooled.held > 0) pooled.held -= 1
    pooled.lastUse = Date.now()
    if (pooled.held > 0) return
    if (pooled.timer !== undefined) clearTimeout(pooled.timer)
    pooled.timer = setTimeout(() => this.drop(alias), IDLE_MS)
    if (typeof pooled.timer === 'object' && 'unref' in pooled.timer) pooled.timer.unref()
  }

  private async acquire(alias: string): Promise<Client> {
    const pooled = this.conns.get(alias)
    if (pooled !== undefined && pooled.connecting !== undefined) return pooled.connecting
    if (pooled !== undefined) {
      pooled.lastUse = Date.now()
      return pooled.conn
    }
    const entry: Pooled = { conn: undefined as unknown as Client, timer: undefined, lastUse: Date.now(), connecting: undefined, held: 0 }
    this.conns.set(alias, entry)
    entry.connecting = this.dial(alias).then(
      (conn) => {
        entry.conn = conn
        entry.connecting = undefined
        conn.on('close', () => {
          // The server went away: evict so the next op redials.
          if (this.conns.get(alias) === entry) this.drop(alias)
        })
        conn.on('error', () => {
          if (this.conns.get(alias) === entry) this.drop(alias)
        })
        this.release(alias)
        return conn
      },
      (error) => {
        this.conns.delete(alias)
        throw error
      },
    )
    return entry.connecting
  }

  private dial(alias: string): Promise<Client> {
    const host: RemoteHostEntry = this.store.require(alias)
    return new Promise<Client>((resolve, reject) => {
      const conn = new Client()
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        try {
          conn.end()
        } catch {
          // Ignore.
        }
        reject(explainAuthError(host, error))
      }
      conn.on('ready', () => {
        if (settled) return
        settled = true
        resolve(conn)
      })
      conn.on('error', (error: Error) => fail(error))
      conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        // Password entries answer a single hidden prompt (the standard
        // password challenge shape) with the stored password — many servers
        // offer keyboard-interactive instead of (or after) plain password.
        // Anything else (multi-prompt 2FA, visible echo) stays unsupported.
        const password = host.auth.kind === 'password' ? host.auth.password : undefined
        if (password !== undefined && prompts.length === 1 && prompts[0]?.echo === false) {
          try {
            finish([password])
          } catch {
            // Channel raced away; the error handler reports it.
          }
          return
        }
        fail(new Error('server requested keyboard-interactive auth (unsupported shape; use key auth or a password challenge)'))
        try {
          finish([])
        } catch {
          // Ignore.
        }
      })
      // TOFU host-key observation (P0): record, warn on change, still connect.
      const hostVerifier = (key: Buffer): boolean => {
        const fingerprint = createHash('sha256').update(key).digest('base64')
        const known = this.hostKeys.get(alias)
        if (known === undefined) {
          this.hostKeys.set(alias, fingerprint)
        } else if (known !== fingerprint) {
          // eslint-disable-next-line no-console
          console.warn(`[dsh-remote-vs] host key changed for ${alias}: was ${known}, now ${fingerprint}`)
        }
        return true
      }
      try {
        if (host.auth.kind === 'key') {
          const keyPath = host.auth.keyPath as string
          conn.connect({
            host: host.host,
            port: host.port,
            username: host.user,
            privateKey: readFileSync(keyPath),
            passphrase: host.auth.passphrase,
            readyTimeout: READY_TIMEOUT_MS,
            keepaliveInterval: 30_000,
            keepaliveCountMax: 3,
            hostVerifier,
          })
        } else {
          conn.connect({
            host: host.host,
            port: host.port,
            username: host.user,
            password: host.auth.password,
            tryKeyboard: true,
            readyTimeout: READY_TIMEOUT_MS,
            keepaliveInterval: 30_000,
            keepaliveCountMax: 3,
            hostVerifier,
          })
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}

/**
 * Translate ssh2's generic auth failure into something actionable. Never
 * includes secrets — only the entry shape and the likely server-side causes.
 */
function explainAuthError(host: RemoteHostEntry, error: Error): Error {
  if (host.auth.kind !== 'password' || !/authentication methods failed/i.test(error.message)) {
    return error
  }
  const hints = [
    'verify the password (it may have changed/expired)',
    'many servers only offer keyboard-interactive (now auto-answered — retry the test)',
  ]
  if (host.user === 'root') {
    hints.push('OpenSSH 7+ defaults prohibit password login for root (PermitRootLogin); use a non-root user or switch to key auth')
  }
  return new Error(`${error.message} — password rejected by the server; ${hints.join('; ')}`)
}

/** Append with a 2 MiB cap and a truncation marker. */
function appendCapped(current: string, chunk: string): string {
  if (current.length >= OUTPUT_CAP) return current
  const next = current + chunk
  if (next.length <= OUTPUT_CAP) return next
  return next.slice(0, OUTPUT_CAP) + TRUNCATED_MARKER
}

/**
 * Put one shell line in its own session/process group.
 *
 * `setsid --wait` is what makes the timeout able to end the command: the
 * wrapper echoes its own pid, which IS the new session's process-group id, and
 * this pid is what `kill -- -<pgid>` needs. Everything the command spawns stays
 * in that group, so a pipeline's whole tree dies with it — `channel.close()`
 * only releases our side, and `channel.signal()` addresses the outer shell.
 *
 * `$0` is the login shell sshd itself used for this line, so a bashism in a
 * caller's line keeps working on a remote whose /bin/sh is dash (a leading dash
 * — login-shell argv[0] — is not an executable, hence the fallback to `sh`).
 * The line travels as a positional argument rather than being re-quoted into
 * the wrapper, so quoting and `$` expansion stay exactly as they were.
 */
function sessionLine(command: string): string {
  const shell = '"${0:-sh}"'
  const pick = `rv_shell=${shell}; case "$rv_shell" in -*) rv_shell=sh;; esac`
  const wrap = `setsid --wait "$rv_shell" -c 'echo ${PGID_MARKER}$$; exec "$0" -c "$1"' "$rv_shell" ${shq(command)}`
  return `${pick}; exec ${wrap}`
}

/** Single-quote one word for POSIX sh (same quoting p2/ssh-proc.ts uses). */
function shq(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}

/**
 * Consume the session wrapper's leading `RV_PID=<pgid>` line. The wrapper
 * writes it before it execs the target, so it is the first line of the stream
 * by construction; anything else is left untouched, which keeps a command that
 * happens to print a similar first line intact.
 */
function takePgid(out: string): { pgid: number | undefined; out: string } {
  const newline = out.indexOf('\n')
  if (newline < 0) return { pgid: undefined, out }
  const line = out.slice(0, newline).replace(/\r$/, '')
  if (!line.startsWith(PGID_MARKER)) return { pgid: undefined, out }
  const digits = line.slice(PGID_MARKER.length)
  if (!/^\d+$/.test(digits)) return { pgid: undefined, out }
  return { pgid: Number(digits), out: out.slice(newline + 1) }
}

/**
 * A timed-out line whose process group was never learned cannot be killed, so
 * say it out loud instead of pretending the command stopped.
 */
function warnDetached(alias: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[dsh-remote-vs] exec timed out on ${alias}: the channel is closed but the remote command may still be running (no killable process group)`)
}

/**
 * An operation that ran out of its wall-clock budget.
 *
 * Tagged on purpose: callers have to tell "the remote never answered" from a real
 * remote failure (a missing path must not cost the session), and matching on the
 * message text would silently stop working the moment the template changed.
 */
export class DeadlineError extends Error {}

/**
 * Reject when `promise` has not settled within `ms`, so a stalled remote
 * callback cannot keep a session (and its pooled connection) alive forever.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(message)), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}
