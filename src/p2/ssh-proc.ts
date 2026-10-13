/**
 * Remote subprocess runtime over ssh2 exec channels: stdout/stderr separation,
 * collect-mode offset readers, stdin dispositions, TERM→KILL escalation and
 * exit facts. No PTY, no control channel, no spill files in P2-v1 (honest
 * limits, documented at each seam).
 *
 * Wrapper design (proven by .spike/dbg6 + dbg7 against util-linux 2.37.2):
 *
 * - `setsid --wait sh -c 'echo RV_PID=$$; exec "$@"' _ <argv...>` puts the
 *   target in its own session/process group AND propagates its exit code.
 *   Plain `setsid` (no --wait) double-forks: the outer shell exits at once
 *   (target reparented to PPID=1) and the channel reports the outer shell's
 *   exit 0 instead of the target's code — exit facts would be fiction.
 * - Group kill (`kill -TERM -- -<pgid>`) is the ONLY reliable termination:
 *   `channel.signal()` addresses the outer shell, which is useless once the
 *   wrapper detaches. When the pgid is not learned yet, terminate() waits for
 *   the marker (bounded) instead of signalling blindly.
 * - Platforms without a compatible setsid fall back to a leader-only line
 *   (`cd … && env … exec <argv...>`, no new session): channel.signal hits the
 *   exec'd target directly. First failure auto-retries inside the same spawn;
 *   later spawns skip setsid (self-healing, no caller-visible error).
 *
 * Managed range = the exec channel lifetime plus the target's process group.
 * Double-fork daemons that escape the group survive termination (documented,
 * same as Yan-Zero); waitForExit observes channel close.
 */
import { PassThrough, Writable, type Readable } from 'node:stream'
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ClientChannel } from 'ssh2'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessStdinMode,
} from '@deepseek-ai/dsh-subprocess'
import type { RemotePool } from '../pool.ts'

/** Single-quote one argv/env word for POSIX sh. */
function shq(word: string): string {
  if (word.includes('\0')) throw new Error('NUL byte in spawn argument')
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/** Strip a Windows absolute executable to a remote-resolvable bare name. */
export function remoteCommand(input: string): string {
  const base = input.replace(/\\/g, '/').split('/').pop() ?? input
  return base.replace(/\.exe$/i, '')
}

/** How long terminate() waits for the RV_PID marker before last-resort kill. */
const MARKER_TIMEOUT_MS = 8000

/** Safety net after KILL: force local channel close if sshd stays silent. */
const SAFETY_CLOSE_MS = 5000

/** Host-side spill dir for over-cap collected output (seam-internal, transient). */
function spillDir(): string {
  const dir = join(tmpdir(), 'dsh-remote-spills')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Best-effort TTL sweep: spills older than a day are dead (crashed owner). */
function sweepSpills(now: number): void {
  let dir: string
  try {
    dir = spillDir()
  } catch {
    return
  }
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith('dsh-remote-spill-')) continue
    try {
      if (now - statSync(join(dir, name)).mtimeMs > 24 * 3600 * 1000) rmSync(join(dir, name), { force: true })
    } catch {
      // Ignore per-file failures.
    }
  }
}

/**
 * One collected stream: tail window + offset readers + optional full-stream
 * spill file (Host disk). Mirrors the stock local runtime's contract
 * (dsh-subprocess SubprocessCollect): with `spill` configured, overflow
 * appends to the spill file; readFrom ALWAYS returns the tail window (with
 * honest lossy flags) and attaches spillPath when the spill is intact — the
 * complete stream lives in the FILE (read by model/tool via fs), never
 * inline. Past spill.maxBytes the incomplete spill is discarded (tail only).
 * Without `spill`, tail-only, no path (diagnostic-tail shape).
 */
class CollectStream {
  private buffers: Buffer[] = []
  private bufferedBytes = 0
  private totalBytes = 0
  private readonly maxBytes: number
  private readonly spillCap: number | undefined
  private readonly streamName: string
  private spillPath: string | undefined
  private spillFd: number | undefined
  private spilledBytes = 0
  private spillDead = false
  private spillWarned = false

  constructor(collect: SubprocessCollect, streamName: string) {
    this.maxBytes = Math.max(1, Math.floor(collect.maxBytes))
    this.spillCap = collect.spill === undefined ? undefined : Math.max(1, Math.floor(collect.spill.maxBytes))
    this.streamName = streamName
  }

