/**
 * Sidebar monitor: live CPU / memory / disk / network / temperature for one
 * host (or every host at once).
 *
 * Costs are shaped by the plugin's channel budget: the panel polls only while
 * it is the visible view AND the page is visible (5 s), the Host reuses a
 * sample for a few seconds, and a per-alias in-flight set means a manual
 * refresh cannot open a second channel for a host that is already sampling.
 * The first sample is honest about deltas: CPU% and the network rate read
 * "unknown" until a second sample exists.
 */
import { type ReactNode } from 'react';
import type { RemoteHostSummary } from '../protocol.ts';
/** Visible-panel poll cadence. The Host's own reuse window is shorter (3 s). */
export declare const MONITOR_POLL_MS = 5000;
/**
 * The refresh-interval setting.
 *
 * `MONITOR_POLL_MS` stays the default and the documented cadence; the other
 * choices exist for slow links / many hosts. The value is validated against
 * this list on read, so a hand-edited localStorage value cannot turn the poll
 * into a 1 ms loop.
 */
export declare const INTERVAL_CHOICES: readonly [5000, 10000, 30000];
/** One rail icon: a screen with a pulse line. */
export declare function IconMonitor(props: {
    size?: number;
}): ReactNode;
export declare function MonitorView(props: {
    t: (key: string) => string;
    hosts: RemoteHostSummary[];
    visible: boolean;
}): ReactNode;
