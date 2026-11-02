import type { ServerResponse } from 'node:http';
import type { RemotePool } from './pool.ts';
import type { RemoteFileEntry, RemoteRead, RemoteWriteConflict, RemoteWriteResult } from './protocol.ts';
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
 * The remote file changed after the bytes the caller saved against were read.
 *
 * Carries what is there NOW so the route can answer 409 with the current
 * version instead of a bare message — the client shows "changed at …, N bytes"
 * and offers overwrite / reload / see-the-difference without a second round
 * trip. A missing target is a conflict too (`mtime`/`size` null): the file this
 * buffer was loaded from is gone, so writing would recreate something a person
 * or another tool deliberately removed.
 *
 * The mtime comparison is SFTP's own (second granularity), so this narrows the
 * window rather than closing it: two writes to the same inode inside one second
 * share an mtime. `expectSize` covers the common "same second, different
 * length" case and nothing more. It is a guard against silent loss, not a
 * strong consistency protocol — the docs say so.
 */
export declare class WriteConflictError extends Error {
    readonly path: string;
    readonly conflict: RemoteWriteConflict;
    constructor(path: string, mtime: number | null, size: number | null);
}
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
 * same link). 256 KiB chunks with 32 in-flight requests (8 MiB of app-side
 * buffers) are the same tuning ssh2's fastGet/fastPut use and bound the
 * per-transfer memory; on top of that ssh2 holds up to one 2 MiB channel window
 * per channel in flight, so a two-channel download peaks around 12 MiB.
 */
export declare const TRANSFER_CHUNK_BYTES: number;
/** In-flight chunk window (also the per-transfer APP-side memory bound: 8 MiB). */
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
    /**
     * Side files this process is still writing (`alias\0path`). A sweep skips them
     * regardless of age — they are not orphans.
     */
    private readonly activePartials;
    /**
     * Side files this process CREATED and could not remove (`alias\0path`).
     *
     * This is the ONLY set a sweep may delete from. Deleting a name that merely
     * LOOKS like a side file is a guess, and guessing wrong destroys the user's
     * data (the audit's P2-N1: `foo.part-deadbeef` in a directory that once
     * recorded an orphan, older than the age bound, was irreversibly removed).
     * A leftover from a previous Host process is therefore never swept either:
     * junk that stays is recoverable, a deleted user file is not.
     */
    private readonly ownedPartials;
    /** alias -> directories that may hold an owned side file (sweep on next write). */
    private readonly orphanDirs;
    constructor(pool: RemotePool);
    list(alias: string, dir: string): Promise<RemoteFileEntry[]>;
    stat(alias: string, file: string): Promise<RemoteFileEntry>;
    read(alias: string, file: string): Promise<RemoteRead>;
    /**
     * Write one file whole (the remote editor's save / `remote_write`), atomically.
     *
     * Not `writeFile` on the target: that truncates it first, so an interrupted
     * save (a dropped link, a Host restart, a full disk mid-write) left the
     * previous content gone AND the new one half written. The bytes go to a SIDE
     * file next to the target (`.dsh-rvs.part-<8 hex>`, see `PART_MARKER`) and are
     * only moved into place once the body is complete.
     *
     * "Moved into place" must not delete the target first: the old unlink-then-
     * rename pair had a window where a failed rename left NEITHER the old file nor
     * the new one, and reported it as `no such file`. `replaceFile` therefore uses
     * OpenSSH's atomic `posix-rename` when the server advertises it, and otherwise
     * swaps the target aside with a rollback, so the previous bytes survive every
     * failure with the real error attached.
     *
     * Two things a fresh inode would otherwise lose:
     *  - a symbolic link target: the side file lives next to the link's REAL
     *    target and the link itself is left alone (the old in-place write punched
     *    through it; replacing it with a plain file silently changed what the path
     *    means);
     *  - the permission bits: they are copied back with `setstat` after the swap.
     *    Owner/group cannot be preserved without a privileged chown, so a save
     *    keeps the bytes and the mode but takes the SSH user's ownership.
     */
    write(alias: string, file: string, content: string, encoding?: 'utf8' | 'base64', guard?: {
        expectMtime?: number | undefined;
        expectSize?: number | undefined;
    }): Promise<RemoteWriteResult>;
    /**
     * Stream one upload into a remote file, atomically.
     *
     * Streaming, not `write()`: an upload is whatever the user dragged, so the
     * body must never be buffered whole in Host memory (the JSON `write` op caps
     * at 10 MiB of base64 for exactly that reason). Directories are created
     * first — a drop can name a path several levels below the target — and the
     * source is piped straight into the SFTP write stream.
     *
     * The bytes go to a SIDE file (`.dsh-rvs.part-<8 hex>` next to the target) and
     * are renamed into place only once the body ended cleanly. Writing the real path
     * directly left a half file behind whenever the upload was cancelled, which
     * then looked like a complete file in the explorer (2026-10-20 user report).
     * A cancelled upload removes its side file; when the CONNECTION is what failed
     * the unlink cannot run, so the directory is recorded and the next successful
     * write into it sweeps the orphan (see `sweepOrphanDirs`).
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
    /**
     * Remove a side file, remembering its directory when that is impossible.
     *
     * The only failure that leaves a side file behind is the failure it was
     * cleaning up after: with the connection dead, `unlink` cannot run either.
     * Recording the directory lets the NEXT successful write into it sweep the
     * orphan — otherwise it stays in the remote directory forever, looking like a
     * file the user created.
     */
    private discardPartial;
    /** Register one side file as ours: in flight now, and sweepable after it fails. */
    private trackPartial;
    /** Add one owned side-file key, evicting the oldest when the set is full. */
    private rememberOwned;
    /** The side file reached its target (or was removed): no longer ours to sweep. */
    private forgetPartial;
    private markOrphanDir;
    /**
     * Remove the side files THIS process left behind in `dir`.
     *
     * Runs after a SUCCESSFUL write/upload into a directory that recorded an
     * orphan, so the healthy path pays nothing. Two independent locks keep it off
     * anything the user owns:
     *
     *  1. the name must match the plugin's reserved shape (`.dsh-rvs.part-<8 hex>`);
     *  2. the exact path must be in `ownedPartials` — a set only `trackPartial`
     *     writes, i.e. a file this process itself created.
     *
     * The shape alone would still be a guess (the audit's P2-N1: a user file
     * `foo.part-deadbeef` was deleted after the age bound), so the ownership check
     * is the load-bearing one. A leftover from a PREVIOUS Host process carries the
     * shape but is not owned, and is therefore never deleted either — including a
     * side file left by a pre-marker release (`.part-<8 hex>`, which does not even
     * match the current shape). Junk that stays is recoverable; a deleted user
     * file is not.
     *
     * A sweep failure is never the caller's problem: the record simply survives
     * for the next write.
     */
    private sweepOrphanDirs;
    /** Add one key to a bounded set, evicting the oldest entry when full. */
    private remember;
    /** Forget `dir`, its parents and everything remembered under it. */
    private forgetDirs;
}
