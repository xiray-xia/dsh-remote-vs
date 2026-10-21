import type { RemotePool } from './pool.ts';
import type { RemoteStore } from './store.ts';
export interface BootstrapResult {
    alias: string;
    keyPath: string;
    /** True when the store entry flipped from password to key auth. */
    flipped: boolean;
    detail: string;
}
/** Ensure the managed keypair exists; return the private key path. */
export declare function ensureKeypair(alias: string, dir?: string): Promise<{
    privatePath: string;
    publicKey: string;
}>;
/**
 * Bootstrap one host: install the managed public key remotely, then flip the
 * entry to key auth and drop the pooled password connection.
 */
export declare function bootstrap(pool: RemotePool, store: RemoteStore, alias: string): Promise<BootstrapResult>;