  push(chunk: Buffer): void {
    if (this.spillCap !== undefined && !this.spillDead) {
      if (this.totalBytes + chunk.length > this.spillCap) {
        this.discardSpill()
      } else {
        // Overflow begins (or continues): spill holds [0, total) complete.
        if (this.spillPath === undefined && this.bufferedBytes + chunk.length > this.maxBytes) {
          this.spillCreate()
          // Flush the bytes buffered so far, then the new chunk below.
          if (!this.spillDead) {
            for (const b of this.buffers) this.spillWrite(b)
          }
        }
        if (!this.spillDead) this.spillWrite(chunk)
      }
    }
    this.totalBytes += chunk.length
    this.buffers.push(chunk)
    this.bufferedBytes += chunk.length
    while (this.bufferedBytes > this.maxBytes && this.buffers.length > 1) {
      const head = this.buffers.shift() as Buffer
      this.bufferedBytes -= head.length
    }
    if (this.bufferedBytes > this.maxBytes) {
      const only = this.buffers[0] as Buffer
      this.buffers = [only.subarray(only.length - this.maxBytes)]
      this.bufferedBytes = this.buffers[0]?.length ?? 0
    }
  }

  reader(): SubprocessOutputReader {
    return {
      readFrom: (fromByte: number) => {
        // Stock-faithful: text is ALWAYS the tail window; the spill file
        // (when intact) carries the complete stream out-of-band.
        const spill = this.spillPathNow()
        const windowStart = this.totalBytes - this.bufferedBytes
        if (fromByte < windowStart) {
          return {
            text: Buffer.concat(this.buffers).toString('utf8'),
            nextOffset: this.totalBytes,
            lossy: true,
            ...(spill === undefined ? {} : { spillPath: spill }),
          }
        }
        const slice = Buffer.concat(this.buffers).subarray(Math.max(0, fromByte - windowStart))
        return {
          text: slice.toString('utf8'),
          nextOffset: this.totalBytes,
          lossy: false,
          ...(spill === undefined ? {} : { spillPath: spill }),
        }
      },
    }
  }

  /** Release the spill fd (the FILE persists for model readback; TTL-swept). */
  dispose(): void {
    if (this.spillFd !== undefined) {
      try {
        closeSync(this.spillFd)
      } catch {
        // Ignore.
      }
      this.spillFd = undefined
    }
  }

  private spillCreate(): void {
    try {
      sweepSpills(Date.now())
      const path = join(spillDir(), `dsh-remote-spill-${this.streamName}-${randomUUID()}.bin`)
      this.spillFd = openSync(path, 'w')
      this.spillPath = path
    } catch {
      this.warnSpill('cannot create spill file; degrading to tail-only')
      this.spillDead = true
    }
  }

  private spillWrite(chunk: Buffer): void {
    if (this.spillFd === undefined) return
    try {
      writeSync(this.spillFd, chunk)
      this.spilledBytes += chunk.length
    } catch {
      this.warnSpill('cannot append spill file; degrading to tail-only')
      this.discardSpill()
    }
  }

  private discardSpill(): void {
    if (this.spillFd !== undefined) {
      try {
        closeSync(this.spillFd)
      } catch {
        // Ignore.
      }
      this.spillFd = undefined
    }
    if (this.spillPath !== undefined) {
      try {
        rmSync(this.spillPath, { force: true })
      } catch {
        // Ignore.
      }
      this.spillPath = undefined
    }
    this.spillDead = true
  }

  /** Intact spill path, or undefined (discarded, unconfigured, or desynced). */
  private spillPathNow(): string | undefined {
    if (this.spillPath === undefined || this.spillDead) return undefined
    // Only advertise when the file holds every byte (a post-dispose stray
    // push would desync it — withhold the path instead of lying).
    if (this.spilledBytes !== this.totalBytes) return undefined
    return this.spillPath
  }

  private warnSpill(message: string): void {
    if (this.spillWarned) return
    this.spillWarned = true
    // eslint-disable-next-line no-console
    console.warn(`[dsh-remote-vs] ${message}`)
  }
}

function isCollect(mode: SubprocessOutputMode): mode is SubprocessCollect {
  return typeof mode === 'object'
}

