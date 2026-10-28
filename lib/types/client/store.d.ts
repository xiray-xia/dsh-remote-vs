import type { Context } from '@deepseek-ai/cordis';
import type { DiffModel, GitStatusDetail, RemoteHostSummary, RemoteRoutingStatus, RemoteWorkspaceBinding } from '../protocol.ts';
import type { ChangeMark, ChangeSet } from './vsc/change-marks.ts';
import { type StatusBuckets, type TreeMarks } from './scm/status-map.ts';
import { type DiffPayload } from './scm/actions.ts';
import { type DirExpansions } from './scm/untracked-dirs.ts';
import { type Lang } from './i18n.ts';
import { type EditorSurface } from './float-editor.ts';
/** One editor tab (code file, preview or diff). */
export interface EditorTab {
    id: string;
    kind: 'file' | 'diff';
    /** Absolute remote path. */
    fullPath: string;
    /** Path relative to the workspace root (what the UI shows). */
    rel: string;
    loading: boolean;
    error: string | undefined;
    /** File payload. */
    text: string;
    /**
     * The text as last LOADED from / SAVED to the remote file.
     *
     * `text` is the live-buffer handoff copy (see `captureLiveBuffer`) and may
     * therefore hold unsaved edits; this is the disk-side reference the editor
     * uses as its dirty baseline. Without the split, a remount with the handoff
     * text would label unsaved edits "clean" (dirty dot off, Save disabled, close
     * guard silent) — the exact silent-loss path the handoff exists to avoid.
     */
    baseline?: string;
    dirty: boolean;
    saving: boolean;
    binary: boolean;
    truncated: boolean;
    image: boolean;
    markdown: boolean;
    html: boolean;
    /** Preview vs source for markdown/html. */
    preview: boolean;
    /** Staged side for a diff. */
    staged: boolean;
    /** Untracked files diff against an empty left side. */
    untracked: boolean;
    /** Set for a commit drill-down: the diff compares `ref^` with `ref`. */
    ref?: string;
    /** 1-based line to reveal after load (a content-search hit). */
    line?: number;
    /**
     * Bumped on every reveal request. The line number alone cannot re-trigger a
     * jump to the line the caret is already on.
     */
    lineNonce?: number;
    /**
     * 「本会话改了什么」的行标记（来自会话改动数据层，见 `vsc/change-marks.ts`）。
     * `undefined` = 这个 tab 根本没有改动数据（编辑器连 gutter 都不会多装一栏）。
     */
    changeSet?: ChangeSet | null;
    /** 最近一次跳到的改动点在 `changeSet.hunks` 里的下标（0-based）；`<0` = 还没跳过。 */
    activeHunk?: number;
    /** 编辑器报告文档已与 `changeSet` 脱钩（用户敲过字），上层该重新拉数据。 */
    changeStale?: boolean;
    /** 改动点跳转目标行（1-based）。与 `line` 分开，两条跳转链路互不干扰。 */
    revealHunkLine?: number;
    /** 改动点跳转的 nonce，语义同 `lineNonce`。 */
    revealHunkNonce?: number;
    /**
     * 重读（`reloadTab`）成功后递增的 nonce。
     *
     * 它存在的唯一理由：`CodeEditor` 的 `initial` **只在挂载时读一次**，所以
     * "远端内容变了" 必须靠**重挂**才能进到编辑器缓冲区（详见 `reloadTab` 的注释）。
     * `EditorPane` 把它拼进 `key`，这里的每次递增就是一次重挂。
     */
    reloadNonce?: number;
    diff: DiffPayload | undefined;
    model: DiffModel | undefined;
    view: 'split' | 'before' | 'after';
}
export interface HeadInfo {
    branch: string;
    detached: boolean;
    ahead: number;
    behind: number;
}
/** The sidebar rail destinations. */
export type RailView = 'explorer' | 'search' | 'scm' | 'history' | 'editor' | 'terminal' | 'workspaces';
/** One "search this folder" request coming from the tree. */
export interface SearchRequest {
    /** Monotonic id so a repeated request still re-triggers the view. */
    id: number;
    mode: 'name' | 'content';
    /** Pre-filled query (usually empty). */
    query: string;
    /** Absolute remote directory the search is scoped to. */
    scope: string;
}
/** One "show this folder in the explorer tree" request. */
export interface RevealRequest {
    /** Monotonic id so asking for the same folder twice still re-triggers. */
    id: number;
    /** Absolute remote DIRECTORY to expand and scroll to. */
    path: string;
}
/** One "open a terminal here" request. */
export interface TerminalRequest {
    /** Monotonic id so the same folder can be opened twice. */
    id: number;
    /**
     * Host alias the directory lives on.
     *
     * Carried explicitly, and NOT taken from the terminal panel's own last-used
     * host: the panel remembers whatever host the user ran a shell on last, so a
     * menu action on a workspace bound elsewhere opened the shell on the WRONG
     * machine — the `cd` then failed with "No such file or directory" for a path
     * that exists perfectly well on its own host.
     */
    alias: string;
    /** Absolute remote directory the fresh shell should `cd` into. */
    dir: string;
}
/** Stored repository sub-directory for one binding ('' = the workspace root). */
export declare function readRepoSubdir(workspaceId: string): string;
/** Everything a view can read, plus the actions. */
export interface ExplorerValue {
    ctx: Context | undefined;
    t: (key: string) => string;
    lang: Lang;
    ready: boolean;
    error: string | undefined;
    hosts: RemoteHostSummary[];
    workspaces: RemoteWorkspaceBinding[];
    routing: RemoteRoutingStatus;
    workspaceId: string;
    workspace: RemoteWorkspaceBinding | undefined;
    /** Binding id → materialized local alias dir (the session↔binding gate). */
    aliasPaths: Record<string, string>;
    alias: string;
    /** Remote workspace root (absolute). */
    root: string;
    /** Enclosing git repository root, when the binding is inside one. */
    repoRoot: string | undefined;
    /** Workspace-relative directory git runs in ('' = the workspace root). */
    repoSubdir: string;
    /** Absolute directory git runs in (workspace root + repoSubdir). */
    repoWorkdir: string;
    repoMissing: boolean;
    status: GitStatusDetail | undefined;
    buckets: StatusBuckets;
    marks: TreeMarks;
    head: HeadInfo | undefined;
    gitBusy: boolean;
    gitError: string | undefined;
    /** The painted git slice is a cached one; a background refresh is running. */
    gitCached: boolean;
    /** Effective per-git-command budget (ms), for the loading hint. */
    gitDeadlineMs: number;
    tabs: EditorTab[];
    activeTab: EditorTab | undefined;
    activeTabId: string | undefined;
    revision: number;
    /** Effective editor mount: the floating window wins over the base surface. */
    editorSurface: EditorSurface;
    floatOpen: boolean;
    floatAvailable: boolean;
    view: RailView;
    searchRequest: SearchRequest | undefined;
    /** Pending "show this folder in the tree" request (consumed by the explorer). */
    revealRequest: RevealRequest | undefined;
    /** Pending "open a terminal here" request (consumed by the terminal panel). */
    terminalRequest: TerminalRequest | undefined;
    setView: (view: RailView) => void;
    /** Switch to the search panel (optionally scoped to a folder) — the tree's
        "find in folder" entry point. */
    requestSearch: (request: {
        mode: 'name' | 'content';
        query?: string;
        scope: string;
    }) => void;
    /**
     * Show one remote directory in the explorer: switch to it, expand the folder
     * and its ancestors, then scroll its row into view. Raised by the search
     * results' "open containing folder" entry.
     */
    revealInExplorer: (dir: string) => void;
    /**
     * Open a fresh terminal tab whose shell `cd`s into `dir`. Raised by the
     * search results' "open in terminal" entry.
     */
    openTerminalAt: (dir: string) => void;
    /**
     * The USER's pick — the workspace dropdowns and the wizard's "open files".
     *
     * Only this entry point records a choice: it is what lets a pending follow
     * know the user has taken over. Switches the plugin makes on its own (opening
     * a file that lives in another binding, the follow itself) go through the
     * store's internal auto path instead and never claim to be a choice.
     */
    selectWorkspace: (id: string) => void;
    /** Point git at a directory inside the workspace (repositories often live in
        a subdirectory of the binding rather than at its root). */
    setRepoSubdir: (subdir: string) => Promise<void>;
    /** Repositories found under the workspace root, as workspace-relative dirs. */
    discoverRepos: () => Promise<string[]>;
    refreshAll: () => void;
    /**
     * Re-read git for the binding on screen.
     *
     * `join` shares a read that is already in flight — the right contract for an
     * automatic refresh, since a second walk of the same repository answers
     * exactly the same question. `fresh` (the default) waits for a running read
     * and then reads again: the answer must include whatever the caller just
     * wrote.
     */
    refreshGit: (mode?: 'join' | 'fresh') => Promise<void>;
    afterWrite: () => Promise<void>;
    /**
     * Stage / unstage paths: the row moves at once, and ONE path-limited status
     * confirms it (no repository-wide status, no extras — see `stageOptimistic`).
     */
    stageOptimistic: (paths: readonly string[], staged: boolean) => Promise<void>;
    /** Expanded untracked directory rows: directory path → the rows under it. */
    untrackedDirs: DirExpansions;
    /** Expand / collapse one untracked directory row (one path-limited status). */
    toggleUntrackedDir: (dirPath: string) => Promise<void>;
    openFile: (fullPath: string, options?: {
        line?: number;
    }) => void;
    /**
     * 「在悬浮编辑器中打开」：把编辑器整体浮出，再打开这个文件。
     *
     * 先捕获当前编辑器缓冲区再切表面（见 `captureLiveBuffer`）：主界面里没保存
     * 的编辑不会因为这次切换丢掉。
     */
    openInFloatEditor: (fullPath: string, options?: {
        line?: number;
    }) => void;
    /** 同上，只是打开的是工作区 diff（SCM 更改列表的悬浮入口）。 */
    openDiffInFloatEditor: (rel: string, staged: boolean, untracked?: boolean) => void;
    /** 把当前编辑器整体浮出（双击会话视图的「远程编辑器」标签）。 */
    openFloatingEditor: () => void;
    /** 停靠回主界面（底层的中心视图或侧栏表面）。 */
    dockFloatingEditor: () => void;
    openDiff: (rel: string, staged: boolean, untracked?: boolean) => void;
    openCommitFile: (hash: string, rel: string) => void;
    activateTab: (id: string) => void;
    closeTab: (id: string) => void;
    updateTab: (id: string, patch: Partial<EditorTab>) => void;
    /** 换一份会话改动标记（`activeHunk` 归零）。 */
    applyChangeSet: (tabId: string, set: ChangeSet | null) => void;
    /** 上一个 / 下一个改动点（绕回），返回目标行号并驱动编辑器跳过去。 */
    gotoChange: (tabId: string, dir: 1 | -1) => number | undefined;
    /** 编辑器报告文档已脱钩：标记作废，等上层重新拉数据。 */
    markChangeStale: (tabId: string) => void;
    /**
     * 撤销本会话在某个文件里的一处改动（悬浮按钮那一动作；`mark` 来自
     * `changeSet.marks`，`hunk` 是 `patches` 的下标）。
     */
    undoChange: (tabId: string, mark: ChangeMark) => Promise<void>;
    /**
     * Write one file tab back to the remote host.
     * @returns true only when the write really succeeded — the caller uses it to
     *   advance the editor's dirty baseline (see `CodeEditorHandle.markSaved`).
     */
    saveTab: (id: string, content: string) => Promise<boolean>;
    reloadTab: (id: string) => Promise<void>;
    info: (text: string) => void;
    fail: (text: string) => void;
}
/** Subscribe to the explorer store. */
export declare function useExplorer(): ExplorerValue;
/** The repo-relative path of an absolute remote path ('' when outside). */
export declare function repoRelative(repoRoot: string | undefined, fullPath: string): string;
/** Install the context and load hosts/workspaces once per page. */
export declare function bootstrap(ctx: Context): void;
/** Reload hosts + workspace bindings and the routing status. */
export declare function refreshAll(): void;
/** Switch the sidebar panel (persisted across reloads). */
export declare function setView(view: RailView): void;
/** One-shot request from the explorer: "search this folder". */
export declare function requestSearch(request: {
    mode: 'name' | 'content';
    query?: string;
    scope: string;
}): void;
/**
 * Show one remote directory in the explorer.
 *
 * Two stages, because the tree is lazily loaded: this raises the request and
 * switches the panel, and the explorer itself expands the ancestors (loading
 * each level) and scrolls the row into view — it is the only place that knows
 * which directories are currently expanded.
 *
 * @param dir - absolute remote DIRECTORY (a file's parent for a file hit).
 */
