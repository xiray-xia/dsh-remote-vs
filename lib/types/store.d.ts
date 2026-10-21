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
    list(): RemoteHostEntry[];
    get(alias: string): RemoteHostEntry | undefined;
    require(alias: string): RemoteHostEntry;
    create(payload: HostPayload): RemoteHostEntry;
    update(alias: string, patch: Partial<Omit<HostPayload, 'alias'>>): RemoteHostEntry;
    remove(alias: string): boolean;
    private normalize;
    /** Secret-free projection for browser/agent surfaces. */
    summarize(entry: RemoteHostEntry): RemoteHostSummary;
    setDeploy(alias: string, state: RemoteDeployState): void;
    listWorkspaces(): RemoteWorkspaceBinding[];
    createWorkspace(payload: WorkspacePayload): RemoteWorkspaceBinding;
    removeWorkspace(id: string): boolean;
    /** Record a removed alias path (idempotent). */
    addTombstone(aliasPath: string): void;
    listTombstones(): string[];
}
