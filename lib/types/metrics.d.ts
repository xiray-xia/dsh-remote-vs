/**
 * One bounded POSIX probe for the host monitor panel, and its pure parser.
 *
 * Why a shell one-liner instead of the helper or Python on the remote:
 * - the plugin targets bare POSIX hosts (the doctor probe already works this
 *   way); requiring `python3`/`psutil` would make the panel dead on a stock
 *   router or NAS;
 * - one `exec` over the pooled SSH channel needs no helper deploy and no
 *   version handshake, so the panel also works on a host the deploy pipeline
 *   never touched.
 *
 * Every fact is a marker line (`@@RVS-MET key detail`), so a banner printed by
 * a login shell or a stray line of a command can never be mistaken for a
 * measurement. A metric the host cannot answer is `null` (rendered as unknown),
 * never zero: a VM without a thermal zone has no temperature, it does not have
 * 0 °C.
 *
 * CPU% and the network rate are DELTAS over the previous sample: the caller
 * keeps the counters (`cpuPercent` / `netRateBps` below). The first sample is
 * honestly unknown instead of a made-up number.
 *
 * Linux is the supported source (`/proc`). A host that is not Linux simply
 * answers `unknown`, which the UI renders as "unknown", not as an empty host.
 */
/** Prefix of every control line the probe prints (also the "did it answer" proof). */
export declare const METRICS_MARK = "@@RVS-MET";
/**
 * Budget for the whole probe.
 *
 * A handful of `/proc` reads over one channel: if the host itself is stuck (a
 * hung mount, a thief of a process, a network blip) the route must answer with
 * the exec deadline instead of holding the monitor's poll forever.
 */
export declare const METRICS_TIMEOUT_MS = 8000;
/** CPU timers from `/proc/stat` (jiffies). */
export interface CpuCounters {
    /** user + nice + system + idle + iowait + irq + softirq + steal. */
    total: number;
    /** idle + iowait. */
    idle: number;
}
/** Cumulative network byte counters from `/proc/net/dev` (loopback excluded). */
export interface NetCounters {
    rx: number;
    tx: number;
}
/** What the probe process itself reported, for honest unknown/error wording. */
export interface MetricsParseOptions {
    exitCode: number | null;
    timedOut?: boolean;
    /** Connection error message when the command never ran. */
    error?: string | undefined;
    stderr?: string;
}
/**
 * The probe's answer.
 *
 * `state: 'unknown'` means the command ran but the data cannot be trusted (it
 * timed out, the channel died before an exit status, or the markers are
 * missing). A transport failure is classified by the caller (`HostMonitor`),
 * not here.
 */
export interface ParsedMetrics {
    state: 'ok' | 'unknown';
    reason?: string;
    kernel: string | null;
    cpuCores: number | null;
    cpuModel: string | null;
    ip: string | null;
    uptimeSeconds: number | null;
    load: [number, number, number] | null;
    cpu: CpuCounters | null;
    memTotalBytes: number | null;
    memUsedBytes: number | null;
    diskTotalBytes: number | null;
    diskUsedBytes: number | null;
    temperatureC: number | null;
    net: NetCounters | null;
}
/**
 * The remote probe line.
 *
 * `printf` never interpolates the input; every value comes from a fixed local
 * command. `2>/dev/null` is only used where the missing tool/file is itself a
 * normal answer (`/proc` on a non-Linux host); the parser then sees an empty
 * value and reports it as unknown rather than as a zero.
 */
export declare function metricsCommand(): string;
/**
 * Parse the probe's stdout.
 *
 * Exit-code/timed-out/transport outcomes are answered BEFORE the markers so a
 * half-written probe can never be reported as a complete sample.
 */
export declare function parseMetrics(stdout: string, options: MetricsParseOptions): ParsedMetrics;
/**
 * CPU busy percentage between two counter samples.
 *
 * Null when a counter is missing, the sum did not advance, or the counters
 * went backwards (a reboot between the two samples): all three mean "unknown",
 * not "0%".
 */
export declare function cpuPercent(previous: CpuCounters | null | undefined, next: CpuCounters | null | undefined): number | null;
/**
 * Network bytes-per-second between two counter samples.
 *
 * Null when either counter is missing, the interval is not positive, or a
 * counter went backwards (a reboot): a rate computed from a reset counter is
 * noise, and showing it as a huge spike would be worse than "unknown".
 */
export declare function netRateBps(previous: NetCounters | null | undefined, next: NetCounters | null | undefined, elapsedMs: number | null | undefined): {
    rx: number;
    tx: number;
} | null;
/** Bytes as a percentage of a total; null when either side is unknown. */
export declare function usedPercent(used: number | null, total: number | null): number | null;
