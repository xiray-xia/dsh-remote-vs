import type { RemoteDeployState, RemoteHostEntry, RemoteHostSummary, RemoteWorkspaceBinding } from './protocol.ts';
/** Payload accepted by create/update (secrets included, host-side only). */
export interface HostPayload {
    alias: string;
    host: string;
    port?: number;
    user: string;
    auth: {
        kind: 'key' | 'password';
        keyPath?: string;
        passphrase?: string;
        password?: string;
    };
    description?: string;
    tags?: string[];
}
export interface WorkspacePayload {
    name: string;
    alias: string;
    remotePath: string;
}
export declare class RemoteStore {
    private readonly file;
    private doc;
    /** File identity when `doc` was read from disk (undefined = `doc` is not known fresh). */
    private stamp;
    constructor(file?: string);
    /**
     * Reload from disk (picks up external edits).
     *
     * Re-reading on every access is deliberate: the root fs router asks this store
     * 2-4 times per routed file operation, and an edit made by another process
     * must be visible without a restart. A stat is orders of magnitude cheaper
     * than read + parse, so the file's identity (mtime + size) decides instead —
     * unchanged means the cached doc is already the file's content. The stamp is
     * taken BEFORE the read: a write landing in between leaves the older stamp
     * behind, so the next access re-reads rather than trusting a stale doc. The
     * one edit this cannot see is a same-length rewrite inside the filesystem's
     * mtime granularity (sub-ms on NTFS/ext4).
     */
    reload(): void;
    /**
     * File identity right now: `null` when the file is absent, `undefined` when it
     * cannot be statted at all. Both cases fall through to a full load, so the
     * missing-file and unreadable-file paths behave exactly as they did before.
     */
    private stampOf;
    private loadDoc;
    private save;
    /**
     * Re-read, mutate, then write only while the file has not changed underneath.
     *
     * Every mutation here rewrites the WHOLE document, so a plain
     * read-modify-write let the last writer win: desktop and `dsh web` share
     * `$DSH_HOME/dsh-remote.json` by design, and one side's host edit could
     * disappear without any error. Re-reading at the start plus a stamp re-check
     * right before the write turns that into a replay on fresh content.
     *
     * `apply` must only touch `this.doc` and return a value (no I/O, no logging):
     * a conflicting attempt is executed again against the reloaded document.
     * The final rename window is still unguarded (a real lock needs blocking I/O);
     * this narrows the lost-update window from a whole user edit to microseconds.
     */
    private mutate;
    list(): RemoteHostEntry[];
    get(alias: string): RemoteHostEntry | undefined;
    require(alias: string): RemoteHostEntry;
    create(payload: HostPayload): RemoteHostEntry;
    update(alias: string, patch: Partial<Omit<HostPayload, 'alias'>>): RemoteHostEntry;
    /**
     * Delete one host AND its workspace bindings.
     *
     * The cascade has to keep the tombstone contract (see `removeWorkspace`): a
     * binding that disappears while its alias dir stays on disk is no longer
     * routed, but DSH's workspace registry still lists that dir, so a session
     * rooted there would quietly execute LOCALLY against an empty folder instead
     * of failing closed. Every cascaded binding is therefore tombstoned in the
     * SAME atomic write as the removal — there is no on-disk state where the
     * binding is gone but its tombstone is missing.
     */
    remove(alias: string): boolean;
    private normalize;
    /** Secret-free projection for browser/agent surfaces. */
    summarize(entry: RemoteHostEntry): RemoteHostSummary;
    setDeploy(alias: string, state: RemoteDeployState): void;
    listWorkspaces(): RemoteWorkspaceBinding[];
    createWorkspace(payload: WorkspacePayload): RemoteWorkspaceBinding;
    removeWorkspace(id: string): boolean;
    /**
     * Record one tombstone without writing (idempotent).
     *
     * The caller owns `save()` so a change covering several bindings lands in ONE
     * atomic write: a crash between two writes must never leave a binding removed
     * while its tombstone is still missing.
     */
    private recordTombstone;
    /** Record a removed alias path (idempotent). */
    addTombstone(aliasPath: string): void;
    listTombstones(): string[];
}
