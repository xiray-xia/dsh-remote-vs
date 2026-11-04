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
import type { RemoteExecResult, RemoteHostMetrics } from './protocol.ts'
import {
  METRICS_TIMEOUT_MS,
  cpuPercent,
  metricsCommand,
  netRateBps,
  parseMetrics,
  usedPercent,
  type CpuCounters,
  type NetCounters,
} from './metrics.ts'

/** The slice of `RemotePool` the sampler needs (fake in gates, real at runtime). */
export interface MetricsExecutor {
  exec(alias: string, command: string, opts?: { timeoutMs?: number }): Promise<RemoteExecResult>
}

export interface HostMonitorOptions {
  /** Injectable clock (gates drive time without sleeping). */
  now?: () => number
  /** Snapshot reuse window. Deliberately below the panel's 5 s poll. */
  freshMs?: number
}

/** Default reuse window: below the panel poll, above a refresh storm. */
export const DEFAULT_FRESH_MS = 3_000

interface CacheEntry {
  snapshot: RemoteHostMetrics
  /** Last counters a percentage/rate can be measured against. */
  cpu: CpuCounters | null
  net: NetCounters | null
  /** When the counters above were read (null when they never were). */
  counterAt: number | null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Every field null: an honest "we did not get an answer". */
export function emptyMetrics(
  alias: string,
  state: 'unknown' | 'error',
  reason: string,
  sampledAt: number,
): RemoteHostMetrics {
  return {
    alias,
    state,
    reason,
    sampledAt,
    kernel: null,
    cpuCores: null,
    cpuModel: null,
    ip: null,
    uptimeSeconds: null,
    load1: null,
    load5: null,
    load15: null,
    cpuPercent: null,
    memUsedBytes: null,
    memTotalBytes: null,
    memPercent: null,
    diskUsedBytes: null,
    diskTotalBytes: null,
    diskPercent: null,
    temperatureC: null,
    netRxBps: null,
    netTxBps: null,
  }
}

export class HostMonitor {
  private readonly pool: MetricsExecutor
  private readonly now: () => number
  private readonly freshMs: number
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<RemoteHostMetrics>>()
  /**
   * Bumped by `forget`. A probe that started before a host edit/delete must not
   * write its answer into the cache afterwards — the counters belong to the old
   * connection, and a re-created host with the same alias would briefly read a
   * stale sample.
   */
  private readonly generations = new Map<string, number>()

  constructor(pool: MetricsExecutor, options: HostMonitorOptions = {}) {
    this.pool = pool
    this.now = options.now ?? (() => Date.now())
    this.freshMs = options.freshMs ?? DEFAULT_FRESH_MS
  }

  /** One sample for one alias; `force` bypasses the reuse window (manual refresh). */
  async sample(alias: string, force = false): Promise<RemoteHostMetrics> {
    const cached = this.cache.get(alias)
    if (!force && cached !== undefined && this.now() - cached.snapshot.sampledAt < this.freshMs) {
      return cached.snapshot
    }
    const running = this.inflight.get(alias)
    if (running !== undefined) return running
    // The finally-delete must only remove THIS task: a forced refresh may have
    // replaced the map entry with a newer one while this one was running.
    const task: Promise<RemoteHostMetrics> = this.probe(alias).finally(() => {
      if (this.inflight.get(alias) === task) this.inflight.delete(alias)
    })
    this.inflight.set(alias, task)
    return task
  }

  /** Drop everything known about one alias (host edited or deleted). */
  forget(alias: string): void {
    this.cache.delete(alias)
    this.inflight.delete(alias)
    this.generations.set(alias, (this.generations.get(alias) ?? 0) + 1)
  }

  private async probe(alias: string): Promise<RemoteHostMetrics> {
    const generation = this.generations.get(alias) ?? 0
    const startedAt = this.now()
    let result: RemoteExecResult
    try {
      result = await this.pool.exec(alias, metricsCommand(), { timeoutMs: METRICS_TIMEOUT_MS })
    } catch (error) {
      return emptyMetrics(alias, 'error', messageOf(error), startedAt)
    }
    if (result.error !== undefined && result.error !== '') {
      return emptyMetrics(alias, 'error', result.error, startedAt)
    }

    const parsed = parseMetrics(result.stdout, {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stderr: result.stderr,
    })
    const sampledAt = this.now()
    const previous = this.cache.get(alias)
    const elapsedMs = previous?.counterAt === null || previous?.counterAt === undefined
      ? null
      : Math.max(0, sampledAt - previous.counterAt)
    const cpu = cpuPercent(previous?.cpu ?? null, parsed.cpu)
    const rate = netRateBps(previous?.net ?? null, parsed.net, elapsedMs)

    const snapshot: RemoteHostMetrics = {
      alias,
      state: parsed.state === 'ok' ? 'ok' : 'unknown',
      ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
      sampledAt,
      kernel: parsed.kernel,
      cpuCores: parsed.cpuCores,
      cpuModel: parsed.cpuModel,
      ip: parsed.ip,
      uptimeSeconds: parsed.uptimeSeconds,
      load1: parsed.load?.[0] ?? null,
      load5: parsed.load?.[1] ?? null,
      load15: parsed.load?.[2] ?? null,
      cpuPercent: cpu,
      memUsedBytes: parsed.memUsedBytes,
      memTotalBytes: parsed.memTotalBytes,
      memPercent: usedPercent(parsed.memUsedBytes, parsed.memTotalBytes),
      diskUsedBytes: parsed.diskUsedBytes,
      diskTotalBytes: parsed.diskTotalBytes,
      diskPercent: usedPercent(parsed.diskUsedBytes, parsed.diskTotalBytes),
      temperatureC: parsed.temperatureC,
      netRxBps: rate?.rx ?? null,
      netTxBps: rate?.tx ?? null,
    }

    // Counters survive an unknown answer: after a timeout the next successful
    // sample still has a baseline to diff against, and the elapsed time is the
    // real gap between the two counter reads (not a made-up poll interval).
    const counters = parsed.cpu ?? previous?.cpu ?? null
    const countersAt = parsed.cpu === null ? (previous?.counterAt ?? null) : sampledAt
    const net = parsed.net ?? previous?.net ?? null
    // A host mutation during the probe invalidates this answer's cache slot.
    // The caller still gets the sample it asked for; the NEXT request starts
    // from scratch instead of inheriting counters from the pre-edit connection.
    if ((this.generations.get(alias) ?? 0) === generation) {
      this.cache.set(alias, { snapshot, cpu: counters, net, counterAt: countersAt })
    }
    return snapshot
  }
}
