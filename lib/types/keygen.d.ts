import type { RemotePool } from './pool.ts';
import type { RemoteStore } from './store.ts';
export interface BootstrapResult {
    alias: string;
    keyPath: string;
    /** True when the store entry flipped from password to key auth. */
    flipped: boolean;
    detail: string;
}
/**
 * Normalize one `.pub` line to `ssh-ed25519 <base64> dsh-remote-vs/<alias>`.
 *
 * Throws when the line is not a well-formed ed25519 public key, so the caller
 * sees a clear "this file is not a key" error instead of a remote login that
 * fails later. The returned text is the only form that may enter the shell
 * command: its comment is ours, and both remaining fields are shell-inert.
 */
export declare function formatPublicKey(raw: string, alias: string): string;
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
