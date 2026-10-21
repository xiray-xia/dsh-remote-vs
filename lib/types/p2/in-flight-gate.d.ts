/**
 * Counting gate with a FIFO queue.
 *
 * Extracted so `.spike/in-flight-gate-check.mjs` can exercise the real class
 * instead of a reimplementation — the handoff path is exactly the kind of thing
 * that looks right and is not.
 */
export declare class InFlightGate {
    private readonly max;
    private active;
    private readonly waiting;
    constructor(max: number);
    /** Wait for a slot. Throws if `signal` aborts while queued or before. */
    acquire(signal?: AbortSignal): Promise<void>;
    /**
     * Release one slot.
     *
     * When someone is queued the slot passes straight to them and `active` stays
     * put — dropping the count first would let a fresh caller slip in alongside
     * the woken waiter and push usage past the ceiling.
     */
    release(): void;
    /** Occupied slots, for tests and diagnostics. */
    get inFlight(): number;
}