export declare function revealInExplorer(dir: string): void;
/**
 * Open a fresh terminal tab whose shell lands in `dir` — on the CURRENT
 * workspace's host.
 *
 * The terminal panel consumes the request (it owns the tabs) and the shell gets
 * a quoted `cd` once its PTY reports ready — the host's terminal route has no
 * "start in this directory" parameter, so a typed command is the honest way.
 *
 * The alias travels IN the request. The panel otherwise opens new tabs on the
 * host it last used, which put the shell on a different machine than the path
 * belongs to and made the `cd` fail with "No such file or directory".
 *
 * @param dir - absolute remote directory.
 */
export declare function openTerminalAt(dir: string): void;
/**
 * Select the binding every view works against — the USER's choice.
 *
 * This is the entry point the snapshot hands to the views (`ExplorerValue.
 * selectWorkspace`), so every dropdown and the workspace wizard land here. It
 * records the pick for the session on screen, which is what stops a follow that
 * has not resolved yet from undoing it.
 */
export declare function selectWorkspace(id: string): void;
/**
 * Register the session every follow call is about.
 *
 * Called by the surfaces that know which session is on screen. Clearing it is a
 * real state — "no session on screen" — and every consumer then answers "not
 * this session" instead of guessing.
 */
export declare function setFollowSession(sessionId: string | undefined): void;
/**
 * Point the workspace selector (and with it the tree, the editor's dropdown and
 * the git panel) at the binding the registered session works in.
 *
 * The user's complaint this exists for: opening a session in one remote
 * workspace showed the sidebar on another — the selector kept whatever
 * localStorage held (or the FIRST binding, on a fresh profile), and a click in
 * the change panel matched its binding by alias alone, which is ambiguous as
 * soon as one host carries two workspaces under one alias).
 *
 * Resolution order, strongest evidence first (all of it inside
 * `planWorkspaceFollow`, so the policy has exactly one home):
 *  1. `workspacePath` — the host's own workspace membership for the session,
 *     which IS the alias dir of exactly one binding;
 *  2. `alias` + `remoteRoot` — what the change panel holds once it has a
 *     summary (`bindingForRemoteFile`), which disambiguates by REMOTE path;
 *  3. the session's own cwd, asked of the host (`api.sessionCwd`) — the only
 *     source available BEFORE the panel's first successful scan, which is
 *     precisely the state that used to send a foreign repository directory.
 *
 * Idempotent and re-entrant by construction:
 *  - once the session has been followed, later calls answer the recorded
 *    binding without touching the network, so a manual pick stands;
 *  - a pick the USER made before anything resolved stands just the same (see
 *    `manualPickSession`), so the retry can never undo an explicit choice;
 *  - while a resolution is in flight, concurrent callers share that one
 *    promise (the sidebar and the panel both trigger this);
 *  - an answer that arrives after the session changed is discarded.
 *
 * Called with no evidence at all it does nothing rather than guessing: an
 * unknown session must never move the selection, and must never fall back to
 * "the first binding".
 *
 * @returns the binding id that was selected, or `undefined` when nothing moved.
 */
