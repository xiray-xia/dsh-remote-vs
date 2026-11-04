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
export const METRICS_MARK = '@@RVS-MET'

/**
 * Budget for the whole probe.
 *
 * A handful of `/proc` reads over one channel: if the host itself is stuck (a
 * hung mount, a thief of a process, a network blip) the route must answer with
 * the exec deadline instead of holding the monitor's poll forever.
 */
export const METRICS_TIMEOUT_MS = 8_000

/** CPU timers from `/proc/stat` (jiffies). */
export interface CpuCounters {
  /** user + nice + system + idle + iowait + irq + softirq + steal. */
  total: number
  /** idle + iowait. */
  idle: number
}

/** Cumulative network byte counters from `/proc/net/dev` (loopback excluded). */
export interface NetCounters {
  rx: number
  tx: number
}

/** What the probe process itself reported, for honest unknown/error wording. */
export interface MetricsParseOptions {
  exitCode: number | null
  timedOut?: boolean
  /** Connection error message when the command never ran. */
  error?: string | undefined
  stderr?: string
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
  state: 'ok' | 'unknown'
  reason?: string
  kernel: string | null
  cpuCores: number | null
  cpuModel: string | null
  ip: string | null
  uptimeSeconds: number | null
  load: [number, number, number] | null
  cpu: CpuCounters | null
  memTotalBytes: number | null
  memUsedBytes: number | null
  diskTotalBytes: number | null
  diskUsedBytes: number | null
  temperatureC: number | null
  net: NetCounters | null
}

/**
 * The remote probe line.
 *
 * `printf` never interpolates the input; every value comes from a fixed local
 * command. `2>/dev/null` is only used where the missing tool/file is itself a
 * normal answer (`/proc` on a non-Linux host); the parser then sees an empty
 * value and reports it as unknown rather than as a zero.
 */
export function metricsCommand(): string {
  const mark = METRICS_MARK
  return [
    'export LC_ALL=C',
    `printf '%s begin\\n' '${mark}'`,
    `printf '%s kernel %s\\n' '${mark}' "$(uname -srm 2>/dev/null)"`,
    `printf '%s cores %s\\n' '${mark}' "$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null)"`,
    `printf '%s uptime %s\\n' '${mark}' "$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"`,
    `printf '%s load %s\\n' '${mark}' "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"`,
    `printf '%s cpu %s\\n' '${mark}' "$(awk '/^cpu /{print $2,$3,$4,$5,$6,$7,$8,$9; exit}' /proc/stat 2>/dev/null)"`,
    `printf '%s mem %s\\n' '${mark}' "$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} /^MemFree:/{f=$2} /^Buffers:/{b=$2} /^Cached:/{c=$2} END{if(t=="")exit; if(a=="")a=f+b+c; printf "%s %s", t, a}' /proc/meminfo 2>/dev/null)"`,
    `printf '%s disk %s\\n' '${mark}' "$(df -Pk / 2>/dev/null | awk 'NR==2{print $2, $3}')"`,
    `printf '%s net %s\\n' '${mark}' "$(awk 'NR>2{iface=$1; sub(/:$/,"",iface); if(iface=="lo")next; rx+=$2; tx+=$10} END{printf "%s %s", rx+0, tx+0}' /proc/net/dev 2>/dev/null)"`,
    `printf '%s temp %s\\n' '${mark}' "$(for f in /sys/class/thermal/thermal_zone*/temp; do if [ -r "$f" ]; then cat "$f"; break; fi; done 2>/dev/null)"`,
    `printf '%s model %s\\n' '${mark}' "$(awk -F: '/model name/{sub(/^[ \\t]+/,"",$2); print $2; exit}' /proc/cpuinfo 2>/dev/null)"`,
    `printf '%s ip %s\\n' '${mark}' "$(hostname -I 2>/dev/null | awk '{print $1}')"`,
    `printf '%s end\\n' '${mark}'`,
  ].join('\n')
}

/** Anchored marker: a metric line's content can never forge or split a marker. */
const LINE_RE = new RegExp(`^${METRICS_MARK} ([a-z]+)(?: (.*))?$`)

const EMPTY: Omit<ParsedMetrics, 'state' | 'reason'> = {
  kernel: null,
  cpuCores: null,
  cpuModel: null,
  ip: null,
  uptimeSeconds: null,
  load: null,
  cpu: null,
  memTotalBytes: null,
  memUsedBytes: null,
  diskTotalBytes: null,
  diskUsedBytes: null,
  temperatureC: null,
  net: null,
}

function unavailable(reason: string): ParsedMetrics {
  return { state: 'unknown', reason, ...EMPTY }
}

function numberFrom(text: string | undefined): number | null {
  if (text === undefined || text.trim() === '') return null
  const value = Number(text.trim())
  return Number.isFinite(value) ? value : null
}

function intFrom(text: string | undefined): number | null {
  const value = numberFrom(text)
  return value === null ? null : Math.trunc(value)
}

function tokensOf(detail: string | undefined): string[] {
  return detail === undefined ? [] : detail.trim().split(/\s+/).filter(token => token !== '')
}

