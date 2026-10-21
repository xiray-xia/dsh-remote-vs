/**
 * Typed fetch wrapper over the /api/dsh-remote JSON API (full P0 surface).
 */
import { type GitBranch, type GitCommit, type GitShow, type GitStatus, type HelperAvailability, type ImportReport, type RemoteChangesDiff, type RemoteChangesSummary, type RemoteDeployState, type RemoteExecResult, type RemoteFileEntry, type RemoteHostSummary, type RemotePluginMeta, type RemoteProbe, type RemoteRead, type RemoteRoutingStatus, type RemoteTimeouts, type RemoteWorkspaceBinding } from '../protocol.ts';
export declare class RemoteApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string);
}
/** Apply the Host-provided pair (clamped; a malformed answer keeps defaults). */
export declare function configureTimeouts(value: unknown): RemoteTimeouts;
/** Current per-git-command timeout in milliseconds. */
export declare function gitTimeoutMs(): number;
/** Current per-file-read timeout in milliseconds. */
export declare function fileReadTimeoutMs(): number;
/** Progress of one upload, in bytes as the browser reports them. */
export interface UploadProgress {
    loaded: number;
    total: number;
}
/**
 * Upload one file's bytes to an absolute remote path.
 *
 * XHR rather than `fetch`: only XHR reports UPLOAD progress, and a drag & drop
 * of a large file with no feedback is indistinguishable from a hang (the same
 * lesson the git timeouts taught). The body is the raw bytes — the host route
 * streams them into SFTP, so neither side buffers the whole file.
 *
 * @param options.alias - host alias.
 * @param options.path - absolute remote destination path.
 * @param options.blob - the file to send.
 * @param options.overwrite - replace an existing file (the route answers 409
 *   with `status === 409` otherwise, which the caller resolves per batch).
 * @param options.signal - cancels the transfer.
 * @param options.onProgress - called as the browser flushes body bytes.
 * @returns the byte count the host wrote.
 */
export declare function uploadFile(options: {
    alias: string;
    path: string;
    blob: Blob;
    overwrite?: boolean;
    signal?: AbortSignal;
    onProgress?: (progress: UploadProgress) => void;
}): Promise<{
    size: number;
}>;
export interface HostForm {
    alias: string;
    host: string;
    port: number;
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
export interface PushReportView {
    alias: string;
    probe: RemoteProbe;
    action: 'pushed' | 'skipped-same' | 'failed';
    detail: string;
}
export declare const api: {
    getHosts: () => Promise<RemoteHostSummary[]>;
    createHost: (payload: HostForm) => Promise<RemoteHostSummary>;
    updateHost: (alias: string, patch: Partial<HostForm>) => Promise<RemoteHostSummary>;
    deleteHost: (alias: string) => Promise<{
        ok: boolean;
    }>;
    testHost: (alias: string) => Promise<{
        ok: boolean;
        error?: string;
        durationMs: number;
    }>;
    bootstrap: (alias: string) => Promise<{
        alias: string;
        keyPath: string;
        flipped: boolean;
        detail: string;
    }>;
    fileOp: {
        list: (alias: string, path: string) => Promise<RemoteFileEntry[]>;
        stat: (alias: string, path: string) => Promise<RemoteFileEntry>;
        read: (alias: string, path: string) => Promise<RemoteRead>;
        write: (alias: string, path: string, content: string) => Promise<{
            size: number;
        }>;
        mkdir: (alias: string, path: string) => Promise<{
            ok: boolean;
        }>;
        rm: (alias: string, path: string, recursive: boolean) => Promise<{
            ok: boolean;
        }>;
        rename: (alias: string, from: string, to: string) => Promise<{
            ok: boolean;
        }>;
    };
    exec: (alias: string, command: string, timeoutMs?: number) => Promise<RemoteExecResult>;
    getWorkspaces: () => Promise<{
        workspaces: RemoteWorkspaceBinding[];
    } & RemoteRoutingStatus & RemotePluginMeta>;
    createWorkspace: (payload: {
        name: string;
        alias: string;
        remotePath: string;
    }) => Promise<{
        workspace: RemoteWorkspaceBinding;
        aliasPath: string;
    }>;
    deleteWorkspace: (id: string) => Promise<{
        ok: boolean;
    }>;
    /**
     * Current working directory of one live session, for click resolution.
     *
     * A model quotes files relative to where it actually worked; the workspace
     * root alone misses that (see `remote-file-open-target.ts`). Unknown or
     * non-live sessions answer `undefined` and the caller keeps the root base.
     */
    sessionCwd: (sessionId: string) => Promise<{
        cwd?: string;
    }>;
    /**
     * What one live session changed on its remote host.
     *
     * `list` is cheap — the host already holds the ledger — so the dock polls it;
     * `diff` costs one remote git run per file, so it is fetched only when a file
     * is opened for review.
     */
    changes: {
        list: (sessionId: string, force?: boolean, repoSubdir?: string) => Promise<RemoteChangesSummary | null>;
        diff: (sessionId: string, path: string, repoSubdir?: string) => Promise<RemoteChangesDiff | null>;
    };
    setRoutingMode: (mode: "off" | "shadow" | "enforce") => Promise<"off" | "shadow" | "enforce">;
    deployStatus: (alias: string) => Promise<{
        deploy: RemoteDeployState;
        helpers: HelperAvailability[];
    }>;
    deployProbe: (alias: string) => Promise<RemoteProbe>;
    deployPush: (alias: string) => Promise<PushReportView>;
    importSshConfig: () => Promise<ImportReport>;
    importDshSsh: () => Promise<ImportReport>;
    terminalClose: (id: string) => Promise<{
        ok: boolean;
    }>;
    git: {
        status(alias: string, path: string): Promise<GitStatus>;
        log(alias: string, path: string, max: number, branch?: string): Promise<GitCommit[]>;
        branches(alias: string, path: string, current: string): Promise<GitBranch[]>;
        show(alias: string, path: string, ref: string): Promise<GitShow>;
    };
    terminalUrl: (params: {
        alias?: string;
        session?: string;
        cols: number;
        rows: number;
    }) => string;
};
