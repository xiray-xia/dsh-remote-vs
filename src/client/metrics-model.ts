/**
 * Pure model for the host monitor panel.
 *
 * Kept free of React and DOM so the node gate can drive it: history windows,
 * sparkline geometry, number formatting and the health tone all live here.
 * The panel only renders what these functions return.
 *
 * Honesty rules carried by this module:
 * - a null measurement is never formatted as a number (the panel shows "—");
 * - a flat series still draws a line (a flat 30 °C history is a real answer,
 *   not "no data");
 * - history windows are bounded (`HISTORY_POINTS`), so a panel left open for
 *   hours cannot grow the page's memory.
 */
import type { RemoteHostMetrics } from '../protocol.ts'

/** How many samples one sparkline keeps (5 s poll → 5 minutes). */
export const HISTORY_POINTS = 60

/** One host's rolling history, oldest first. */
export interface MetricHistory {
  cpu: number[]
  mem: number[]
  netRx: number[]
  netTx: number[]
  temp: number[]
}

/** A fresh, empty window (a new array each call: the panel owns its history). */
export function emptyHistory(): MetricHistory {
  return { cpu: [], mem: [], netRx: [], netTx: [], temp: [] }
}

/**
 * The snapshot the panel shows when a request failed before the Host answered.
 *
 * Every value is null on purpose: an HTTP failure is not "0% CPU", and the
 * reason line says what actually happened.
 */
export function placeholderMetrics(
  alias: string,
  state: 'unknown' | 'error',
  reason: string,
  sampledAt = Date.now(),
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

/** Append one sample, dropping the oldest past `HISTORY_POINTS` (identity when unchanged). */
export function pushPoint(points: number[], value: number | null): number[] {
  if (value === null || !Number.isFinite(value)) return points
  const next = [...points, value]
  if (next.length > HISTORY_POINTS) next.splice(0, next.length - HISTORY_POINTS)
  return next
}

/** One metrics answer → the next history (same object when nothing changed). */
export function appendMetrics(history: MetricHistory, metrics: RemoteHostMetrics): MetricHistory {
  const cpu = pushPoint(history.cpu, metrics.cpuPercent)
  const mem = pushPoint(history.mem, metrics.memPercent)
  const netRx = pushPoint(history.netRx, metrics.netRxBps)
  const netTx = pushPoint(history.netTx, metrics.netTxBps)
  const temp = pushPoint(history.temp, metrics.temperatureC)
  if (cpu === history.cpu && mem === history.mem && netRx === history.netRx
    && netTx === history.netTx && temp === history.temp) return history
  return { cpu, mem, netRx, netTx, temp }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** One shared y-domain for two series (so RX and TX are comparable). */
export interface SparkDomain {
  min: number
  max: number
}

/**
 * The y-domain covering BOTH series.
 *
 * Two series drawn on independent auto-scales look identical even when one is
 * 100× the other (the RX/TX bug this exists to prevent). Null when neither
 * series has a finite value.
 */
export function combineDomain(first: readonly number[], second: readonly number[] = []): SparkDomain | undefined {
  const all = [...first, ...second].filter(value => Number.isFinite(value))
  if (all.length === 0) return undefined
  let min = Math.min(...all)
  let max = Math.max(...all)
  if (min === max) {
    min -= 1
    max += 1
  }
  return { min, max }
}

/**
 * SVG path for a sparkline inside a `width × height` viewBox.
 *
 * The y axis is auto-scaled to the window's own min/max unless `domain` is
 * supplied; a flat window draws a line through the middle instead of dividing
 * by zero. A one-point window draws a dot-sized path on the right edge (the
 * line grows as samples arrive). Returns '' only when there is no finite value
 * at all.
 */
export function sparklinePath(
  values: readonly number[],
  width: number,
  height: number,
  domain?: SparkDomain,
): string {
  const points = values.filter(value => Number.isFinite(value))
  if (points.length === 0 || width <= 0 || height <= 0) return ''
  let min = domain === undefined ? Math.min(...points) : domain.min
  let max = domain === undefined ? Math.max(...points) : domain.max
  if (max === min) {
    // A flat series is a real answer: centre it instead of collapsing to a
    // division by zero (which used to render a blank chart).
    min -= 1
    max += 1
  }
  const step = points.length === 1 ? 0 : width / (points.length - 1)
  const coordinates = points.map((value, index) => {
    const x = points.length === 1 ? width : index * step
    const ratio = 1 - (value - min) / (max - min)
    const y = Math.max(0, Math.min(height, ratio * height))
    return `${round2(x)},${round2(y)}`
  })
  return `M${coordinates.join('L')}`
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** `1536` → `1.5 KB`; `0` stays `0 B` (bytes are integers, not fractions). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  if (unit === 0) return `${Math.round(value)} ${BYTE_UNITS[unit]}`
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${BYTE_UNITS[unit]}`
}

/** Trim a scaled capacity to one decimal below 100 (the sub line must stay short). */
function scaledCapacity(bytes: number): { value: number; unit: string } {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return { value, unit: BYTE_UNITS[unit] }
}

/**
 * `used / total` in ONE unit, for a tile's sub line.
 *
 * `formatBytes` on each side doubles the unit ("5.1 GB / 16 GB"), which is
 * longer than the narrow tile can show and gets ellipsised exactly where the
 * capacity matters. This picks the total's unit for both numbers.
 */
export function formatCapacity(usedBytes: number, totalBytes: number): string {
  if (!Number.isFinite(usedBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) return ''
  const total = scaledCapacity(totalBytes)
  const unitIndex = BYTE_UNITS.indexOf(total.unit as (typeof BYTE_UNITS)[number])
  const factor = 1024 ** unitIndex
  const usedValue = usedBytes / factor
  const trim = (value: number): string =>
    value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)
  return `${trim(usedValue)} / ${trim(total.value)} ${total.unit}`
}

/** `42.4` → `42%`. Percentages are whole numbers in this panel. */
export function formatPercent(value: number): string {
  return `${Math.round(value)}%`
}

/** `1536` B/s → `1.5 KB/s`. */
export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

/** `3600 * 26 + 120` → `1d 2h`; short so it fits a narrow tile. */
export function formatUptime(seconds: number): string {
  const total = Math.floor(seconds)
  if (!Number.isFinite(total) || total <= 0) return '—'
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/** `42.1` → `42.1 °C`. */
export function formatTemperature(celsius: number): string {
  return `${Math.round(celsius * 10) / 10} °C`
}

/** Age of a sample, short form for "updated … ago" (`12s`, `3m`, `2h`). */
export function formatAgeShort(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h`
}

export type MetricTone = 'ok' | 'warn' | 'hot'

/** Bar tone: quiet below 75%, amber 75–89%, red from 90%. */
export function metricTone(percent: number | null): MetricTone {
  if (percent === null || !Number.isFinite(percent) || percent < 75) return 'ok'
  if (percent < 90) return 'warn'
  return 'hot'
}