function textOf(facts: Map<string, string>, key: string): string | null {
  const value = facts.get(key)
  if (value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Parse the probe's stdout.
 *
 * Exit-code/timed-out/transport outcomes are answered BEFORE the markers so a
 * half-written probe can never be reported as a complete sample.
 */
export function parseMetrics(stdout: string, options: MetricsParseOptions): ParsedMetrics {
  if (options.error !== undefined && options.error !== '') return unavailable(options.error)
  if (options.timedOut === true) return unavailable(`probe timed out after ${METRICS_TIMEOUT_MS / 1000}s`)
  if (options.exitCode === null) return unavailable('the SSH channel closed before the probe exited')
  if (options.exitCode !== 0) {
    const stderr = (options.stderr ?? '').trim()
    const first = stderr.split(/\r?\n/)[0] ?? ''
    return unavailable(`probe exited with code ${options.exitCode}${first === '' ? '' : `: ${first}`}`)
  }

  const facts = new Map<string, string>()
  let sawBegin = false
  let sawEnd = false
  for (const raw of stdout.split(/\r?\n/)) {
    const match = LINE_RE.exec(raw.trim())
    if (match === null) continue
    const key = match[1]
    const detail = match[2] ?? ''
    if (key === 'begin') {
      sawBegin = true
      continue
    }
    if (key === 'end') {
      sawEnd = true
      continue
    }
    facts.set(key, detail)
  }
  if (!sawBegin) return unavailable('the probe did not start (no begin marker)')
  if (!sawEnd) return unavailable('the probe did not finish (no end marker)')

  const cpuTokens = tokensOf(facts.get('cpu'))
  const cpu = cpuTokens.length >= 8
    ? {
        total: cpuTokens.slice(0, 8).reduce((sum, token) => sum + (Number(token) || 0), 0),
        idle: (Number(cpuTokens[3]) || 0) + (Number(cpuTokens[4]) || 0),
      }
    : null

  const memTokens = tokensOf(facts.get('mem'))
  const memTotalKb = memTokens.length >= 2 ? numberFrom(memTokens[0]) : null
  const memAvailableKb = memTokens.length >= 2 ? numberFrom(memTokens[1]) : null
  const memTotalBytes = memTotalKb === null ? null : memTotalKb * 1024
  const memUsedBytes = memTotalBytes === null || memAvailableKb === null
    ? null
    : Math.max(0, memTotalBytes - memAvailableKb * 1024)

  const diskTokens = tokensOf(facts.get('disk'))
  const diskTotalKb = diskTokens.length >= 2 ? numberFrom(diskTokens[0]) : null
  const diskUsedKb = diskTokens.length >= 2 ? numberFrom(diskTokens[1]) : null
  const diskTotalBytes = diskTotalKb === null ? null : diskTotalKb * 1024
  const diskUsedBytes = diskUsedKb === null ? null : diskUsedKb * 1024

  const loadTokens = tokensOf(facts.get('load'))
  const load: [number, number, number] | null = loadTokens.length >= 3
    ? [Number(loadTokens[0]) || 0, Number(loadTokens[1]) || 0, Number(loadTokens[2]) || 0]
    : null

  const netTokens = tokensOf(facts.get('net'))
  const net: NetCounters | null = netTokens.length >= 2
    ? { rx: Number(netTokens[0]) || 0, tx: Number(netTokens[1]) || 0 }
    : null

  const temperatureMilli = intFrom(facts.get('temp'))
  const temperatureC = temperatureMilli === null ? null : temperatureMilli / 1000

  // A Linux host always has CPU and memory under /proc. Disk alone (a macOS
  // `df`) is not enough: reporting that as an `ok` host would paint a green
  // "healthy" row while every live metric on it is unknown.
  if (cpu === null && memTotalBytes === null) {
    return unavailable('the probe answered without /proc CPU or memory (not a Linux host?)')
  }

  return {
    state: 'ok',
    kernel: textOf(facts, 'kernel'),
    cpuCores: intFrom(facts.get('cores')),
    cpuModel: textOf(facts, 'model'),
    ip: tokensOf(facts.get('ip'))[0] ?? null,
    uptimeSeconds: numberFrom(facts.get('uptime')),
    load,
    cpu,
    memTotalBytes,
    memUsedBytes,
    diskTotalBytes,
    diskUsedBytes,
    temperatureC,
    net,
  }
}

/**
 * CPU busy percentage between two counter samples.
 *
 * Null when a counter is missing, the sum did not advance, or the counters
 * went backwards (a reboot between the two samples): all three mean "unknown",
 * not "0%".
 */
export function cpuPercent(
  previous: CpuCounters | null | undefined,
  next: CpuCounters | null | undefined,
): number | null {
  if (previous === null || previous === undefined || next === null || next === undefined) return null
  const total = next.total - previous.total
  const idle = next.idle - previous.idle
  if (total <= 0 || idle < 0 || idle > total) return null
  return Math.min(100, Math.max(0, (1 - idle / total) * 100))
}

/**
 * Network bytes-per-second between two counter samples.
 *
 * Null when either counter is missing, the interval is not positive, or a
 * counter went backwards (a reboot): a rate computed from a reset counter is
 * noise, and showing it as a huge spike would be worse than "unknown".
 */
export function netRateBps(
  previous: NetCounters | null | undefined,
  next: NetCounters | null | undefined,
  elapsedMs: number | null | undefined,
): { rx: number; tx: number } | null {
  if (previous === null || previous === undefined || next === null || next === undefined) return null
  if (elapsedMs === null || elapsedMs === undefined || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return null
  const rx = next.rx - previous.rx
  const tx = next.tx - previous.tx
  if (rx < 0 || tx < 0) return null
  const seconds = elapsedMs / 1000
  return { rx: rx / seconds, tx: tx / seconds }
}

/** Bytes as a percentage of a total; null when either side is unknown. */
export function usedPercent(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null
  return Math.min(100, Math.max(0, (used / total) * 100))
}
