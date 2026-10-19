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

/** First cooldown after a failed dial; doubles per consecutive failure, then caps. */
const DIAL_BACKOFF_BASE_MS = 60_000
const DIAL_BACKOFF_MAX_MS = 300_000

/**
 * Cooldown to apply after the Nth consecutive failed dial (1-based).
 *
 * A failed dial evicts the cache entry, so without this every subsequent call
 * dials again — and against an sshd that is not answering, each of those is one
 * more connection sitting in the pre-auth limbo that exhausted `MaxStartups` in
 * the first place. Retrying during an outage made the outage worse, so the
 * cooldown grows until an attempt finally succeeds.
 */
export function dialBackoffMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1)
  return Math.min(DIAL_BACKOFF_BASE_MS * 2 ** exponent, DIAL_BACKOFF_MAX_MS)
}

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

interface Pooled {
  conn: Client
  timer: ReturnType<typeof setTimeout> | undefined
  lastUse: number
  connecting: Promise<Client> | undefined
  /** Live users (channels/sessions); idle eviction only fires at zero. */
  held: number
}

export interface ExecOptions {
  timeoutMs?: number
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
  /**
   * Consecutive dial failures per alias, and when dialing becomes allowed again.
   *
   * Only CONNECTION ESTABLISHMENT is counted. A failure on an already-open
   * connection evicts it through `close`/`error` and re-dials normally; treating
   * that as a strike would lock out a host over one transient operation.
   */
  private readonly dialFailures = new Map<string, { count: number; retryAt: number; last: string }>()

  constructor(private readonly store: RemoteStore) {}

  /** Drop one pooled connection (call after host update/delete). */
  drop(alias: string): void {
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
            finish({ success: code === 0, exitCode: code, timedOut: false, stdout: out, stderr: err })
          })
          channel.on('data', (chunk: Buffer) => {
            out = appendCapped(out, chunk.toString('utf8'))
            if (pgid !== undefined || !markerPending) return
            const marker = takePgid(out)
            if (marker.pgid !== undefined) {
              pgid = marker.pgid
              out = marker.out
              markerPending = false
              // Only reachable when the timeout fired before this channel was
              // open: the group had no id then, so kill it now that it has one.
              if (timedOut) terminateGroup()
            } else if (out.includes('\n')) {
              // The first line is the command's own output, not our marker.
              markerPending = false
            }
          })
          channel.stderr.on('data', (chunk: Buffer) => {
            err = appendCapped(err, chunk.toString('utf8'))
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
      // The session open needs its own deadline. It used to sit outside the
      // `withDeadline` below, and ssh2 has no channel-open timeout — a server
      // that never answers leaves this promise pending forever, which pins
      // `held` above zero and therefore blocks idle re-arming (the "SSH looks
      // dead" symptom) while the HTTP request hangs.
      const sftp = await withDeadline(
        new Promise<SFTPWrapper>((resolve, reject) => {
          conn.sftp((error, session) => {
            if (error !== undefined && error !== null) reject(error)
            else resolve(session)
          })
        }),
        SFTP_OP_TIMEOUT_MS,
        `SFTP session open timed out after ${SFTP_OP_TIMEOUT_MS / 1000}s`,
      )
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
        sftp.fastPut(localPath, remotePath, { step: () => { arm() } }, (error) => {
          finish(error === undefined || error === null ? undefined : new Error(error.message))
        })
      })
      // `timeoutMs: 0` = no wall clock; the idle timer above is the bound.
    }, { timeoutMs: 0 })
  }

  // ------------------------------------------------------------ internals

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
    // Only a would-be DIAL is refused here: a cached connection is returned
    // above, so a healthy host is never blocked by an earlier outage.
    const paused = this.dialFailures.get(alias)
    if (paused !== undefined && Date.now() < paused.retryAt) {
      const wait = Math.max(1, Math.ceil((paused.retryAt - Date.now()) / 1000))
      throw new Error(
        `remote host ${alias}: ${paused.count} consecutive connection failures, `
        + `so dialing is paused for another ${wait}s — retrying now cannot succeed and only adds load `
        + `(last error: ${paused.last})`,
      )
    }
    const entry: Pooled = { conn: undefined as unknown as Client, timer: undefined, lastUse: Date.now(), connecting: undefined, held: 0 }
    this.conns.set(alias, entry)
    entry.connecting = this.dial(alias).then(
      (conn) => {
        this.dialFailures.delete(alias)
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
        const count = (this.dialFailures.get(alias)?.count ?? 0) + 1
        this.dialFailures.set(alias, {
          count,
          retryAt: Date.now() + dialBackoffMs(count),
          last: error instanceof Error ? error.message : String(error),
        })
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
 * Reject when `promise` has not settled within `ms`, so a stalled remote
 * callback cannot keep a session (and its pooled connection) alive forever.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
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
