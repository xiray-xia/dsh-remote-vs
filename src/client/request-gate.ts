/**
 * Request priority gate: a foreground request never waits, background ones yield.
 *
 * The symptom this exists for: switching the remote workspace made the tree
 * crawl. The switch starts a full `git status` walk of the new repository
 * (minutes on an AOSP monorepo) while the tree itself needs a handful of small
 * foreground reads. A browser gives ONE origin six connections, so the walk —
 * probe + status + branch header, three at once — filled the pool and the
 * directory listing queued behind it. Measured on the reported trees: the git
 * walk took 8–9 s (1.6–1.9 s with `-uno`), and during that window a purely
 * in-memory Host route (`/status`, normally < 1 ms) answered in 2.7–4.6 s. The
 * directory list itself was 175–180 ms; the rest was queueing.
 *
 * The contract is one sentence per direction:
 *
 * - FOREGROUND — every request somebody is waiting on (directory list, file
 *   read/write, session cwd, connection status, terminal exec): it never waits
 *   for a background slot. It only bumps a counter, so a background request that
 *   is already running cannot hold it up (that one still owns a TCP connection,
 *   which is what `maxBackground` and the abort in `store.readGit` are for).
 * - BACKGROUND — repository-wide git walks: started only while NO foreground
 *   request is in flight and fewer than `maxBackground` background requests run.
 *   Otherwise queued (FIFO). `maxBackground: 1` is deliberate: the walk's own
 *   steps (probe, status, branch header) are work on ONE repository, and letting
 *   three of them hold three connections is exactly the pool exhaustion this
 *   gate exists to prevent.
 *
 * Aborting: a queued entry leaves the queue and rejects with `AbortError`. A
 * request that already STARTED cannot be un-sent — its slot is released the
 * moment its signal aborts (a cancelled fetch frees its connection right away,
 * and the channel must not depend on the transport noticing), while the outcome
 * of the underlying promise stays the transport's business: a real `fetch`
 * rejects with `AbortError`, which is what the store sees. A signal that is
 * ALREADY aborted when the request is handed over is passed to the transport
 * unchanged — `fetch` refuses it at once, and deciding that here would swallow
 * a step of a read that chose to keep going.
 *
 * Kept dependency-free (no store, no React, no fetch) on purpose: a node gate
 * imports this class and proves the ordering with its own deferreds, and the
 * store/api wiring is a one-liner at each call site.
 */

/** What `pending()` reports: counts only, never the queued closures. */
export interface RequestGatePending {
  /** Foreground requests in flight. */
  foreground: number
  /** Background requests in flight. */
  background: number
  /** Background requests waiting for a slot. */
  queued: number
}

/** One background request, either queued or running. */
interface BackgroundEntry {
  /** The request itself (a `fetch` wrapped in a closure by `api.call`). */
  readonly run: () => Promise<unknown>
  /** Hand the transport's answer to the caller (no-op once settled/aborted). */
  readonly resolve: (value: unknown) => void
  /** Hand the transport's failure to the caller (queued-abort uses it too). */
  readonly reject: (error: unknown) => void
  /** Removes this entry's abort listener (set by `runBackground`). */
  readonly detach: () => void
  /**
   * Gives the background slot back. A no-op while the entry is still queued;
   * `pump` replaces it with the real release when the request starts.
   */
  release: () => void
}

/**
 * The cancellation error a queued background request rejects with when its
 * signal aborts (`AbortError`, the same name `fetch` uses for its own aborts).
 */
export function requestAbortError(): Error {
  if (typeof DOMException === 'function') return new DOMException('Aborted', 'AbortError')
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

/**
 * True when `error` is an abort, not a failure.
 *
 * Callers that cancelled a request on purpose (a workspace switch) must not
 * report it: "the read you superseded was cancelled" is not an error the user
 * can act on.
 */
export function isRequestAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { name?: unknown }).name === 'AbortError'
}

