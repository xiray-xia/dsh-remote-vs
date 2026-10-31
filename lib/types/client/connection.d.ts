import type { RemoteConnectionStatus } from '../protocol.ts';
export type ConnectionState = 'ok' | 'error' | 'idle';
/** Automatic-retry cadence for an errored link (one dial per tick). */
export declare const AUTO_RETRY_MS = 30000;
/**
 * Automatic attempts allowed per error episode.
 *
 * Not endless on purpose: each attempt is a real SSH dial, and repeated dials
 * against a password-auth host can count towards a lockout. After the budget
 * the chip stays a manual retry control.
 */
export declare const AUTO_RETRY_MAX_ATTEMPTS = 3;
/**
 * Decide one automatic-retry tick.
 *
 * Pure so the budget can be pinned without a browser: ok/idle reset the
 * count, rror consumes one attempt until the budget is spent.
 */
export declare function consumeAutoRetry(state: ConnectionState, attempts: number): {
    run: boolean;
    attempts: number;
};
/**
 * The i18n key for a state's label.
 *
 * Kept here (not inside the chip) so the gate can assert the MAPPING without a
 * browser: rendering the pool's normal lazy state as "not connected" was a real
 * UX defect — idle means "nothing to report yet / connects on demand", not a
 * broken link.
 */
export declare function connectionLabelKey(state: ConnectionState): string;
/** What the UI renders for one alias. */
export interface ConnectionView {
    alias: string;
    state: ConnectionState;
    /** Last transport error message (only while state === 'error'). */
    error?: string;
    /** When the Host last saw a transport error, epoch ms. */
    errorAt?: number;
    /** When the Host last completed a dial / transport-level operation. */
    okAt?: number;
    /** A pooled SSH connection is open right now (diagnostic detail only). */
    open: boolean;
    /**
     * Client time of the last locally noted failure. A poll that still reports
     * the older success must not clear an error the page just saw.
     */
    notedAt?: number;
}
/**
 * Whether `error` (or its message) is a transport-level failure.
 *
 * The flag is honoured first: a repeat failure's message is REWRITTEN to a
 * localized sentence before it is thrown (see `api.call`), and downstream
 * guards (toast quieting, the offline banner) must still see a link error.
 */
export declare function isConnectionFailure(error: unknown): boolean;
/** Point the view at the workspace the user is looking at. */
export declare function setActiveConnectionAlias(alias: string): void;
/** The alias the surface currently belongs to ('' when none). */
export declare function activeConnectionAlias(): string;
/**
 * Apply the Host's status list. A host-reported success clears an error only
 * when it is NEWER than the local failure note: otherwise a poll that raced the
 * failing operation would flip the chip back to green while the toast still
 * says the request failed.
 */
export declare function applyConnectionStatuses(list: readonly RemoteConnectionStatus[]): void;
/** Record a transport failure the page just observed on `alias`. */
export declare function noteConnectionFailure(alias: string, error: unknown): void;
/** Drop every cached view — tests only (a live page keeps its map). */
export declare function resetConnectionViews(): void;
/** Record that an explicit retry just succeeded for `alias`. */
export declare function markConnectionProbeOk(alias: string): void;
/** Where the last observed state came from (see `isConnectionRecovery`). */
export interface ConnectionTrace {
    alias: string;
    state: string | undefined;
}
/**
 * Whether this is the LINK recovering, as opposed to a workspace switch.
 *
 * Between two already-errored hosts the alias changes while the state does not;
 * counting that as a recovery would refresh the wrong workspace. The caller
 * keeps a trace keyed by alias, so by the time the new host recovers this sees
 * `(b, error) → (b, ok)`.
 */
export declare function isConnectionRecovery(previous: ConnectionTrace | undefined, alias: string, state: string | undefined): boolean;
/** Current view of the active alias (the hook is the UI path; this is for gates). */
export declare function currentConnection(): ConnectionView | undefined;
/** Subscribe to the active alias's connection view (undefined when none). */
export declare function useConnectionStatus(): ConnectionView | undefined;