export declare function followSessionWorkspace(options?: {
    /** The session the caller's evidence belongs to; defaults to the registered one. */
    sessionId?: string | undefined;
    /** The session's host workspace path (the local alias dir), when known. */
    workspacePath?: string | undefined;
    /** Host alias the session is routed to, when known. */
    alias?: string | undefined;
    /** Absolute remote root of the session's workspace, when known. */
    remoteRoot?: string | undefined;
}): Promise<string | undefined>;
/**
 * Whether the views' CURRENT selection is the binding resolved for the followed
 * session. `false` whenever that cannot be proven (no session, nothing resolved
 * yet, or a manual pick moved the selection elsewhere) — see
 * `selectionIsSessionBinding`, which owns the comparison.
 */
export declare function workspaceMatchesSession(): boolean;
/**
 * The repository sub-directory to hand the host for one session, or `''` when
 * the selection cannot be proven to be that session's binding.
 *
 * `''` is not "no answer": it tells the host to use the SESSION ROOT (and its
 * own unique-candidate probe), which is the only correct instruction when the
 * caller cannot name the session's repository. Sending the selected binding's
 * directory instead is what produced the reported loop — the host ran `cd` on
 * `session root + another workspace's subdir`, answered `session directory is
 * missing on the host` (exit 90), the panel lost its summary and asked again
 * three seconds later, forever.
 *
 * @param sessionId - the session the caller is about to ask the host about.
 *   Omitted, the registered session is used; given, a registration that is
 *   about a DIFFERENT session answers `''` — a panel listing one conversation
 *   must never describe another one's repository.
 */
