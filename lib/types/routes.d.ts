import type { Context } from '@deepseek-ai/cordis';
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver';
import { type RemoteTimeouts } from './protocol.ts';
import type { RemoteStore } from './store.ts';
import type { RemotePool } from './pool.ts';
import type { RemoteWorlds } from './p2/worlds.ts';
import { TerminalSessionRegistry } from './terminal.ts';
import type { SessionChanges } from './changes/recorder.ts';
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
}
export declare function makeRoutes(deps: RemoteRoutesDeps): {
    routes: WebRoute[];
    upgrade: WebUpgradeRoute;
    terminalSessions: TerminalSessionRegistry;
};
