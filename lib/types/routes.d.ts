import type { Context } from '@deepseek-ai/cordis';
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver';
import { type RemoteTimeouts } from './protocol.ts';
import type { RemoteStore } from './store.ts';
import type { RemotePool } from './pool.ts';
import type { RemoteWorlds } from './p2/worlds.ts';
import { TerminalSessionRegistry } from './terminal.ts';
import { ForwardManager } from './forward.ts';
import type { SessionChanges } from './changes/recorder.ts';
/**
 * Wrap one archive command in a remote-side deadline.
 *
 * The command is a single `tar` invocation with already-quoted operands
 * (`archive.ts` builders), so prefixing is syntactically safe and makes tar the
 * direct child of `timeout` — TERM (then KILL after 3 s) reaches tar itself, no
 * process-group id is needed (2026-10 audit, A16-1). Hosts without GNU `timeout`
 * (BSD/macOS) fall back to today's behaviour instead of failing the download.
 */
export declare function archiveCommandWithDeadline(command: string): string;
/**
 * Error for a failed archive stream.
 *
 * GNU `timeout` reports 124 when TERM sufficed and 137 when KILL was needed;
 * both mean "the remote budget ran out", which is more actionable than
 * `tar failed (124): no stderr`.
 */
export declare function archiveFailureMessage(exitCode: number | null | undefined, stderr: string): Error;
export interface RemoteRoutesDeps {
    store: RemoteStore;
    pool: RemotePool;
    worlds: RemoteWorlds;
    /** Host context (soft reads only: loader/settings for the routing route). */
    ctx: Context;
    /**
     * Effective timeouts, read per request so a `volatile()` config edit applies
     * live. Absent in tests and older wiring: the shared defaults then stand.
     */
    timeouts?: () => RemoteTimeouts;
    /** Session change ledger, when the host half mounted one. */
    changes?: SessionChanges;
    /**
     * Live local port forwards. Absent only in route-only probes (the gates build
     * `makeRoutes` with the minimum they need): the port routes then answer 503
     * instead of pretending the feature exists.
     */
    forwards?: ForwardManager;
}
export declare function makeRoutes(deps: RemoteRoutesDeps): {
    routes: WebRoute[];
    upgrade: WebUpgradeRoute;
    terminalSessions: TerminalSessionRegistry;
};
