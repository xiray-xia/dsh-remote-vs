/**
 * Where a clicked file reference should open when the owning session lives in
 * a remote workspace (pure — no React, no fetch, so the gate can drive it).
 *
 * DSH renders every file reference as a `dsh-resource://file/…` address and
 * opens it through its own right-sidebar preview. That preview resolves the
 * address path against the SESSION WORKSPACE ROOT. A model that quotes a path
 * relative to its CURRENT directory (e.g. `_xfer/reports/x.md` while working
 * in `…/workbase/app-web`) therefore misses by one segment, and a
 * remote session's workspace root only exists as an EMPTY local alias dir —
 * the click dies with the host-side ENOENT the user sees.
 *
 * This module answers "which binding, which remote paths to try" for the
 * client interceptor:
 *  - relative paths are tried against the workspace root first and the
 *    session's current working directory second (the model's usual writing
 *    base), which is what makes the one-segment miss heal;
 *  - absolute spellings (local alias, POSIX remote, drive-qualified alias)
 *    are folded back onto the binding;
 *  - anything that does not name a known binding answers `undefined`, so the
 *    native preview keeps handling local sessions and unknown addresses.
 */
/** One remote binding as the client store exposes it. */
export interface RemoteOpenBinding {
    id: string;
    alias: string;
    /** Absolute POSIX workspace root on the remote host. */
    remotePath: string;
}
/** Client-side binding table (store snapshot projection). */
export interface RemoteOpenBindings {
    bindings: readonly RemoteOpenBinding[];
    /** Binding id -> materialized local alias directory. */
    aliasPaths: Readonly<Record<string, string>>;
}
/** One click resolved to a binding plus the remote paths to try, in order. */
export interface RemoteOpenTarget {
    binding: RemoteOpenBinding;
    candidates: readonly string[];
}
/** Decoded `dsh-resource://file/…` address. */
export type ParsedFileAddress = {
    scope: 'session';
    sessionId: string;
    path: string;
} | {
    scope: 'absolute';
    path: string;
};
/**
 * Decode one file address the way `dsh-util-workspace-path` writes it: the
 * scope names the first segment, `session` carries the id then a path, and
 * `absolute` carries one path. Anything else — another scheme, an unknown
 * scope, bad percent-encoding — answers `undefined` and the caller delegates.
 */
export declare function parseFileAddress(address: string): ParsedFileAddress | undefined;
/**
 * Binding whose local alias directory IS the given workspace path.
 *
 * This is the session→binding gate: the host's `workspaces` list says which
 * workspace a session belongs to, and that workspace path is the alias dir the
 * routing layer materialized for exactly one binding. Exact match, no guessing.
 */
export declare function bindingForWorkspacePath(table: RemoteOpenBindings, workspacePath: string | undefined): RemoteOpenBinding | undefined;
/**
 * The binding that owns one REMOTE path: the alias narrows the host, the remote
 * path decides between the bindings on it.
 *
 * One alias routinely carries SEVERAL bindings (the same host mounted at
 * `/home/user/repo-a/…` and `/home/user/repo-b/…`), so an alias-only match hands
 * back whichever was created first: the editor then opens the file the caller
 * named while the sidebar, the tree and the workspace selector stay on the
 * other workspace. The remote root the caller already holds (`summary.root`, a
 * session cwd) is therefore the deciding evidence — an exact root match wins,
 * then the deepest binding root that contains the file, and only then the
 * alias's first binding (the historical fallback, for a caller that knows
 * nothing but the alias).
 *
 * @param table - client bindings plus their alias directories.
 * @param options.alias - host alias, when known (a hard filter).
 * @param options.remoteRoot - absolute remote workspace root, when known.
 * @param options.filePath - absolute remote file path, when known.
 * @returns the owning binding, or `undefined` when the alias matches nothing.
 */
export declare function bindingForRemoteFile(table: RemoteOpenBindings, options: {
    alias?: string | undefined;
    remoteRoot?: string | undefined;
    filePath?: string | undefined;
}): RemoteOpenBinding | undefined;
/**
 * The binding one change-panel row belongs to.
 *
 * The panel holds the session's own remote root (`summary.root`) and the row's
 * absolute remote path, which is exactly what separates two bindings sharing an
 * alias. Keeping the three-field call in one named function is what the gate
 * drives — the dock is a one-liner around it.
 */
export declare function bindingForChangedFile(table: RemoteOpenBindings, summary: {
    alias: string;
    root: string;
}, filePath: string): RemoteOpenBinding | undefined;
/** Why the workspace selector kept the binding it already had. */
export type WorkspaceFollowHold = 
/** No session is on screen (or the id is empty). */
'no-session'
/** This session was already followed: a later manual pick must stand. */
 | 'already-followed'
/** The session's binding is not resolvable yet (table empty/stale). */
 | 'unresolved';
/** What the workspace selector should do about the session on screen. */
export type WorkspaceFollowDecision = {
    action: 'keep';
    reason: WorkspaceFollowHold;
} | {
    action: 'select';
    bindingId: string;
    followedSession: string;
};
/**
 * Decide whether the sidebar should switch to the binding a session works in.
 *
 * Pure, so the wiring (`selectWorkspace`) stays a one-liner in the store while
 * the policy is drivable by the gate:
 *  - a session is followed ONCE — after that the user's manual pick stands
 *    until another session takes the seat (so the selector never yanks itself
 *    back while the user is browsing another workspace);
 *  - an unresolved binding keeps the CURRENT selection: a session whose
 *    workspace is not in the table yet must not blank the sidebar or move it
 *    somewhere arbitrary.
 *
 * @param options.sessionId - the session on screen, when known.
 * @param options.followedSession - the session already followed, if any.
 * @param options.bindingId - the binding resolved for that session, if any.
 */