/**
 * The gate itself.
 *
 * One instance per page is enough and is what `api.ts` uses; the class is
 * exported so a gate can drive several independent instances with its own
 * timings instead of sharing module state.
 */
export class RequestGate {
  /** Foreground requests in flight. */
  private foregroundCount = 0
  /** Background requests in flight (a slot is held until it settles or aborts). */
  private backgroundCount = 0
  /** Background requests waiting for a slot, in arrival order (FIFO). */
  private readonly queued: BackgroundEntry[] = []

  /**
   * @param maxBackground - how many background requests may run at once.
   *   `1` is the client's choice; see the module comment.
   */
  constructor(private readonly maxBackground = 1) {}

  /** Run one foreground request. It never waits for a background slot. */
  async runForeground<T>(fn: () => Promise<T>): Promise<T> {
    this.foregroundCount += 1
    try {
      return await fn()
    } finally {
      this.foregroundCount -= 1
      // The last foreground request is gone: the background channel may start.
      if (this.foregroundCount === 0) this.pump()
    }
  }

  /**
   * Run one background request, waiting for a slot.
   *
   * @param signal - a QUEUED request leaves the queue and rejects with
   *   `AbortError`; a request that already started releases its slot at once
   *   (its own `fetch` gets the same signal, so the transport is cancelled too).
   *   An already-aborted signal is handed to the transport, which refuses it.
   */
  runBackground<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      let detach = (): void => {}
      const entry: BackgroundEntry = {
        run: () => fn() as Promise<unknown>,
        resolve: (value) => {
          if (settled) return
          settled = true
          detach()
          entry.release()
          resolve(value as T)
        },
        reject: (error) => {
          if (settled) return
          settled = true
          detach()
          entry.release()
          reject(error)
        },
        detach: () => detach(),
        release: () => {},
      }
      if (signal !== undefined) {
        const onAbort = (): void => {
          const at = this.queued.indexOf(entry)
          if (at >= 0) {
            // Never started: the cancellation is the caller's answer.
            this.queued.splice(at, 1)
            entry.reject(requestAbortError())
            return
          }
          // Already running: give the slot back NOW. The transport is cancelled
          // through the same signal (a real fetch rejects and the caller sees
          // the AbortError); a transport that ignores it keeps the promise, but
          // must not wedge every later background read behind a dead walk.
          entry.release()
        }
        signal.addEventListener('abort', onAbort, { once: true })
        detach = () => signal.removeEventListener('abort', onAbort)
      }
      this.queued.push(entry)
      this.pump()
    })
  }

  /** Snapshot of the counts (gates assert ordering with this). */
  pending(): RequestGatePending {
    return { foreground: this.foregroundCount, background: this.backgroundCount, queued: this.queued.length }
  }

  /**
   * Start as many queued background requests as the rule allows.
   *
   * Called when a foreground request finishes, when a background one settles and
   * when a running one's signal aborts. A background request that is RUNNING is
   * never recalled (a fetch cannot be un-sent), so a foreground request arriving
   * mid-walk simply runs alongside it until it settles.
   */
  private pump(): void {
    while (this.foregroundCount === 0 && this.backgroundCount < this.maxBackground && this.queued.length > 0) {
      const entry = this.queued.shift() as BackgroundEntry
      this.backgroundCount += 1
      let released = false
      // The real release: give the slot back once, then let the next entry in.
      entry.release = () => {
        if (released) return
        released = true
        this.backgroundCount -= 1
        this.pump()
      }
      // A deferred call turns a synchronous throw into a rejection, and the slot
      // is given back before the next entry is considered.
      void Promise.resolve()
        .then(entry.run)
        .then(entry.resolve, entry.reject)
        .finally(entry.release)
    }
  }
}

/** The one gate the client uses (see `api.call`). */
export const requestGate = new RequestGate(1)

/** Snapshot of {@link requestGate} — for gates that assert the wiring. */
export function pending(): RequestGatePending {
  return requestGate.pending()
}