export declare function sessionRepoSubdir(sessionId?: string | undefined): string;
/** The binding id the views are on (the dropdown/tree's answer), plain read. */
export declare function selectedWorkspaceId(): string;
/**
 * Point git at a directory inside the workspace. Repositories often live in a
 * sub-directory of the binding (`/srv/app` holding `/srv/app/web/.git`), and
 * git only answers for the directory it is run in, so the choice is persisted
 * per binding and re-resolved on every refresh.
 */
export declare function setRepoSubdir(subdir: string): Promise<void>;
/** Repositories found under the workspace root (workspace-relative, root first). */
export declare function discoverRepos(): Promise<string[]>;
/**
 * Re-read git for the binding on screen.
 *
 * Reads go through `scm/read-queue.ts`, keyed by (binding, repository directory):
 * `join` shares a read that is already in flight — an automatic refresh has no
 * reason to duplicate a walk — while `fresh` waits for it and then reads again,
 * because the caller just wrote something and the answer must include it. Either
 * mode never runs two walks of the same repository at once, which is what lets a
 * background refresh and the ⟳ button coexist instead of racing.
 *
 * The answer is cached under the key the read STARTED with (even when the user
 * has already switched away: the walk is paid for either way, and the cache is
 * what makes the next visit instant) and repaints only while it is still that
 * binding's latest read.
 *
 * @param mode - `fresh` (default) never reuses a read that started before the
 *   call; `join` shares a running one (workspace switches, bootstrap).
 */
