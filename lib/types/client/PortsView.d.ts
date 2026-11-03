/**
 * Ports view: the `ssh -L` tunnels this client owns, plus a way to make more.
 *
 * Why a panel instead of a hidden command: a forward the panel does not show is
 * invisible state. The listener lives in the HOST process, so closing the
 * sidebar, switching hosts or reloading the page must not look like "the tunnel
 * is gone" while it still holds a local port. The list is therefore the Host's
 * own answer (a local-only read, polled), the rules the user created are
 * remembered by the BROWSER, and a reload restores them — the listener belongs
 * to the Host, the memory of why it exists belongs here.
 *
 * Two costs shape the polling: the forward list is a local JSON read (cheap, so
 * every 4 s while visible), whereas the listening-port probe runs a remote
 * command (`ss`/`netstat`) and is therefore rare: on mount, on an explicit
 * refresh, and once every 30 s.
 */
import { type ReactNode } from 'react';
import type { RemoteHostSummary } from '../protocol.ts';
/**
 * Rail icon: a plug. Kept here rather than in `vsc/kit.tsx` because it is the
 * only screen that draws one, and the shared icon set is a curated list.
 */
export declare function IconPlug(props: {
    size?: number;
}): ReactNode;
export declare function PortsView(props: {
    t: (key: string) => string;
    hosts: RemoteHostSummary[];
    visible: boolean;
}): ReactNode;