export declare function decideWorkspaceFollow(options: {
    sessionId: string | undefined;
    followedSession: string | undefined;
    bindingId: string | undefined;
}): WorkspaceFollowDecision;
/**
 * Resolve the session's binding from whatever the caller knows, then decide.
 *
 * The whole follow policy lives here — the store's `followSessionWorkspace` is
 * a three-line applier around it (`selectWorkspace` + remembering the session),
 * and the gate drives THIS function with stubs, so a policy change cannot pass
 * the gate by being mirrored there.
 *
 * @param options.table - client bindings plus their alias directories.
 * @param options.sessionId - the session on screen, when known.
 * @param options.workspacePath - the session's host workspace path (alias dir).
 * @param options.alias - host alias the session is routed to, when known.
 * @param options.remoteRoot - absolute remote root of the session's workspace.
 * @param options.sessionCwd - the session's CURRENT working directory (either
 *   spelling), when known; it is the last resort, for a caller that holds no
 *   workspace membership at all (the change panel before its first scan).
 * @param options.followedSession - the session already followed, if any.
 */
export declare function planWorkspaceFollow(options: {
    table: RemoteOpenBindings;
    sessionId: string | undefined;
    workspacePath?: string | undefined;
    alias?: string | undefined;
    remoteRoot?: string | undefined;
    sessionCwd?: string | undefined;
    followedSession: string | undefined;
}): WorkspaceFollowDecision;
/**
 * Whether the views' CURRENT selection is the binding resolved for the session
 * being followed.
 *
 * This is the gate the change panel asks before it hands the host a repository
 * sub-directory: that string is stored PER BINDING, so sending the selected
 * workspace's sub-directory while the selection is not (or not yet known to be)
 * the session's own binding describes a repository that does not exist under
 * the session root — which the host answers with `session directory is missing
 * on the host` (exit 90), the panel loses its summary, and the retry loop
 * repeats the same wrong guess forever.
 *
 * Conservative by construction: without a session, without a resolved binding
 * for THAT session, or without a selection, the answer is `false` (so the
 * caller sends nothing and the host falls back to its own probing).
 *
 * @param options.table - client bindings plus their alias directories.
 * @param options.sessionId - the session on screen, when known.
 * @param options.followedSession - the session a binding was resolved for.
 * @param options.followedBindingId - that binding's id.
 * @param options.selectedId - the binding the views are on right now.
 */
export declare function selectionIsSessionBinding(options: {
    table: RemoteOpenBindings;
    sessionId: string | undefined;
    followedSession: string | undefined;
    followedBindingId: string | undefined;
    selectedId: string | undefined;
}): boolean;
/**
 * The binding a session's CURRENT working directory belongs to.
 *
 * `bindingForWorkspacePath` answers only for the workspace path ITSELF (exact
 * alias-dir match). A session cwd is weaker evidence: the model cd'ed into a
 * project sub-directory, and the host commits whichever spelling the session
 * ran in — the local alias (`C:\…\aliases\aliasdir-a\src`) or the REMOTE path
 * (`/srv/repo-a/src`). Both are still inside exactly
 * one binding, so the deepest containing alias dir / remote root decides.
 *
 * No fallback to "the first binding": a cwd that names no known binding answers
 * `undefined`, and the caller then keeps the selection it already had.
 *
 * @param table - client bindings plus their alias directories.
 * @param cwd - the session's working directory, either spelling, when known.
 */
export declare function bindingForSessionCwd(table: RemoteOpenBindings, cwd: string | undefined): RemoteOpenBinding | undefined;
/**
 * Bounded remote search for a clicked path that no candidate resolved.
 *
 * The model's final answer may quote a PROJECT-relative path (`_xfer/reports/
 * r.md`) while its shell `cd` happened INSIDE each command — the session cwd
 * never moved, so no cwd candidate exists. A unique file whose path ENDS with
 * the clicked relative spelling is then the only sane answer; the search is
 * only issued after every direct candidate missed, so the normal click stays
 * one stat call.
 *
 * @param remoteRoot - the binding's absolute remote workspace root.
 * @param relative - the clicked path, slash-separated and workspace-relative.
 * @returns the `find` command line, or `undefined` for an unusable path.
 */
export declare function suffixFindCommand(remoteRoot: string, relative: string): string | undefined;
/** Pick the unique search hit whose path ends with the clicked spelling. */
export declare function uniqueSuffixMatch(remoteRoot: string, relative: string, stdout: string): string | undefined;
/**
 * Resolve one clicked address to a remote binding and its candidate paths.
 *
 * @param address - the clicked `dsh-resource://file/…` address.
 * @param table - client bindings plus their alias directories.
 * @param sessionWorkspacePath - the clicked session's workspace path (the
 *   `workspaces` snapshot's item path); the binding is matched on it.
 * @param sessionCwd - the session's CURRENT working directory when known; it
 *   supplies the second, model-cwd-relative candidate.
 * @returns the binding and ordered remote candidates, or `undefined` when the
 *   click is not a remote-workspace file (the caller keeps the native path).
 */
export declare function resolveRemoteOpenTarget(options: {
    address: string;
    table: RemoteOpenBindings;
    sessionWorkspacePath?: string | undefined;
    sessionCwd?: string | undefined;
}): RemoteOpenTarget | undefined;
