/**
 * Wire contract between the host half (routes.ts) and the browser half
 * (client/api.ts). Pure types + path constants only — imported by both
 * halves, bundled into each, no runtime identity to share.
 */
/** API route table (all loopback-only). */
export declare const REMOTE_API: {
    readonly hosts: "/api/dsh-remote/hosts";
    readonly test: "/api/dsh-remote/test";
    /** Per-alias SSH connection health for the client's status indicator. */
    readonly status: "/api/dsh-remote/status";
    readonly keygen: "/api/dsh-remote/keygen";
    readonly exec: "/api/dsh-remote/exec";
    /** Streaming exec (server-sent events) for the long network verbs. */
    readonly execStream: "/api/dsh-remote/exec-stream";
    readonly files: "/api/dsh-remote/files";
    /** Streaming binary upload: raw request body, host and path in the query. */
    readonly upload: "/api/dsh-remote/upload";
    /** Streaming binary download: raw response body, host and path in the query. */
    readonly download: "/api/dsh-remote/download";
    /** Streaming directory download: a remote `tar -czf -` of the directory. */
    readonly downloadDir: "/api/dsh-remote/download-dir";
    /** Streaming multi-selection download: one remote tar of repeated `path` params. */
    readonly downloadMany: "/api/dsh-remote/download-many";
    readonly workspaces: "/api/dsh-remote/workspaces";
    readonly deploy: "/api/dsh-remote/deploy";
    readonly importSshConfig: "/api/dsh-remote/import-ssh-config";
    readonly importDshSsh: "/api/dsh-remote/import-dsh-ssh";
    readonly terminal: "/api/dsh-remote/terminal";
    readonly terminalClose: "/api/dsh-remote/terminal-close";
    readonly routing: "/api/dsh-remote/routing";
    /** Current working directory of one live session (click resolution helper). */
    readonly sessionCwd: "/api/dsh-remote/session-cwd";
    /** What one live session changed on its remote host (the review panel). */
    readonly changes: "/api/dsh-remote/changes";
    /** Local TCP forwards (`ssh -L` semantics) for the port panel. */
    readonly forwards: "/api/dsh-remote/forwards";
    /** Remote listening TCP sockets for the port panel (one bounded probe). */
    readonly listenPorts: "/api/dsh-remote/listen-ports";
};
/**
 * Most entries one multi-selection download may archive. The selection rides in
 * the request URL (one `path` param per entry), so this bounds both the archive
 * and the request line; a larger selection should download its folder instead.
 */
