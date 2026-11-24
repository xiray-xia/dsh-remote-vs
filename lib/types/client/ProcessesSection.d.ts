/**
 * Remote process table shown on the monitor page.
 *
 * One bounded snapshot per selected host, polled only while the monitor page and
 * the browser tab are both visible. Killing is always confirmed and always goes
 * through the Host route (which validates the PID against its own snapshot), so
 * the browser never builds a shell command from a process row.
 */
import { type ReactNode } from 'react';
import type { RemoteHostSummary } from '../protocol.ts';
export declare const PROCESS_POLL_MS = 5000;
export declare function ProcessesSection(props: {
    t: (key: string) => string;
    hosts: RemoteHostSummary[];
    aliases: string[];
    visible: boolean;
    paused: boolean;
}): ReactNode;
