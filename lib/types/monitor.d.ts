/**
 * HostMonitor: the Host-side cache/sampler behind the monitor panel.
 *
 * One `pool.exec` per alias per sample (a handful of `/proc` reads; see
 * `metrics.ts`). The panel polls while it is visible, but three things can ask
 * within the same second (several browser tabs, a manual refresh, the first
 * paint after a rail switch), so the sampler:
 *
 * - reuses a sample younger than `freshMs` (default 3 s, below the panel's 5 s
 *   poll) — a refresh storm costs one channel, not one per request;
 * - joins an in-flight sample instead of opening a second channel for the same
 *   alias (the pool's own slot budget would otherwise queue them for up to 30 s);
 * - keeps the previous counters so CPU% and the network rate are deltas over
 *   real elapsed time. The first sample has counters but no previous sample:
 *   those two values are null (unknown), never zero.
 *
 * `forget(alias)` is called from the two places a host's identity changes
 * (host DELETE and host edit): a cached sample carries the old connection's
 * counters, and using it after a re-dial would print a bogus rate.
 */
import type { RemoteExecResult, RemoteHostMetrics } from './protocol.ts';
/** The slice of `RemotePool` the sampler needs (fake in gates, real at runtime). */
export interface MetricsExecutor {
    exec(alias: string, command: string, opts?: {
        timeoutMs?: number;
    }): Promise<RemoteExecResult>;
}
export interface HostMonitorOptions {
    /** Injectable clock (gates drive time without sleeping). */
    now?: () => number;
    /** Snapshot reuse window. Deliberately below the panel's 5 s poll. */
    freshMs?: number;
}
/** Default reuse window: below the panel poll, above a refresh storm. */
export declare const DEFAULT_FRESH_MS = 3000;
/** Every field null: an honest "we did not get an answer". */
export declare function emptyMetrics(alias: string, state: 'unknown' | 'error', reason: string, sampledAt: number): RemoteHostMetrics;
export declare class HostMonitor {
    private readonly pool;
    private readonly now;
    private readonly freshMs;
    private readonly cache;
    private readonly inflight;
    /**
     * Bumped by `forget`. A probe that started before a host edit/delete must not
     * write its answer into the cache afterwards — the counters belong to the old
     * connection, and a re-created host with the same alias would briefly read a
     * stale sample.
     */
    private readonly generations;
    constructor(pool: MetricsExecutor, options?: HostMonitorOptions);
    /** One sample for one alias; `force` bypasses the reuse window (manual refresh). */
    sample(alias: string, force?: boolean): Promise<RemoteHostMetrics>;
    /** Drop everything known about one alias (host edited or deleted). */
    forget(alias: string): void;
    private probe;
}
