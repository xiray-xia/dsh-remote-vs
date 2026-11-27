import { type ProxyConfig } from './proxy.ts';
import type { RemoteDeployState, RemoteHostEntry, RemoteHostProxySetting, RemoteProxySettingsPatch, RemoteProxySettingsView, RemoteHostSummary, RemoteWorkspaceBinding } from './protocol.ts';
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
    /** How this host reaches the network; omitted = `inherit` (back-compat). */
    proxy?: RemoteHostProxySetting;
    description?: string;
    tags?: string[];
}
export interface WorkspacePayload {
    name: string;
    alias: string;
    remotePath: string;
}
/**
 * The effective network route one dial must take (see `resolveProxy`).
 *
 * `source` is kept because "the profile default sent me through a proxy" and "this
 * host says so" are different answers to the same question in `remote_hosts`.
 */
export type ResolvedProxy = {
    kind: 'direct';
} | {
    kind: 'proxy';
    proxy: ProxyConfig;
    source: 'host' | 'default';
} | {
    kind: 'jump';
    viaAlias: string;
};
export declare class RemoteStore {
    private readonly file;
    private doc;
    /** File identity when `doc` was read from disk (undefined = `doc` is not known fresh). */
    private stamp;
    constructor(file?: string);
    /**
     * Absolute path of the JSON document.
     *
     * Diagnostics only: a corrupt file must name itself in the error a surface
     * shows, otherwise the user only sees "the request failed".
     */
    get filePath(): string;
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
    /**
     * Validate one host's stored proxy decision.
     *
     * The rules are the ones the two-level model needs to stay explainable:
     * - the mode is one of the four declared values;
     * - `proxy` needs an endpoint, `jump` needs another EXISTING alias (a host
     *   cannot jump through itself, and a chain is impossible to resolve with one
     *   pooled hop);
     * - fields that the chosen mode does not use are DROPPED rather than stored, so
     *   switching modes cannot leave a stale endpoint behind that a later reader
     *   would take for the active one.
     *
     * @returns the normalized setting, or undefined for `inherit` (stored as the
     *   field's absence, which is what older files have).
     */
    private validateHostProxy;
    /**
     * Why a host's proxy decision cannot be used, when it cannot.
     *
     * Reads NEVER throw for this: a host that points at a deleted jump host must
     * still be listed (with the reason on its row) instead of making the whole host
     * list fail. The dial path asks {@link resolveProxy}, which does fail closed.
     */
    private proxyProblem;
    /** Secret-free view of one stored proxy endpoint. */
    private targetView;
    /** Secret-free view of one host's proxy decision (always present). */
    private proxyView;
    /** Secret-free projection for browser/agent surfaces. */
    summarize(entry: RemoteHostEntry): RemoteHostSummary;
    /** Secret-free view of the profile-wide proxy default (read-only). */
    getDefaultProxy(): RemoteProxySettingsView;
    /** View of the in-memory document (no reload: callers already reloaded). */
    private defaultProxyView;
    /**
     * Patch the profile-wide proxy default.
     *
     * `target` semantics follow the host form: omitted keeps the stored endpoint,
     * `null` clears it, an object replaces it — and an EMPTY PASSWORD keeps the
     * stored one, because the browser never receives secrets back.
     */
    patchDefaultProxy(patch: RemoteProxySettingsPatch): RemoteProxySettingsView;
    /**
     * Normalize a patched endpoint, keeping the stored password on an empty one.
     *
     * "Empty means keep" is only sound for the SAME endpoint: the browser never
     * receives the secret back, so every PATCH of a proxied host arrives without
     * one — but when kind/host/port/username changed, the stored password is a
     * credential for a DIFFERENT server, and carrying it over would send the old
     * secret to a new address (a 407 at best, a leaked credential at worst). A
     * changed endpoint therefore drops it and the user re-enters it.
     */
    private mergeProxyTarget;
    /**
     * Resolve one host's EFFECTIVE route, in the precedence the UI describes:
     * the host's own decision, else the profile default, else direct.
     *
     * Unlike {@link summarize}, this FAILS CLOSED for an unusable jump: dialing
     * through a deleted host (or a second jump) cannot work, and the caller must say
     * why instead of silently connecting some other way.
     */
    resolveProxy(alias: string): ResolvedProxy;
    private requireStoredProxy;
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