export declare function refreshGit(mode?: 'join' | 'fresh'): Promise<void>;
/** Refresh everything a working-tree change can invalidate. */
export declare function afterWrite(): Promise<void>;
/** The repository the SCM panel is pointed at, or undefined when none. */
export declare function scmTarget(): {
    alias: string;
    root: string;
} | undefined;
/**
 * Move paths between the index and the worktree halves of the LOCAL status
 * model — the optimistic update, its rollback, and the correction the probe
 * asks for all land here.
 *
 * Pure model work: no command is issued, nothing but `status` is republished,
 * and the explorer's revision is left alone (staging does not change the remote
 * tree, so re-listing directories over SFTP would be pure waste). The paths are
 * also remembered so a full status read that started BEFORE this change cannot
 * undo it (see `applyStageOverrides`).
 */
export declare function applyLocalStage(paths: readonly string[], staged: boolean): void;
/**
 * Stage / unstage paths with instant local feedback and ONE cheap check.
 *
 * The reported problem: `+` on one file in a large repository fired four
 * repository-wide git commands (the `git add`, a full `git status`, and the
 * three extras loaders), so the click cost minutes and locked the panel. Here
 * the row moves immediately in the local model, the real verb goes out at once,
 * and a single path-limited `git status -- <paths>` (cost independent of the
 * repository size) confirms it — rolling the row back and telling the user when
 * the repository disagrees.
 *
 * Resolves when the verification is in; rejects when the git verb itself failed
 * (the caller reports that error).
 */
