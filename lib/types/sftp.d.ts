import type { RemotePool } from './pool.ts';
import type { RemoteFileEntry, RemoteRead } from './protocol.ts';
/** Single-read cap (matches the fs-ssh 8 MiB window). */
export declare const READ_CAP: number;
/**
 * Hard cap for one directory listing. A pathological directory (a spool, a
 * build cache, someone's 100k-file dump) would otherwise build a single
 * 15-20 MB JSON response in this process — and `JSON.stringify` doubles that
 * peak while it serialises. High enough that no real directory is affected,
 * low enough that one cannot take the host down. The cap keeps explorer order
 * (directories first, then by name), so which entries survive is deterministic.
 */
export declare const LIST_ENTRY_CAP = 20000;
/** Largest single upload accepted (matches the client-side planner cap). */
export declare const UPLOAD_MAX_BYTES: number;
/** Assert an absolute POSIX remote path and return its normalized form. */
export declare function remotePath(path: string): string;
export declare class RemoteFiles {
    private readonly pool;
    /**
     * `alias + level` pairs confirmed to exist on the remote (insertion order,
     * oldest evicted first). Only an optimisation: see ensureDir().
     */
    private readonly knownDirs;
    /** Listings already reported as truncated; the log line stays one per path. */
    private readonly capWarned;
    constructor(pool: RemotePool);
    list(alias: string, dir: string): Promise<RemoteFileEntry[]>;
    stat(alias: string, file: string): Promise<RemoteFileEntry>;
    read(alias: string, file: string): Promise<RemoteRead>;
    write(alias: string, file: string, content: string, encoding?: 'utf8' | 'base64'): Promise<{
        size: number;
    }>;
    /**
     * Stream one upload into a remote file, atomically.
     *
     * Streaming, not `write()`: an upload is whatever the user dragged, so the
     * body must never be buffered whole in Host memory (the JSON `write` op caps
     * at 10 MiB of base64 for exactly that reason). Directories are created
     * first — a drop can name a path several levels below the target — and the
     * source is piped straight into the SFTP write stream.
     *
     * The bytes go to a SIDE file (`.part-<id>` next to the target) and are
     * renamed into place only once the body ended cleanly. Writing the real path
     * directly left a half file behind whenever the upload was cancelled, which
     * then looked like a complete file in the explorer (2026-10-20 user report).
     * On any failure the side file is removed, so a cancelled upload leaves the
     * remote folder exactly as it was.
     *
     * @param alias - host alias.
     * @param file - absolute remote destination path.
     * @param source - request body stream (or any readable).
     * @param maxBytes - hard ceiling; exceeding it destroys the stream and fails.
     * @param overwrite - replace an existing target (the route already asked).
     * @returns the number of bytes written.
     */
    upload(alias: string, file: string, source: NodeJS.ReadableStream, maxBytes?: number, overwrite?: boolean): Promise<{
        size: number;
    }>;
    mkdir(alias: string, dir: string): Promise<void>;
    remove(alias: string, target: string, recursive: boolean): Promise<void>;
    rename(alias: string, oldPath: string, newPath: string): Promise<void>;
    /**
     * Create every missing level of `dir`.
     *
     * Each level is remembered once it is confirmed (or created): without that, a
     * save walks the whole path with `mkdir` again — typically 4-6 round trips
     * whose answers can only be EEXIST — on every single write. The memo is safe
     * because every caller that could be broken by a stale entry either creates
     * its target for real (mkdir) or retries once after forgetting the prefix
     * (withDirRetry); the operations that make entries stale (remove, rename)
     * forget them outright.
     */
    private ensureDir;
    /** Create one level, tolerating "already exists" (and verifying the rest). */
    private mkdirLevel;
    /**
     * Run one directory-creating operation, and if it fails because a level the
     * memo vouched for is gone (the user deleted the tree, a cleanup removed the
     * deploy root), forget that path and run it once more so the walk recreates
     * what is missing. Only "no such file" is retried: any other failure is the
     * caller's to see, and a retried operation is safe because it never got past
     * the directory walk.
     */
    private withDirRetry;
    /** Add one key to a bounded set, evicting the oldest entry when full. */
    private remember;
    /** Forget `dir`, its parents and everything remembered under it. */
    private forgetDirs;
}
