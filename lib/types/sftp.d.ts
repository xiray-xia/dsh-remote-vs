import type { ServerResponse } from 'node:http';
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
/**
 * How long one download stream may make no progress before it is failed.
 *
 * A download has no wall-clock budget for the same reason an upload does not: a
 * big file on a slow link is healthy for minutes. What must never happen is a
 * silently dead stream pinning the SFTP session (and its channel slot) forever,
 * so progress is the bound — any chunk resets this clock.
 */
export declare const DOWNLOAD_IDLE_MS = 60000;
/** Upload progress bound (no body bytes and no write acknowledgements). */
export declare const UPLOAD_IDLE_MS = 60000;
/**
 * Parallel-transfer shape, shared by download and upload.
 *
 * A single `createReadStream`/`createWriteStream` keeps exactly ONE SFTP request
 * in flight per round trip; measured against a real host that cost about 8x
 * (4.4 MiB/s single stream vs 35.4 MiB/s for ssh2's pipelined fastGet on the
 * same link). 256 KiB chunks with 32 in-flight requests (8 MiB window) are the
 * same tuning ssh2's fastGet/fastPut use, and bound the per-transfer memory.
 */
export declare const TRANSFER_CHUNK_BYTES: number;
/** In-flight chunk window (also the per-transfer memory bound: 8 MiB). */
export declare const TRANSFER_CONCURRENCY = 32;
/**
 * Channels a big download spreads its READ window over.
 *
 * ssh2 (Channel.js `MAX_WINDOW`) and OpenSSH cap ONE SSH channel's window at
 * 2 MiB, so a single channel can never keep more than that many bytes of READs
 * outstanding however large the requested concurrency is. Measured against a
 * real host on a 96 MiB file with the same total concurrency (256 KiB chunks):
 * 1 channel 28.6 MiB/s, 2 channels 46.1, 4 channels 51.3 — two channels take
 * most of the gain at a quarter of the cost of four. Uploads showed no such
 * gain (46.0 → 50.4 MiB/s: the server's write path is the bound), so uploads
 * stay on one channel.
 */
export declare const TRANSFER_SESSIONS = 2;
/**
 * Below this size a second channel is not worth its channel-open round trip and
 * channel slot: the file is only a handful of READ windows long, so the extra
 * channel would mostly be opened and closed.
 */
export declare const MULTI_CHANNEL_MIN_BYTES: number;
/** Assert an absolute POSIX remote path and return its normalized form. */
export declare function remotePath(path: string): string;
/**
 * `Content-Disposition` for one attachment (RFC 6266 + RFC 5987).
 *
 * Receivers prefer `filename*` when both forms are present (RFC 6266 §4.3),
 * which is why a non-ASCII remote name survives the round trip; the quoted
 * ASCII copy is the fallback for clients that do not understand the extended
 * form. Quotes and backslashes are stripped from that fallback so they cannot
 * break the header.
 */
export declare function attachmentHeader(fileName: string): string;
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
    /**
     * Stream one remote file into an HTTP response (download to the local machine).
     *
     * Streaming, not `read()`: `read()` caps at 8 MiB because it answers a JSON
     * editor read, while a download is whatever the user pointed at — a log, a
     * binary, an artifact. The file is opened through one SFTP handle before the
     * headers are written: symlinks are followed (lstat's size is the link
     * target's string length, not the file's), directories are refused, and the
     * content length comes from the same handle the body is read through. The
     * session has no wall-clock deadline (see `DOWNLOAD_IDLE_MS`); the caller's
     * response close and stream errors are both handled, so a cancelled download
     * never leaves the SFTP session or its channel slot pinned.
     *
     * @param alias - host alias.
     * @param file - absolute remote source path.
     * @param res - HTTP response to write the file into.
     */
    download(alias: string, file: string, res: ServerResponse): Promise<void>;
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