export declare const MAX_SELECTION_DOWNLOAD = 100;
/** Suggested/attachment file name for one multi-selection archive. */
export declare function selectionDownloadName(count: number): string;
/** Authentication flavors a host entry may carry (P0: direct only, no jump/agent). */
export type RemoteAuthKind = 'key' | 'password';
/** One stored host entry (the $DSH_HOME/dsh-remote.json store shape). */
export interface RemoteHostEntry {
    /** Stable, user-chosen identifier used by every operation. */
    alias: string;
    /** Hostname or IP of the target. */
    host: string;
    /** SSH port (default 22). */
    port: number;
    /** Login user. */
    user: string;
    /** Authentication. */
    auth: {
        kind: RemoteAuthKind;
        /** Absolute path to the private key for 'key' auth. */
        keyPath?: string;
        /** Passphrase for an encrypted key. */
        passphrase?: string;
        /** Password for 'password' auth. */
        password?: string;
    };
    /** Free-form note. */
    description?: string;
    /** Free-form tags. */
    tags: string[];
    /** Last deploy pipeline outcome for this host. */
    deploy?: RemoteDeployState | undefined;
    createdAt: number;
    updatedAt: number;
}
/** Public (secret-free) projection of an entry, safe for the browser/agent. */
export interface RemoteHostSummary {
    alias: string;
    host: string;
    port: number;
    user: string;
    auth: RemoteAuthKind;
    /** Whether the key path exists on this machine (key auth only). */
    keyReady: boolean;
    /** True when the entry was bootstrapped by this plugin (managed keypair). */
    managedKey: boolean;
    description?: string;
    tags: string[];
    deploy?: RemoteDeployState | undefined;
    createdAt: number;
    updatedAt: number;
}
/** One remote workspace binding: a host plus a remote directory. */
export interface RemoteWorkspaceBinding {
    /** Stable id ( cuid-ish ). */
    id: string;
    /** Display name. */
    name: string;
    /** Host alias this workspace lives on. */
    alias: string;
    /** Absolute POSIX path on the remote host. */
    remotePath: string;
    createdAt: number;
}
/** P2 routing status (Phase 4 workspaces GET extension). */
export interface RemoteRoutingStatus {
    /** Live kill-switch position. */
    mode: 'off' | 'shadow' | 'enforce';
    /** Binding id -> materialized local alias dir. */
    aliasPaths: Record<string, string>;
    /** Removed alias dirs that fail closed (history kept). */
    tombstones: string[];
}
/** Plugin identity (workspaces GET extension for the Settings display). */
export interface RemotePluginMeta {
    /** Version from the shipped package.json ('unknown' when unreadable). */
    version: string;
    /**
     * Effective per-operation timeouts, in milliseconds. Served so the browser
     * can apply the same numbers the Host enforces; an older Host omits it and
     * the client keeps its own (identical) defaults.
     */
    timeouts?: RemoteTimeouts;
}
/** One timeout per kind of remote round trip. */
export interface RemoteTimeouts {
    /** One git command (status/log/branches/diff over the exec route). */
    gitMs: number;
    /** One SFTP file read (editor, diff sides, document preview). */
    readMs: number;
}
/**
 * Connection health for one host alias, as the Host's pool sees it.
 *
 * The browser never talks SSH itself, so it cannot know whether the link is up;
 * this is the Host's answer. `idle` is NOT an error: a pooled connection is
 * closed after 30 idle minutes, and the next operation dials again. `error`
 * means the last connection-level event failed (dial error, unexpected close,
 * or a transport-class operation failure) — the next operation will retry.
 */
export interface RemoteConnectionStatus {
    alias: string;
    state: 'ok' | 'error' | 'idle';
    /** A pooled SSH connection is open right now (not a health promise on its own). */
    open: boolean;
    /** Last successful dial / transport-level operation, epoch ms. */
    okAt?: number;
    /** Last connection-level failure, epoch ms. */
    errorAt?: number;
    /** Human-readable failure the client can show in the status chip. */
    error?: string;
}
/** Remote OS probe outcome. */
export interface RemoteProbe {
    alias: string;
    ok: boolean;
    /** Raw `uname -m` (x86_64 / aarch64 / ...). */
    arch: string;
    /** Mapped helper platform (linux-x64 / linux-arm64 / macos-x64 / macos-arm64 / unknown). */
    platform: string;
    /** `uname -s`. */
    os: string;
    /** glibc version when detectable (linux). */
    libc?: string | undefined;
    /** Remote node version when installed (`node --version`), else undefined. */
    node?: string | undefined;
    /** Remote home directory. */
    home?: string | undefined;
    durationMs: number;
    error?: string | undefined;
}
/** Helper provider kinds the deploy pipeline knows. */
export type HelperKind = 'executable' | 'node-script';
/** Availability of one helper provider. */
export interface HelperAvailability {
    kind: HelperKind;
    available: boolean;
    reason: string;
    /** Locally cached builds (executable only). */
    cached?: {
        version: string;
        platform: string;
    }[];
}
/** Last deploy pipeline outcome stored per host. */
export interface RemoteDeployState {
    status: 'ok' | 'skipped-same' | 'failed' | 'not-deployed';
    /** What was pushed (P0: probe-bundle marker; P1: helper kind+version). */
    artifact: string;
    /** sha256 of the installed artifact manifest. */
    manifestHash?: string | undefined;
    detail?: string | undefined;
    /** Remote $HOME observed at push time (locates the install without re-probing). */
    home?: string | undefined;
    /** Installed helper identity (P1+ artifacts). */
    helper?: {
        kind: HelperKind;
        version: string;
        sha256: string;
        platform?: string;
    } | undefined;
    at: number;
}
/** Remote manifest installed at ~/.dsh-helpers/manifest.json. */
export interface RemoteManifest {
    version: 1;
    artifact: string;
    manifestHash: string;
    helper?: {
        kind: HelperKind;
        version: string;
        sha256: string;
        platform?: string;
    } | undefined;
    installedAt: number;
}
/** One remote directory row (SFTP). */
export interface RemoteFileEntry {
    name: string;
    /** Absolute POSIX path. */
    path: string;
    isDir: boolean;
    size: number;
    /** mtime in ms. */
    mtime: number;
    /** POSIX mode bits. */
    mode: number;
    isSymlink: boolean;
}
/** Result of one remote file read (SFTP window). */
export interface RemoteRead {
    /** File size in bytes. */
    size: number;
    /**
     * Modification time in ms — the optimistic-lock baseline for a save.
     *
     * Read with the bytes in the same SFTP round trip, so the pair describes ONE
     * version of the file. The editor stores it and sends it back on save; the
     * Host refuses the write when the remote file has a different mtime, because
     * that means someone else (an agent through the transparent route, a
     * terminal, another editor) wrote it after this buffer was loaded and
     * accepting the save would destroy their work without a word.
     */
    mtime: number;
    /** True when the content is not UTF-8 text (base64 holds the bytes). */
    binary: boolean;
    text?: string | undefined;
    base64?: string | undefined;
    /** True when size exceeded READ_CAP (content holds the first window). */
    truncated: boolean;
}
/** Result of one remote file write, including the version it left behind. */
export interface RemoteWriteResult {
    /** Bytes written. */
    size: number;
    /**
     * mtime of the NEW content in ms: the baseline for the next save.
     *
     * `null` when the post-write stat could not be read. The save still SUCCEEDED
     * (the bytes are in place), so this is not an error — it only means the next
     * save has no baseline to check and must go through unguarded. Saying so is
     * the whole point: a fabricated timestamp would make every later save of that
     * tab conflict with itself.
     */
    mtime: number | null;
}
/**
 * The remote file changed since the baseline the caller saved against.
 *
 * Deliberately its own shape (not a generic failure): the client has to offer
 * "overwrite / reload / see the difference" instead of showing a red toast and
 * dropping the user's edit. `mtime` and `size` describe what is there NOW, so
 * the client can say "the file changed at … and is N bytes" without another
 * round trip; both are null when the file is gone (an external delete is a
 * conflict too — saving towards it would recreate a file someone removed).
 */
