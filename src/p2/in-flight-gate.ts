/**
 * Counting gate with a FIFO queue.
 *
 * Extracted so `.spike/in-flight-gate-check.mjs` can exercise the real class
 * instead of a reimplementation — the handoff path is exactly the kind of thing
 * that looks right and is not.
 */
export class InFlightGate {
  private active = 0
  private readonly waiting: { grant: () => void; cancel: () => void }[] = []

  constructor(private readonly max: number) {}

  /** Wait for a slot. Throws if `signal` aborts while queued or before. */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) throw new Error('helper request cancelled')
    if (this.active < this.max) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      let onAbort: () => void = () => undefined
      const entry = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        },
        cancel: () => {
          signal?.removeEventListener('abort', onAbort)
          reject(new Error('helper request cancelled'))
        },
      }
      onAbort = () => {
        const index = this.waiting.indexOf(entry)
        if (index >= 0) this.waiting.splice(index, 1)
        entry.cancel()
      }
      this.waiting.push(entry)
      if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Release one slot.
   *
   * When someone is queued the slot passes straight to them and `active` stays
   * put — dropping the count first would let a fresh caller slip in alongside
   * the woken waiter and push usage past the ceiling.
   */
  release(): void {
    const next = this.waiting.shift()
    if (next === undefined) {
      this.active -= 1
      return
    }
    next.grant()
  }

  /** Occupied slots, for tests and diagnostics. */
  get inFlight(): number {
    return this.active
  }
}
