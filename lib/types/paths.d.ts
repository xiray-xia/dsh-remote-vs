/** Resolved DSH home directory. */
export declare function dshHome(): string;
/** Absolute path of the remote store file. */
export declare function storePath(home?: string): string;
/** Absolute path of the managed-keys directory (created 0700 on demand). */
export declare function keysDir(home?: string): string;
/** Absolute path of the helper tarball cache directory. */
export declare function helpersDir(home?: string): string;
/** Absolute path of the remote-workspace alias root. */
export declare function aliasRoot(home?: string): string;
/** Ensure a directory exists with 0700 (best effort on Windows). */
export declare function ensurePrivateDir(path: string): void;