/** Build the remote shell line: cd + env + setsid --wait wrapper + argv. */
function buildCommand(spec: SubprocessSpawnSpec): string {
  const parts: string[] = [`cd ${shq(spec.cwd)}`, '&&']
  const env = spec.env ?? {}
  const unsets = Object.entries(env).filter(([, value]) => value === undefined).map(([key]) => key)
  const sets = Object.entries(env).filter(([, value]) => value !== undefined) as [string, string][]
  const inner: string[] = []
  if (unsets.length > 0 || sets.length > 0) {
    inner.push('env')
    for (const key of unsets) inner.push('-u', key)
    for (const [key, value] of sets) inner.push(`${key}=${shq(value)}`)
  }
  inner.push(...spec.argv.map(shq))
  parts.push(`setsid --wait sh -c ${shq('echo RV_PID=$$; exec "$@"')} _ ${inner.join(' ')}`)
  if (spec.stdio.stdin === 'ignore') {
    // Seam contract: 'ignore' leaves fd 0 on /dev/null (NOT an empty pipe:
    // tools like rg treat no-path + pipe-stdin as "search stdin" and return
    // zero matches — 2026-10-13 grep-omitted-path incident).
    parts.push('< /dev/null')
  }
  return parts.join(' ')
}

/**
 * Same line without setsid (platforms lacking it; leader-only range). `exec`
 * replaces the outer shell so channel.signal addresses the target itself.
 */
function buildCommandNoSetsid(spec: SubprocessSpawnSpec): string {
  const parts: string[] = [`cd ${shq(spec.cwd)}`, '&&']
  const env = spec.env ?? {}
  const unsets = Object.entries(env).filter(([, value]) => value === undefined).map(([key]) => key)
  const sets = Object.entries(env).filter(([, value]) => value !== undefined) as [string, string][]
  if (unsets.length > 0 || sets.length > 0) {
    parts.push('env')
    for (const key of unsets) parts.push('-u', key)
    for (const [key, value] of sets) parts.push(`${key}=${shq(value)}`)
  }
  parts.push('exec', ...spec.argv.map(shq))
  // Seam contract: 'ignore' leaves fd 0 on /dev/null (see buildCommand).
  if (spec.stdio.stdin === 'ignore') parts.push('< /dev/null')
  return parts.join(' ')
}

export class SshProcRuntime {
  private readonly live = new Set<() => void>()
  /** Whether the remote offers a compatible setsid(1); optimistic until disproven. */
  private setsid: boolean | undefined

  constructor(
    private readonly pool: RemotePool,
    private readonly alias: string,
  ) {}

  /** Resolve via remote `command -v` (Windows paths reduce to bare names). */
  async resolveExecutable(command: string): Promise<string> {
    const name = /^[A-Za-z]:[\\/]/.test(command) || command.includes('\\') ? remoteCommand(command) : command
    const result = await this.pool.exec(this.alias, `command -v -- ${shq(name)}`, { timeoutMs: 15000 })
    const resolved = result.stdout.trim().split('\n')[0]?.trim() ?? ''
    if (!result.success || resolved === '') {
      throw new SubprocessExecutableNotFoundError(`remote executable not found: ${command}`)
    }
    return resolved
  }

  terminalEnvironment(): { platform: 'posix'; defaultShell: string } {
    return { platform: 'posix', defaultShell: '/bin/bash' }
  }

  /** Spawn one managed remote process. Throws synchronously on invalid spec. */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (spec.argv.length === 0 || typeof spec.argv[0] !== 'string' || spec.argv[0] === '') {
      throw new Error('spawn requires a non-empty argv[0]')
    }
    if (typeof spec.cwd !== 'string' || !spec.cwd.startsWith('/')) {
      throw new Error(`remote spawn needs an absolute POSIX cwd, got: ${spec.cwd}`)
    }
    if (!Number.isFinite(spec.graceMs) || spec.graceMs < 0) {
      throw new Error(`remote spawn needs a non-negative graceMs, got: ${spec.graceMs}`)
    }
    if (spec.stdio.control === 'pipe') {
      throw new Error('remote control channels are not implemented in P2-v1')
    }
    if (spec.signal?.aborted === true) {
      throw new Error('spawn aborted before start')
    }
    const useSetsid = this.setsid ?? true
    return new SshProcHandle(this.pool, this.alias, spec, useSetsid, () => {
      this.setsid = false
    }, this.live)
  }

  /** Terminate every live remote process (service disposal). */
  async dispose(): Promise<void> {
    const pending = [...this.live]
    this.live.clear()
    await Promise.allSettled(pending.map(async (terminate) => {
      try {
        terminate()
      } catch {
        // Ignore teardown races.
      }
    }))
  }
}

