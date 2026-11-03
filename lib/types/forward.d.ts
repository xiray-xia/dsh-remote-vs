import type { ClientChannel } from 'ssh2';
import type { RemoteForwardRequest, RemoteForwardState } from './protocol.ts';
/** Most simultaneous forward rules one host may carry. */
export declare const FORWARD_MAX_PER_ALIAS = 16;
/** Most TCP connections one rule accepts at once (browsers open several). */
export declare const FORWARD_MAX_CONNECTIONS = 32;
/**
 * The pool surface the manager needs.
 *
 * Structural on purpose: the gate drives a fake pool without an SSH server, and
 * the manager never reaches into the pool beyond one call.
 */
export interface ForwardPoolLike {
    forwardOut(alias: string, dstHost: string, dstPort: number, srcPort?: number): Promise<ClientChannel>;
}
export interface ForwardManagerDeps {
    pool: ForwardPoolLike;
    /** Diagnostic sink; defaults to a no-op (the Host wires its logger). */
    log?: (level: 'info' | 'warn', message: string) => void;
    /** Test seam: bound rules per alias. */
    maxPerAlias?: number;
    /** Test seam: concurrent connections per rule. */
    maxConnections?: number;
}
/** One validated rule request. */
export type ForwardValidation = {
    ok: true;
    value: RemoteForwardRequest;
} | {
    ok: false;
    error: string;
};
/**
 * Validate one request from the browser.
 *
 * `localPort` deliberately accepts 0 = "let the OS pick": the panel defaults to
 * auto-assignment because a fixed port invites EADDRINUSE from whatever else
 * the developer runs locally.
 */
export declare function validateForwardRequest(input: unknown): ForwardValidation;
/**
 * Stable rule identity.
 *
 * `localPort` is the port the CALLER asked for (0 = auto), not the one the OS
 * assigned: asking twice for the same automatic rule must return the running
 * forward instead of opening a second listener on a second random port.
 */
export declare function forwardIdOf(alias: string, remoteHost: string, remotePort: number, localPort: number): string;
/** What the panel copies / opens for one forward. */
export declare function forwardLocalUrl(localPort: number): string;
/** Listens on loopback and proxies every accepted connection over SSH. */
export declare class ForwardManager {
    private readonly deps;
    private readonly forwards;
    /**
     * Rules whose listener is still BINDING.
     *
     * Two clicks (or a restore racing the panel's own poll) must share one bind:
     * without this map the second call binds a SECOND listener on a different
     * automatic port, overwrites the first entry in `forwards`, and leaves the
     * first listener orphaned — unreachable from the panel and never closed.
     */
    private readonly starting;
    /** Set on unload so a bind that settles afterwards closes itself. */
    private disposed;
    constructor(deps: ForwardManagerDeps);
    /**
     * Start one rule (idempotent for the same requested tuple).
     *
     * Resolves with the state once the local listener is BOUND; a bind failure
     * (EADDRINUSE, permission) rejects, which the route maps to a caller-visible
     * status. A remote-side failure cannot be known yet — the first connection
     * discovers it and records it on the rule.
     */
    start(request: RemoteForwardRequest): Promise<RemoteForwardState>;
    /** Stop one rule. Returns false when the id is unknown (already stopped). */
    stop(id: string): boolean;
    /**
     * Stop every rule for one host alias (the host was deleted).
     *
     * A deleted host disappears from the panel — there is no row left to press
     * "stop" on — so leaving its listeners bound would squat the local ports
     * until the Host restarts. Returns how many rules were closed.
     */
    stopAlias(alias: string): number;
    /**
     * Stop every rule but keep the manager alive (plugin disabled).
     *
     * `dispose()` is the unload path and flips a flag that makes later binds
     * throw; a settings toggle needs the listeners gone without burning the
     * instance, because re-enabling the plugin must be able to start rules again.
     */
    stopAll(): number;
    /** Every rule, optionally narrowed to one host alias. */
    list(alias?: string): RemoteForwardState[];
    /** Close every listener and every proxied connection (plugin unload). */
    dispose(): void;
    /** Bind the loopback listener. Split out so the error path is one place. */
    private bindForward;
    /** One accepted local TCP connection: bound, or refused when the rule is full. */
    private accept;
    /**
     * Open one direct-tcpip channel for a local socket and pipe both ways.
     *
     * The channel is opened through the pool, so a dropped SSH connection is
     * re-dialed per new local connection; an in-flight one fails with the pool's
     * reason and is recorded on the rule.
     */
    private connect;
    /** Tear one rule down: listener, then every proxied connection. */
    private closeForward;
    private stateOf;
    private log;
}
