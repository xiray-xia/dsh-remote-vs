/**
 * Terminal view: a tab strip of independent remote shells under the host
 * picker. Each tab owns its own WebSocket and xterm instance, so several
 * sessions (or several hosts) can run side by side; hidden tabs stay MOUNTED,
 * which is what keeps their scrollback and running command alive.
 *
 * A tab is refresh-safe: the server session id is persisted, so reloading the
 * GUI reattaches to the still-running shell instead of spawning a new one.
 */
import { type ReactNode } from 'react';
import type { RemoteHostSummary } from '../protocol.ts';
export declare function TerminalView(props: {
    t: (key: string) => string;
    hosts: RemoteHostSummary[];
    visible: boolean;
}): ReactNode;