export declare function stageOptimistic(paths: readonly string[], staged: boolean): Promise<void>;
/**
 * Expand or collapse one untracked DIRECTORY row.
 *
 * `-u normal` collapses an untracked directory into a single `dir/` row, so its
 * contents are invisible. Expanding costs exactly ONE path-limited
 * `git status -uall -- <dir>/` — never a repository-wide status, never the
 * extras — and the rows it answers with are shown under the directory row.
 * Collapsing costs nothing at all.
 *
 * The expansions are pruned against every status the panel adopts, so a
 * directory that gets staged or deleted takes its rows with it (see
 * `scm/untracked-dirs.ts`).
 *
 * @param dirPath - the directory row's repo-relative path (with its `/`).
 */
export declare function toggleUntrackedDir(dirPath: string): Promise<void>;
/** Open (or focus) a remote file in the editor tab strip. */
export declare function openFile(fullPath: string, options?: {
    line?: number;
}): void;
/**
 * Binding table for the click interceptor (`remote-file-open.ts`).
 *
 * A plain snapshot read, not a hook: the interceptor runs inside a service
 * method call (no React render), so it needs the current bindings and alias
 * directories synchronously. Unknown/empty state answers empty tables.
 */
export declare function remoteOpenBindings(): {
    bindings: RemoteWorkspaceBinding[];
    aliasPaths: Record<string, string>;
};
/**
 * Open one file that belongs to a SPECIFIC remote binding (the click
 * interceptor already resolved it), switching the explorer's selected
 * workspace when the on-screen one differs.
 *
 * @returns true when the file was handed to the editor; false when the binding
 *   is unknown (the caller then keeps the native preview).
 */
export declare function openRemoteFileInBinding(bindingId: string, remotePath: string, options?: {
    line?: number;
}): boolean;
/**
 * Whether the plugin's own rich editor is the place a remote file click should
 * land (the click interceptor's gate, see `remote-file-open.ts`).
 *
 * The centre conversation view is the normal case; while the editor floats it
 * is the floating window instead — the file still belongs in OUR editor, not in
 * the host's native preview. On the sidebar-fallback layout (`sidebar`) the
 * interceptor stays off, exactly as before this feature.
 */
export declare function isEditorTakeoverActive(): boolean;
/** Open (or focus) a working-tree diff of one repository path. */
export declare function openDiff(rel: string, staged: boolean, untracked?: boolean): void;
/** Open (or focus) one file of one commit (`ref^` against `ref`). */
export declare function openCommitFile(hash: string, rel: string): void;
export declare function activateTab(id: string): void;
export declare function closeTab(id: string): void;
export declare function updateTab(id: string, next: Partial<EditorTab>): void;
/** Write one tab back to the remote host. @returns true when the write landed. */
export declare function saveTab(id: string, content: string): Promise<boolean>;
/**
 * Re-read one tab (file content or diff payload).
 *
 * A FILE tab's content has to reach the mounted editor through a REMOUNT, which
 * is why the nonce below exists: `CodeEditor` reads its `initial` prop once, on
 * mount (`key` = tab identity), so patching `tab.text` alone leaves the live
 * buffer on the OLD bytes — the screen would show content the remote file no
 * longer has, and the next Ctrl+S would write those stale bytes back, silently
 * undoing whatever changed the file (a hover-revert, a discard, another tool).
 * `EditorPane` folds `reloadNonce` into the editor's `key`; bumping it here is
 * what makes the re-read visible, and the remount restores scroll + caret from
 * the per-tab view state (see `.spike/viewstate-check.mjs`).
 *
 * ORDER IS LOAD-BEARING: text and `dirty` are patched FIRST, the nonce SECOND.
 * The remount reads `initial` from the tab, so a nonce bump that raced ahead of
 * the new text would mount the editor on the old content — exactly the bug this
 * is fixing, only harder to see.
 */
