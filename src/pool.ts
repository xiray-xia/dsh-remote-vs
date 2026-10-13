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

/** Connection establishment timeout. */
const READY_TIMEOUT_MS = 15_000

/** Per-stream output cap (stdout/stderr each); overflow truncates with a marker. */
const OUTPUT_CAP = 2 * 1024 * 1024

const TRUNCATED_MARKER = '\n[... truncated: output exceeded 2 MiB ...]\n'

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
}

export interface ShellOptions {
  cols?: number
  rows?: number
}

export class RemotePool {
  private readonly conns = new Map<string, Pooled>()
  /** TOFU fingerprints observed this process (alias -> sha256). */
  private readonly hostKeys = new Map<string, string>()

  constructor(private readonly store: RemoteStore) {}

  /** Drop one pooled connection (call after host update/delete). */
  drop(alias: string): void {
    const pooled = this.conns.get(alias)
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

  /** Run one non-interactive command. */
  async exec(alias: string, command: string, opts: ExecOptions = {}): Promise<RemoteExecResult> {
    const started = Date.now()
    const timeoutMs = opts.timeoutMs ?? 60_000
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
        const finish = (result: Omit<RemoteExecResult, 'durationMs'>): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.release(alias)
          resolve({ ...result, durationMs: Date.now() - started })
        }
        const timer = setTimeout(() => {
          try {
            stream?.close()
          } catch {
            // Ignore.
          }
          finish({ success: false, exitCode: null, timedOut: true, stdout: out, stderr: err })
        }, timeoutMs)
        let stream: ClientChannel | undefined
        let out = ''
        let err = ''
        conn.exec(command, (execError, channel) => {
          if (execError !== undefined && execError !== null) {
            finish({ success: false, exitCode: null, timedOut: false, stdout: '', stderr: '', error: execError.message })
            return
          }
          stream = channel
          channel.on('close', (code: number | null) => {
            finish({ success: code === 0, exitCode: code, timedOut: false, stdout: out, stderr: err })
          })
          channel.on('data', (chunk: Buffer) => {
            out = appendCapped(out, chunk.toString('utf8'))
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
  async withSftp<T>(alias: string, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const conn = await this.acquire(alias)
    this.hold(alias)
    try {
      const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        conn.sftp((error, session) => {
          if (error !== undefined && error !== null) reject(error)
          else resolve(session)
        })
      })
      try {
        return await fn(sftp)
      } finally {
        try {
          sftp.end()
        } catch {
          // Ignore close errors.
        }
      }
    } finally {
      this.release(alias)
    }
  }

  /** Upload one local file to an absolute remote path (parallel fastPut). */
  async putFile(alias: string, localPath: string, remotePath: string): Promise<void> {
    await this.withSftp(alias, async (sftp) => {
      await new Promise<void>((resolve, reject) => {
        sftp.fastPut(localPath, remotePath, (error) => {
          if (error !== undefined && error !== null) reject(error)
          else resolve()
        })
      })
    })
  }

  // ------------------------------------------------------------ internals

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
        reject(error)
      }
      conn.on('ready', () => {
        if (settled) return
        settled = true
        resolve(conn)
      })
      conn.on('error', (error: Error) => fail(error))
      conn.on('keyboard-interactive', (_name, _instructions, _lang, _prompts, finish) => {
        // Batch-style auth only: never answer interactive prompts.
        fail(new Error('server requested keyboard-interactive auth (unsupported; use key or password auth)'))
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

/** Append with a 2 MiB cap and a truncation marker. */
function appendCapped(current: string, chunk: string): string {
  if (current.length >= OUTPUT_CAP) return current
  const next = current + chunk
  if (next.length <= OUTPUT_CAP) return next
  return next.slice(0, OUTPUT_CAP) + TRUNCATED_MARKER
}