class SshProcHandle implements SubprocessHandle {
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  readonly control = undefined
  readonly collected: { stdout?: SubprocessOutputReader; stderr?: SubprocessOutputReader }
  readonly done: Promise<SubprocessOutcome>

  private channel: ClientChannel | undefined
  private settled = false
  private killRequested = false
  private terminating = false
  private killedSignal: NodeJS.Signals | undefined
  private termFired = false
  private useSetsid = true
  private retriedNoSetsid = false
  private pgid: number | undefined
  private pgidWaiters: Array<() => void> = []
  private markerPending = true
  private markerBuf = Buffer.alloc(0)
  private stderrHead = ''
  private readonly outCollect: CollectStream | undefined
  private readonly errCollect: CollectStream | undefined
  private readonly outPipe: PassThrough | undefined
  private readonly errPipe: PassThrough | undefined
  private readonly stdoutStripped = new PassThrough()
  private stdinFlush: () => void = () => {}
  private readonly abortListener: (() => void) | undefined
  private readonly resolveDone: (outcome: SubprocessOutcome) => void
  private readonly rejectDone: (error: unknown) => void
  private readonly finish: () => void

  constructor(
    private readonly pool: RemotePool,
    private readonly alias: string,
    private readonly spec: SubprocessSpawnSpec,
    useSetsid: boolean,
    private readonly onSetsidMissing: () => void,
    live: Set<() => void>,
  ) {
    this.useSetsid = useSetsid
    this.markerPending = useSetsid
    const terminate = (): void => {
      this.terminate()
    }
    live.add(terminate)
    this.finish = (): void => {
      live.delete(terminate)
    }

    if (isCollect(spec.stdio.stdout)) {
      this.outCollect = new CollectStream(spec.stdio.stdout, 'stdout')
    } else if (spec.stdio.stdout === 'pipe') {
      this.outPipe = new PassThrough()
    }
    if (isCollect(spec.stdio.stderr)) {
      this.errCollect = new CollectStream(spec.stdio.stderr, 'stderr')
    } else if (spec.stdio.stderr === 'pipe') {
      this.errPipe = new PassThrough()
    }
    this.collected = {
      ...(this.outCollect !== undefined ? { stdout: this.outCollect.reader() } : {}),
      ...(this.errCollect !== undefined ? { stderr: this.errCollect.reader() } : {}),
    }

    let resolveDone!: (outcome: SubprocessOutcome) => void
    let rejectDone!: (error: unknown) => void
    this.done = new Promise<SubprocessOutcome>((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })
    this.resolveDone = resolveDone
    this.rejectDone = rejectDone
    // Latch rejection fast: a stored rejection nobody awaits is an unhandled rejection.
    void this.done.catch(() => {})

    if (spec.signal !== undefined) {
      const onAbort = (): void => {
        this.terminate()
      }
      spec.signal.addEventListener('abort', onAbort, { once: true })
      this.abortListener = () => spec.signal?.removeEventListener('abort', onAbort)
    }

    const stdinMode: SubprocessStdinMode = spec.stdio.stdin
    if (stdinMode === 'pipe') {
      const pending: Buffer[] = []
      let ended = false
      let bound: ClientChannel | undefined
      const flush = (): void => {
        const channel = bound ?? this.channel
        if (channel === undefined) return
        bound = channel
        while (pending.length > 0) {
          const chunk = pending.shift() as Buffer
          try {
            channel.write(chunk)
          } catch {
            // Channel raced away.
          }
        }
        if (ended) {
          try {
            channel.end()
          } catch {
            // Ignore.
          }
        }
      }
      this.stdinFlush = flush
      this.stdin = new Writable({
        write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
          pending.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          flush()
          callback()
        },
        final(callback: (error?: Error | null) => void): void {
          ended = true
          flush()
          callback()
        },
      })
    } else {
      this.stdin = undefined
    }
    this.stdout = this.outPipe
    this.stderr = this.errPipe