export declare function reloadTab(id: string): Promise<void>;
/** Note where the editor pane is mounted (set by the client entry). */
export declare function setEditorSurface(surface: 'center' | 'sidebar'): void;
/**
 * Record that the host's frame-wide overlay slot actually rendered the
 * floating window host (see `FloatingEditorWindow`).
 *
 * This is a runtime handshake, not a configuration flag: on a host whose
 * `shell.overlay` slot is missing, the entry never mounts and the menu entries
 * stay disabled instead of opening a surface that cannot paint.
 */
export declare function setFloatEditorAvailable(available: boolean): void;
/**
 * Float the editor in its current state, without opening anything.
 *
 * The entry is a double-click on the shell's 「远程编辑器」 tab (see
 * `float-tab-trigger.ts`): the user is already looking at the editor and wants
 * it out of the layout — no file, no diff, same tabs and buffers.
 *
 * Idempotent: while the editor already floats this does nothing (the window is
 * on screen; a second trigger must not restart it).
 */
export declare function openFloatingEditor(): void;
/**
 * Open one file in the floating editor (file-tree / search / SCM menu action).
 *
 * Order matters twice:
 *   1. the live buffer is captured BEFORE the surface flips (the flip unmounts
 *      the editor that owns it);
 *   2. a second capture runs even when already floating, because opening
 *      another file is a tab switch — the very action that remounts the editor
 *      and would otherwise drop the edits typed in the tab being left.
 * A host whose overlay slot is unavailable gets the file in the normal surface
 * instead (with the reason toasted), so the click is never a dead end.
 */
export declare function openInFloatEditor(fullPath: string, options?: {
    line?: number;
}): void;
/**
 * The floating variant of `openDiff` — the SCM change list's entry.
 *
 * Same handoff order as `openInFloatEditor`; a diff tab has no text buffer of
 * its own, but the file editor that WAS on screen still does.
 */
export declare function openDiffInFloatEditor(rel: string, staged: boolean, untracked?: boolean): void;
/**
 * Dock the editor back onto its base surface (centre conversation view or the
 * sidebar fallback), carrying the live buffer with it.
 */
export declare function dockFloatingEditor(): void;
/**
 * 换一份「本会话改了什么」的标记。
 *
 * `activeHunk` 归零是刻意的：数据换了一份，上一份里"跳到第 3 处"的下标没有任何
 * 意义。0 表示"当前停在第 1 处"（打开这个文件的调用方本来就会把 caret 放到
 * `hunks[0]`），所以紧接着按"下一个"会走到第 2 处，不会把第 1 处跳过。
 */
export declare function applyChangeSet(tabId: string, set: ChangeSet | null): void;
/**
 * 在改动点之间前后移动（到头绕回），返回目标行号（1-based）。
 *
 * `activeHunk` 是 `changeSet.hunks` 的 **0-based 下标**，`<0` / 缺省表示"这批数据
 * 里还没跳过"：第一次向后跳落在第 1 处、向前跳落在最后一处 —— 用户按下快捷键期
 * 待的是"带我去看改动"，而不是"从第 1 处跳到第 2 处、把第 1 处跳过"。
 *
 * 跳转目标顺手写进 tab（`revealHunkLine` + 递增的 `revealHunkNonce`），编辑器通过
 * props 收到后自己选中并滚动；调用方（面板按钮、键盘）只需要调这一个函数。这与
 * 面板里内联的那套步进算法是同一套下标语义，两边混用也不会错位。
 */
export declare function gotoChange(tabId: string, dir: 1 | -1): number | undefined;
/**
 * 编辑器报告"文档已经和改动数据脱钩"（用户敲了字）。
 *
 * 只打标记、不做别的：标记本身已在编辑器内部被清空（见 `change-marks.ts`），
 * 重新拉数据是上层的事，仓库在这一层不发起任何请求。
 */
export declare function markChangeStale(tabId: string): void;
export declare function undoChange(tabId: string, mark: ChangeMark): Promise<void>;
/** Mount-time hook: boot the store for a given ctx. */
export declare function useBootstrap(ctx: Context): void;
