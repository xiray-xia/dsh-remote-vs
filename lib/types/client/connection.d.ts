import type { RemoteConnectionStatus } from '../protocol.ts';
export type ConnectionState = 'ok' | 'error' | 'idle';
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
/** Whether `error` (or its message) is a transport-level failure. */
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
/** Clear the local overlay once the link is proven back (test/retry). */
export declare function noteConnectionOk(alias: string): void;
/** Drop every cached view — tests only (a live page keeps its map). */
export declare function resetConnectionViews(): void;
/** Current view of the active alias (the hook is the UI path; this is for gates). */
export declare function currentConnection(): ConnectionView | undefined;
/** Subscribe to the active alias's connection view (undefined when none). */
export declare function useConnectionStatus(): ConnectionView | undefined;