    // Output fan-out. Stdout passes a marker stripper that consumes the
    // leading `RV_PID=<pgid>` line (setsid sessions only).
    const forward = (
      stream: NodeJS.ReadableStream,
      mode: SubprocessOutputMode,
      collect: CollectStream | undefined,
      pipe: PassThrough | undefined,
      host: NodeJS.WritableStream,
    ): void => {
      stream.on('data', (chunk: Buffer) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        if (collect !== undefined) collect.push(buffer)
        if (pipe !== undefined) pipe.write(buffer)
        if (mode === 'inherit') {
          try {
            host.write(buffer)
          } catch {
            // Ignore host stream errors.
          }
        }
      })
    }
    forward(this.stdoutStripped, spec.stdio.stdout, this.outCollect, this.outPipe, process.stdout)

    void this.open()
  }

  /** Open the exec channel (once; setsid-incompatible remotes retry internally). */
  private async open(): Promise<void> {
    const { spec } = this
    const stdinMode: SubprocessStdinMode = spec.stdio.stdin
    try {
      const channel = await this.pool.execChannel(this.alias, this.useSetsid ? buildCommand(spec) : buildCommandNoSetsid(spec))
      if (this.settled) {
        channel.close()
        return
      }
      this.channel = channel
      // Listeners first: a pending terminate() needs the marker and close
      // events (attaching after the killRequested check would strand the
      // handle with no pgid and no settlement).
      channel.on('data', (chunk: Buffer) => {
        this.stripMarker(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
      })
      channel.stderr.on('data', (chunk: Buffer) => {
        if (this.stderrHead.length < 2048) {
          this.stderrHead += chunk.toString('utf8').slice(0, 2048 - this.stderrHead.length)
        }
      })
      const forwardErr = (chunk: Buffer): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        if (this.errCollect !== undefined) this.errCollect.push(buffer)
        if (this.errPipe !== undefined) this.errPipe.write(buffer)
        if (spec.stdio.stderr === 'inherit') {
          try {
            process.stderr.write(buffer)
          } catch {
            // Ignore host stream errors.
          }
        }
      }
      channel.stderr.on('data', forwardErr)
      channel.on('close', (code: number | null, signalName?: string | null) => {
        this.onClose(code, signalName)
      })
      channel.on('error', (error: Error) => {
        this.fail(error)
      })
      if (this.killRequested) {
        this.terminate()
        return
      }
      // stdin disposition (skipped when already terminating: no point feeding
      // a process we are about to kill).
      if (stdinMode === 'ignore') {
        try {
          channel.end()
        } catch {
          // Ignore.
        }
      } else if (typeof stdinMode === 'object') {
        try {
          channel.write(stdinMode.data)
        } catch {
          // Ignore.
        }
        try {
          channel.end()
        } catch {
          // Ignore.
        }
      } else {
        this.stdinFlush()
      }
    } catch (error) {
      this.fail(error)
    }
  }

  private onClose(code: number | null, signalName?: string | null): void {
    // setsid-incompatible remote (missing binary or no --wait): the wrapper
    // died pre-exec, the target never ran. Degrade once, internally.
    if (this.useSetsid && this.pgid === undefined && !this.retriedNoSetsid && /setsid/i.test(this.stderrHead)) {
      this.retriedNoSetsid = true
      this.useSetsid = false
      this.markerPending = false
      this.onSetsidMissing()
      this.channel = undefined
      this.stderrHead = ''
      void this.open()
      return
    }
    this.flushMarker()
    if (this.killedSignal !== undefined) {
      // We killed it: report our signal, not the channel's code (the wrapper
      // chain's exit status is noise once we intervene).
      this.settle({ exitCode: null, signal: this.killedSignal })
      return
    }
    this.settle({
      exitCode: signalName !== undefined && signalName !== null ? null : (code ?? 0),
      signal: signalName !== undefined && signalName !== null ? (`SIG${signalName}` as NodeJS.Signals) : null,
    })
  }

  terminate(): void {
    this.killRequested = true
    if (this.settled || this.terminating) return
    if (this.channel === undefined) return // Post-open hook re-enters.
    this.terminating = true
    this.killedSignal = 'SIGTERM'
    if (!this.useSetsid) {
      // Leader-only line: the outer shell exec'd the target, so the channel
      // signal addresses the target itself.
      this.signalLeader('TERM')
      this.scheduleEscalation()
      return
    }
    // setsid world: group kill once the pgid is learned (bounded wait);
    // signalling the channel would only hit the wrapper chain.
    this.onPgidKnown(() => this.fireTerm())
    setTimeout(() => {
      if (!this.termFired && !this.settled) this.fallbackKill()
    }, MARKER_TIMEOUT_MS).unref?.()
    this.scheduleEscalation()
  }

  private scheduleEscalation(): void {
    const grace = Math.min(Math.max(0, this.spec.graceMs), 2147483647)
    setTimeout(() => {
      if (this.settled) return
      this.killedSignal = 'SIGKILL'
      if (this.useSetsid) {
        this.onPgidKnown(() => this.groupKill('KILL'))
      } else {
        this.signalLeader('KILL')
      }
      setTimeout(() => {
        if (this.settled) return
        try {
          this.channel?.close()
        } catch {
          // Ignore.
        }
      }, SAFETY_CLOSE_MS).unref?.()
    }, grace).unref?.()
  }

  private fireTerm(): void {
    if (this.termFired || this.settled) return
    this.termFired = true
    this.groupKill('TERM')
  }

  /** Marker never arrived: last resort (channel signal + warn about orphans). */
  private fallbackKill(): void {
    if (this.settled) return
    this.termFired = true
    try {
      this.channel?.signal('TERM')
    } catch {
      // Ignore.
    }
    // eslint-disable-next-line no-console
    console.warn(`[dsh-remote-vs] remote kill without pgid for ${this.alias} (marker missing): the wrapper chain was signalled but detached descendants may survive`)
  }

  private groupKill(signal: 'TERM' | 'KILL'): void {
    const pgid = this.pgid
    if (pgid === undefined || this.settled) return
    void this.pool.exec(this.alias, `kill -${signal} -- -${pgid}`, { timeoutMs: 15000 }).catch(() => undefined)
  }

  private signalLeader(signal: 'TERM' | 'KILL'): void {
    try {
      this.channel?.signal(signal)
    } catch {
      // Fall through to close.
    }
  }

  /** Run cb now if the pgid is known, else when the marker lands. */
  private onPgidKnown(cb: () => void): void {
    if (this.pgid !== undefined) {
      cb()
      return
    }
    this.pgidWaiters.push(cb)
  }

  /** Consume a leading `RV_PID=<pgid>` line; forward everything else. */
  private stripMarker(chunk: Buffer): void {
    const out = this.stdoutStripped
    if (!this.markerPending) {
      out.write(chunk)
      return
    }
    this.markerBuf = Buffer.concat([this.markerBuf, chunk])
    const newline = this.markerBuf.indexOf(0x0a)
    if (newline === -1) {
      if (this.markerBuf.length > 1024) {
        // Not a marker after all: flush and stop looking.
        this.markerPending = false
        out.write(this.markerBuf)
        this.markerBuf = Buffer.alloc(0)
      }
      return
    }
    const line = this.markerBuf.subarray(0, newline).toString('utf8').trim()
    const rest = this.markerBuf.subarray(newline + 1)
    this.markerBuf = Buffer.alloc(0)
    this.markerPending = false
    const match = /^RV_PID=(\d+)$/.exec(line)
    if (match?.[1] !== undefined) {
      this.pgid = Number(match[1])
      const waiters = this.pgidWaiters
      this.pgidWaiters = []
      for (const waiter of waiters) {
        try {
          waiter()
        } catch {
          // Kill dispatch must never throw.
        }
      }
    } else {
      // First line wasn't ours (unexpected wrapper output): keep it.
      out.write(Buffer.concat([Buffer.from(`${line}\n`, 'utf8'), rest]))
      return
    }
    if (rest.length > 0) out.write(rest)
  }

  /** Flush a partial marker buffer at close (no pgid learned). */
  private flushMarker(): void {
    if (this.markerBuf.length > 0) {
      this.stdoutStripped.write(this.markerBuf)
      this.markerBuf = Buffer.alloc(0)
    }
    this.markerPending = false
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (this.settled) return true
    if (signal?.aborted === true) return false
    return new Promise<boolean>((resolve) => {
      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        cleanup()
        resolve(false)
      }
      void this.done.then(
        () => {
          cleanup()
          resolve(true)
        },
        () => {
          cleanup()
          resolve(true)
        },
      )
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private settle(outcome: SubprocessOutcome): void {
    if (this.settled) return
    this.settled = true
    this.outPipe?.end()
    this.errPipe?.end()
    this.outCollect?.dispose()
    this.errCollect?.dispose()
    this.abortListener?.()
    this.resolveDone(outcome)
    this.finish()
  }

  private fail(error: unknown): void {
    if (this.settled) return
    this.settled = true
    this.outPipe?.destroy()
    this.errPipe?.destroy()
    this.outCollect?.dispose()
    this.errCollect?.dispose()
    try {
      this.channel?.close()
    } catch {
      // Ignore.
    }
    this.abortListener?.()
    this.rejectDone(error)
    this.finish()
  }
}