export interface RemoteWriteConflict {
    mtime: number | null;
    size: number | null;
}
/** Result of one non-interactive command execution. */
export interface RemoteExecResult {
    success: boolean;
    /** Remote exit code, or null when the channel died without one. */
    exitCode: number | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    /** Wall-clock duration of the round trip in ms. */
    durationMs: number;
    /** Connection error message when the command never ran. */
    error?: string | undefined;
}
/**
 * One server-sent event of the streaming exec route.
 *
 * Used by the long network verbs (fetch / pull / push / sync) so the live git
 * output can be shown while the command is still running; the unary exec route
 * keeps serving everything that only needs the result.
 */
export type ExecStreamEvent = {
    t: 'out';
    d: string;
} | {
    t: 'err';
    d: string;
} | {
    t: 'exit';
    success: boolean;
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number;
    error?: string;
};
/** Client -> server terminal frames (JSON text). */
export type TerminalClientFrame = {
    t: 'in';
    d: string;
} | {
    t: 'resize';
    cols: number;
    rows: number;
};
/** Server -> client terminal frames (JSON text). */
export type TerminalServerFrame = {
    t: 'ready';
    id: string;
} | {
    t: 'out';
    d: string;
} | {
    t: 'exit';
    code: number | null;
} | {
    t: 'error';
    message: string;
};
/** Import outcome (ssh_config / dsh-ssh.json). */
export interface ImportReport {
    imported: string[];
    skipped: {
        alias: string;
        reason: string;
    }[];
}
/** One parsed commit for the git graph. */
export interface GitCommit {
    hash: string;
    parents: string[];
    author: string;
    email: string;
    /** Author date, unix seconds. */
    date: number;
    /** Raw ref list, e.g. ["HEAD -> main", "origin/main", "tag: v1.2"]. */
    refs: string[];
    subject: string;
}
/** One changed file in git status. */
export interface GitStatusFile {
    path: string;
    /** Staged (index) status char. */
    staged: string;
    /** Unstaged (worktree) status char. */
    unstaged: string;
}
/** Parsed git status. */
export interface GitStatus {
    branch: string;
    detached: boolean;
    ahead: number;
    behind: number;
    staged: GitStatusFile[];
    unstaged: GitStatusFile[];
    untracked: string[];
    truncated: boolean;
}
/** One local branch. */
export interface GitBranch {
    name: string;
    short: string;
    upstream: string;
    /** True when this is the current HEAD. */
    head: boolean;
    /** True for a remote-tracking branch (`refs/remotes/...`). */
    remote?: boolean;
}
/** One path row of the detailed (NUL-separated) porcelain status. */
export interface GitPathStatus {
    /** Repo-relative path (the destination for renames). */
    path: string;
    /** Staged (index) status column. */
    x: string;
    /** Unstaged (worktree) status column. */
    y: string;
    /** Rename/copy source. */
    origPath?: string;
}
/** Detailed status: every entry plus the ignored half (drives tree greying). */
export interface GitStatusDetail {
    entries: GitPathStatus[];
    /** Ignored paths, as `git status --ignored=matching` reports them. */
    ignored: string[];
    /** True when the byte cap cut the listing short. */
    truncated: boolean;
}
/** One configured remote URL. */
export interface GitRemote {
    name: string;
    url: string;
    kind: 'fetch' | 'push';
}
/** One stash entry. */
export interface GitStash {
    /** `stash@{0}`. */
    ref: string;
    message: string;
    /** Unix seconds. */
    date: number;
}
/** One file row of a commit (`--name-status`). */
export interface GitCommitFile {
    /** Single letter (`R`/`C` for renames/copies); the similarity score is dropped. */
    status: string;
    path: string;
    origPath?: string;
}
/** One hunk of a unified diff, with a ready-to-apply patch body. */
export interface UnifiedHunk {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    /** Text after the `@@` marker. */
    heading: string;
    /** Raw hunk lines (leading ' ', '-', '+', '\'). */
    lines: string[];
    /** File header + hunk header + lines: exactly what `git apply` needs. */
    patch: string;
}
/** One file block of a unified diff. */
export interface UnifiedDiffFile {
    /** Destination path (source path for deletions). */
    path: string;
    oldPath: string;
    status: 'M' | 'A' | 'D' | 'R' | 'C' | 'U';
    binary: boolean;
    hunks: UnifiedHunk[];
}
/** One file the session changed, as the review panel lists it. */
export interface RemoteChangedFile {
    /** Remote absolute POSIX path — the editor opens exactly this. */
    path: string;
    /** Path relative to the session root (what the row shows), '' for an external file. */
    display: string;
    added: number;
    deleted: number;
    /** Git reported the pair as binary (`-` in --numstat). */
    binary?: true;
    /**
     * Too large to compare line by line, so the counts are unknown (0/0).
     *
     * The row still earns its place: time and size proved it moved since the
     * session baseline. Clicking it opens the file, but no hunks can be painted.
     */
    oversized?: true;
    /** Change kind from --name-status; undefined when git gave none. */
    status?: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';
}
/**
 * What one session changed on its remote host since the session's baseline.
 *
 * The baseline is the content of every file git already reported as dirty when
 * the ledger first looked, so the list answers "what did this session touch"
 * rather than "what is uncommitted" — the difference matters when the working
 * tree already carried user edits before the session started.
 */
