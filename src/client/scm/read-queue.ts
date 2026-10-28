/**
 * One remote read at a time, per key — with two honest contracts.
 *
 * Why this exists
 * ---------------
 * Git reads are expensive on a large repository: `loadStatusDetail` walks the
 * whole index and worktree (minutes on the AOSP monorepo), and several surfaces
 * can ask for one at the same moment — the workspace dropdown, the session
 * follow, the panel's ⟳, and every write made through the plugin. Until now each
 * caller simply started its own command and the newest one won the paint, which
 * meant two concurrent walks of the same tree and a panel that could not tell
 * which answer was current.
 *
 * The queue replaces that with:
 *
 * - `join`  — "show me a read of this key". A read already in flight is shared:
 *             starting a second one would only duplicate the same walk, so a
 *             workspace switch costs nothing when the previous read of that
 *             workspace is still running.
 * - `fresh` — "the answer must describe the state as of NOW" (the ⟳ button, and
 *             every write: a save, a commit, a stage verb). It never shares a
 *             read that started before the call: it waits for the running one to
 *             settle and then starts its own. Two `fresh` callers that arrive
 *             during the same read share the SINGLE follow-up read, because the
 *             second one can see that the follow-up started after its own call.
 *
 * Reads for DIFFERENT keys run in parallel: two workspaces are two repositories,
 * and making one wait for the other would make a switch feel dead. Nothing here
 * paints anything — the caller decides what its answer may overwrite — so the
 * queue carries no store/React knowledge and is directly testable.
 */

/** How a caller relates to a read that is already in flight. */
export type ReadMode = 'join' | 'fresh'

/** One in-flight read. `id` orders it against the client's other calls. */
interface Flight {
  id: number
  promise: Promise<unknown>
}

/**
 * Bound a read by a hard settle deadline.
 *
 * A remote call can hang without ever settling — a stuck SSH round trip, and the
 * change ledger has measured exactly that on a monorepo. Without a bound, the
 * flight would stay registered forever: every later `join` would reuse the dead
 * promise, every `fresh` would wait for it, and the owner's busy flag would stay
 * up, so ONE hung host call would freeze that key for the rest of the page (the
 * pre-cache code never locked up: each refresh was independent and could fail on
 * its own). The deadline rejects the FLIGHT — releasing the key — while the
 * caller's failure handler owns the message; the underlying read may still
 * complete later, and nothing it paints was waiting on it.
 */
function withSettleDeadline<T>(read: () => Promise<T>, ms: number): () => Promise<T> {
  return () => {
    const pending = read()
    // `Promise.race` already attaches a handler to both racers, so this is not
    // what makes the deadline safe; it only keeps the console quiet when the
    // abandoned read rejects AFTER the deadline already won.
    pending.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`reading did not settle within ${Math.round(ms / 1000)}s — the host call may be stuck`))
      }, ms)
      timer.unref?.()
    })
    return Promise.race([pending, deadline]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
  }
}

export class ReadQueue {
  /** In-flight reads by key (insertion order is irrelevant here). */
  private readonly flights = new Map<string, Flight>()
  private nextId = 0

  /**
   * @param onChange - called whenever a read starts or settles, so the owner can
   *   derive a "busy" flag from `inflightKeys()` without polling.
   */
  constructor(private readonly onChange?: () => void) {}

  /** The keys with a read in flight (a caller derives its busy state from this). */
  inflightKeys(): string[] {
    return [...this.flights.keys()]
  }

  /** True while ONE key has a read in flight. */
  isBusy(key: string): boolean {
    return this.flights.has(key)
  }

  /**
   * Run `read` for `key`, honouring `mode`.
   *
   * The returned promise settles with this key's answer: a rejection comes from
   * the read the caller ended up waiting on (its own, or the one it joined).
   * `read` must be equivalent for every caller that passes the same key — the
   * queue keeps only the FIRST caller's closure, because a joined read cannot
   * carry a second closure.
   *
   * @param settleMs - hard settle deadline for a read THIS call starts (`0` =
   *   unbounded). A joined read keeps the deadline it was started with: its
   *   caller already decided how long that read may take.
   */
  run<T>(key: string, read: () => Promise<T>, mode: ReadMode = 'join', settleMs = 0): Promise<T> {
    const current = this.flights.get(key)
    if (current === undefined) return this.start(key, read, settleMs)
    if (mode === 'join') return current.promise as Promise<T>
    return this.after(current, key, read, settleMs)
  }

  /**
   * `fresh` while a read is in flight: wait for it, then read once more.
   *
   * The follow-up is NOT started from here unconditionally, or two `fresh`
   * callers that arrived during the same read would each start one (two
   * concurrent walks, exactly what this class exists to prevent). The second
   * caller instead finds a flight whose id is newer than the one it waited on —
   * a read that started after its own call — and shares it.
   */
  private async after<T>(flight: Flight, key: string, read: () => Promise<T>, settleMs: number): Promise<T> {
    await flight.promise.catch(() => undefined)
    const current = this.flights.get(key)
    if (current !== undefined && current.id > flight.id) return current.promise as Promise<T>
    return this.start(key, read, settleMs)
  }

  /** Register a flight and run `read`; a synchronous throw becomes a rejection. */
  private start<T>(key: string, read: () => Promise<T>, settleMs: number): Promise<T> {
    const id = ++this.nextId
    // A deferred callback keeps two guarantees: a synchronous throw from `read`
    // is reported as a rejection (callers all await), and the flight is
    // registered BEFORE the read runs, so a second call in the same tick joins
    // it instead of starting a duplicate.
    const body = settleMs > 0 ? withSettleDeadline(read, settleMs) : read
    const promise: Promise<T> = Promise.resolve()
      .then(body)
      .finally(() => {
        const current = this.flights.get(key)
        if (current !== undefined && current.id === id) this.flights.delete(key)
        this.onChange?.()
      })
    this.flights.set(key, { id, promise })
    this.onChange?.()
    return promise
  }
}
