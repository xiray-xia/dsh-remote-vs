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
    foreground: number;
    /** Background requests in flight. */
    background: number;
    /** Background requests waiting for a slot. */
    queued: number;
}
/**
 * The cancellation error a queued background request rejects with when its
 * signal aborts (`AbortError`, the same name `fetch` uses for its own aborts).
 */
export declare function requestAbortError(): Error;
/**
 * True when `error` is an abort, not a failure.
 *
 * Callers that cancelled a request on purpose (a workspace switch) must not
 * report it: "the read you superseded was cancelled" is not an error the user
 * can act on.
 */
export declare function isRequestAbort(error: unknown): boolean;
/**
 * The gate itself.
 *
 * One instance per page is enough and is what `api.ts` uses; the class is
 * exported so a gate can drive several independent instances with its own
 * timings instead of sharing module state.
 */
export declare class RequestGate {
    private readonly maxBackground;
    /** Foreground requests in flight. */
    private foregroundCount;
    /** Background requests in flight (a slot is held until it settles or aborts). */
    private backgroundCount;
    /** Background requests waiting for a slot, in arrival order (FIFO). */
    private readonly queued;
    /**
     * @param maxBackground - how many background requests may run at once.
     *   `1` is the client's choice; see the module comment.
     */
    constructor(maxBackground?: number);
    /** Run one foreground request. It never waits for a background slot. */
    runForeground<T>(fn: () => Promise<T>): Promise<T>;
    /**
     * Run one background request, waiting for a slot.
     *
     * @param signal - a QUEUED request leaves the queue and rejects with
     *   `AbortError`; a request that already started releases its slot at once
     *   (its own `fetch` gets the same signal, so the transport is cancelled too).
     *   An already-aborted signal is handed to the transport, which refuses it.
     */
    runBackground<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
    /** Snapshot of the counts (gates assert ordering with this). */
    pending(): RequestGatePending;
    /**
     * Start as many queued background requests as the rule allows.
     *
     * Called when a foreground request finishes, when a background one settles and
     * when a running one's signal aborts. A background request that is RUNNING is
     * never recalled (a fetch cannot be un-sent), so a foreground request arriving
     * mid-walk simply runs alongside it until it settles.
     */
    private pump;
}
/** The one gate the client uses (see `api.call`). */
export declare const requestGate: RequestGate;
/** Snapshot of {@link requestGate} — for gates that assert the wiring. */
export declare function pending(): RequestGatePending;
