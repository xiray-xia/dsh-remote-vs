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
import type { RemoteHostMetrics } from '../protocol.ts';
/** How many samples one sparkline keeps (5 s poll → 5 minutes). */
export declare const HISTORY_POINTS = 60;
/** One host's rolling history, oldest first. */
export interface MetricHistory {
    cpu: number[];
    mem: number[];
    netRx: number[];
    netTx: number[];
    temp: number[];
}
/** A fresh, empty window (a new array each call: the panel owns its history). */
export declare function emptyHistory(): MetricHistory;
/**
 * The snapshot the panel shows when a request failed before the Host answered.
 *
 * Every value is null on purpose: an HTTP failure is not "0% CPU", and the
 * reason line says what actually happened.
 */
export declare function placeholderMetrics(alias: string, state: 'unknown' | 'error', reason: string, sampledAt?: number): RemoteHostMetrics;
/** Append one sample, dropping the oldest past `HISTORY_POINTS` (identity when unchanged). */
export declare function pushPoint(points: number[], value: number | null): number[];
/** One metrics answer → the next history (same object when nothing changed). */
export declare function appendMetrics(history: MetricHistory, metrics: RemoteHostMetrics): MetricHistory;
/** One shared y-domain for two series (so RX and TX are comparable). */
export interface SparkDomain {
    min: number;
    max: number;
}
/**
 * The y-domain covering BOTH series.
 *
 * Two series drawn on independent auto-scales look identical even when one is
 * 100× the other (the RX/TX bug this exists to prevent). Null when neither
 * series has a finite value.
 */
export declare function combineDomain(first: readonly number[], second?: readonly number[]): SparkDomain | undefined;
/**
 * SVG path for a sparkline inside a `width × height` viewBox.
 *
 * The y axis is auto-scaled to the window's own min/max unless `domain` is
 * supplied; a flat window draws a line through the middle instead of dividing
 * by zero. A one-point window draws a dot-sized path on the right edge (the
 * line grows as samples arrive). Returns '' only when there is no finite value
 * at all.
 */
export declare function sparklinePath(values: readonly number[], width: number, height: number, domain?: SparkDomain): string;
/** `1536` → `1.5 KB`; `0` stays `0 B` (bytes are integers, not fractions). */
export declare function formatBytes(bytes: number): string;
/**
 * `used / total` in ONE unit, for a tile's sub line.
 *
 * `formatBytes` on each side doubles the unit ("5.1 GB / 16 GB"), which is
 * longer than the narrow tile can show and gets ellipsised exactly where the
 * capacity matters. This picks the total's unit for both numbers.
 */
export declare function formatCapacity(usedBytes: number, totalBytes: number): string;
/** `42.4` → `42%`. Percentages are whole numbers in this panel. */
export declare function formatPercent(value: number): string;
/** `1536` B/s → `1.5 KB/s`. */
export declare function formatRate(bytesPerSecond: number): string;
/** `3600 * 26 + 120` → `1d 2h`; short so it fits a narrow tile. */
export declare function formatUptime(seconds: number): string;
/** `42.1` → `42.1 °C`. */
export declare function formatTemperature(celsius: number): string;
/** Age of a sample, short form for "updated … ago" (`12s`, `3m`, `2h`). */
export declare function formatAgeShort(ms: number): string;
export type MetricTone = 'ok' | 'warn' | 'hot';
/** Bar tone: quiet below 75%, amber 75–89%, red from 90%. */
export declare function metricTone(percent: number | null): MetricTone;
