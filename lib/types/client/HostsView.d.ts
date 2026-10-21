/**
 * Hosts view: list + add/edit form + test + key bootstrap + push + import.
 */
import { type ReactNode } from 'react';
import type { RemoteHostSummary } from '../protocol.ts';
export declare function HostsView(props: {
    t: (k: string) => string;
    hosts: RemoteHostSummary[];
    onChanged: () => void;
}): ReactNode;