export interface RemoteChangesSummary {
    /** Remote host alias the session is routed to. */
    alias: string;
    /** Remote absolute root the `display` paths are relative to. */
    root: string;
    /** Highest turn recorded (0 while only the baseline exists). */
    turn: number;
    files: RemoteChangedFile[];
    added: number;
    deleted: number;
    /** Wall-clock ms when this summary was last recomputed. */
    at: number;
    /** More files than the cap: `files` is truncated but the totals are whole. */
    truncated?: true;
    /** A scan is running right now (the slow one counts); the list will refresh. */
    pending: boolean;
    /** Why this session has no ledger (local session, no git, timeout, …). */
    unavailable?: string;
}
/** One file's whole-session comparison, ready for editor decorations. */
export interface RemoteChangesDiff {
    kind: 'text' | 'binary' | 'missing';
    /** Remote absolute POSIX path. */
    path: string;
    display: string;
    /** Text hunks (empty for binary/missing). */
    hunks: UnifiedHunk[];
    /** File status at turn end (A/M/D/…), when git reported one. */
    status?: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';
    /** The diff was cut at the byte cap: `hunks` is a prefix. */
    truncated?: true;
}
/** One row of the side-by-side diff projection. */
export interface DiffRow {
    id: number;
    /** Left (before) text; '' when the row has no left counterpart. */
    old: string;
    /** Right (after) text; '' when the row has no right counterpart. */
    new: string;
    oldNum: number | null;
    newNum: number | null;
    /** False when the row does not exist on the right side at all. */
    inNew: boolean;
    oldDel: boolean;
    newAdd: boolean;
    /** Index into the model's hunk list, or -1 outside every hunk. */
    hunk: number;
}
/** One hunk as the view needs it (numbers + the patch to stage/revert). */
export interface DiffHunkView {
    index: number;
    oldStart: number;
    newStart: number;
    oldCount: number;
    newCount: number;
    heading: string;
    /** Row index of the hunk's first changed line. */
    startRow: number;
    patch: string;
}
/** The full side-by-side model for one file. */
export interface DiffModel {
    rows: DiffRow[];
    hunks: DiffHunkView[];
    /** True when git reported a binary diff (no rows). */
    binary: boolean;
    /** True when the two sides are byte-identical. */
    empty: boolean;
}
/** Commit detail. */
export interface GitShow {
    hash: string;
    subject: string;
    body: string;
    stat: string;
}
/**
 * One request to forward a local TCP port to a target reachable from the
 * remote host — the port panel's manual rule and its one-click "forward this
 * discovered port" button both send exactly this shape.
 *
 * The local listener is ALWAYS bound to 127.0.0.1 (never 0.0.0.0): a forward is
 * `ssh -L`, so anything the user's machine can reach through it is what ssh -L
 * grants — exposing it on the LAN is not part of this feature.
 */
export interface RemoteForwardRequest {
    /** Host alias the tunnel runs through. */
    alias: string;
    /** Target address AS THE REMOTE HOST RESOLVES IT (`127.0.0.1` by default). */
    remoteHost: string;
    /** Target port on that address. */
    remotePort: number;
    /**
     * Requested local port, or 0/omitted to let the OS assign one.
     *
     * The panel asks for 0 by default: picking a fixed port invites EADDRINUSE
     * from whatever else the developer runs locally.
     */
    localPort?: number;
}
/** One live local forward, as the port panel renders it. */
export interface RemoteForwardState {
    /** Stable rule id (`alias|remoteHost|remotePort|localPort-as-requested`). */
    id: string;
    alias: string;
    remoteHost: string;
    remotePort: number;
    /** The port actually bound (resolved when the request asked for 0). */
    localPort: number;
    /** URL to copy / open; loopback HTTP is the overwhelmingly common case. */
    localUrl: string;
    /** `error` means the last connection attempt failed; the listener is alive. */
    state: 'listening' | 'error';
    /** Currently open TCP connections through this rule. */
    connections: number;
    /** Cumulative bytes in each direction (diagnostic, not a quota). */
    bytesIn: number;
    bytesOut: number;
    /** Last connect/bind failure, human-readable. */
    lastError?: string;
    startedAt: number;
}
/** One listening TCP socket on the remote host. */
export interface RemoteListenPort {
    /** Bind address exactly as the remote tool printed it (`0.0.0.0`, `::`, `*`, `127.0.0.1`). */
    addr: string;
    port: number;
    /** Process name when the remote tool revealed it (usually only own processes). */
    process?: string;
}
/**
 * The remote listening-port probe's answer.
 *
 * `tool` says what actually ran: `none` means the host has neither `ss` nor
 * `netstat` (an honest "cannot enumerate", not "no ports"), and `unknown`
 * means the probe did not answer at all. The panel must render those as an
 * explanation, never as an empty list.
 */
export interface RemoteListenPortsResult {
    tool: 'ss' | 'netstat' | 'none' | 'unknown';
    ports: RemoteListenPort[];
    /** Why the probe could not be used, when it could not. */
    error?: string;
}
