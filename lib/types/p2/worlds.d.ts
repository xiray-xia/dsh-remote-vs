import { Context } from '@deepseek-ai/cordis';
import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { RemoteStore } from '../store.ts';
import type { RemotePool } from '../pool.ts';
import { RpcConnection } from './helper-rpc.ts';
import { SshProcRuntime } from './ssh-proc.ts';
export type RoutingMode = 'off' | 'shadow' | 'enforce';
export type WorldRoute = {
    kind: 'local';
} | {
    kind: 'remote';
    id: string;
    alias: string;
    aliasPath: string;
    remotePath: string;
};
export declare class TombstonedError extends Error {
    readonly aliasPath: string;
    constructor(aliasPath: string);
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        remoteWorlds: RemoteWorlds;
    }
}
export interface WorldsDeps {
    store: RemoteStore;
    pool: RemotePool;
    /** Live kill-switch (volatile config ref). */
    mode: () => RoutingMode;
}
/** True for drive-letter and UNC absolutes (never remote-meaningful). */
export declare function isWindowsAbsolute(path: string): boolean;
export declare class RemoteWorlds {
    private readonly ctx;
    private readonly deps;
    private readonly rpcs;
    private readonly fsViews;
    private readonly fsReady;
    private readonly procs;
    /** Consecutive dial failures per alias; while the cooldown is set, no dial is attempted. */
    private readonly dialFailures;
    constructor(ctx: Context, deps: WorldsDeps);
    get mode(): RoutingMode;
    aliasPathFor(bindingId: string): string;
    /** Compare paths with platform semantics (case-insensitive on Windows). */
    private same;
    /** True when child is at/inside parent (boundary-aware). */
    private contains;
    /** Public containment check for routers (alias mapping without decisions). */
    underAlias(aliasPath: string, path: string): boolean;
    /**
     * Containment that also accepts the directory itself.
     *
     * `contains` excludes equality, so a session whose cwd IS the workspace root
     * matched nothing and fell back to the local world — the same class of miss as
     * the remote-form one below, and just as invisible.
     */
    private containsOrIs;
    /**
     * The remote SPELLING of a binding's directory, e.g. `/opt`.
     *
     * A spawned session can arrive with the remote form instead of the local alias
     * path. `routeDir` then matched nothing and EVERYTHING fell back to the Host —
     * `read`/`write`/`glob`/`grep` and even `subprocess` (which routes on the same
     * `routeDir(cwd)`), so a write to `/tmp/x` silently landed in `C:\tmp\x` and a
     * spawn of `bash` died with ENOENT on Windows. Both spellings have to name the
     * same world.
     *
     * Windows-only on purpose: on a Linux Host a genuinely local `/home/...` would
     * otherwise be mistaken for a binding's remote directory.
     */
    private containsRemote;
    private aliasFor;
    private tombstoneFor;
    /** Route one directory (a session cwd): local, remote, or tombstone-throw. */
    routeDir(dir: string | undefined): WorldRoute;
    /**
     * Route a (path, cwd) pair. Tombstoned cwd throws first (fail-closed dead
     * sessions, regardless of path spelling); otherwise alias-contained paths
     * stay remote (alias dirs are Windows-spelled but remote-meaningful), while
     * other Windows absolutes are local-unambiguous — a non-alias Windows path
     * can never name a remote file, so it routes local even from a remote
     * session (tool seam spillPaths live on the Host by contract and the model
     * reads them back from remote sessions; 2026-10-13). Relative paths and
     * POSIX absolutes follow the session world.
     */
    routePath(path: string, cwd?: string): WorldRoute;
    /** Route by owner session id (spill): unknown sessions stay local. */
    sessionWorld(sessionId: SessionId): WorldRoute;
    /** Map a local alias path to its remote absolute path. */
    toRemotePath(route: Extract<WorldRoute, {
        kind: 'remote';
    }>, localAbsPath: string): string;
    /** True when a remote-spelling path sits at/inside one binding's remote root. */
    private underRemoteBase;
    /**
     * The spelling a remote target has to be COMMITTED as when a session path is
     * derived from it.
     *
     * `workingDirectory.set` stores `fs.processPath(target)` (the working-directory
     * service canonicalizes through it), and the remote fs view answers the remote
     * absolute path. That is the right spelling for display and for remote
     * processes, but it is not always a spelling the router can route BACK: two
     * bindings may share one remote root (two aliases both mounted at `/home`), and
     * `/home` is then deliberately ambiguous and resolves local. A spawned child
     * session inherits exactly that committed spelling — so every subagent of a
     * remote session in one of those workspaces silently ran on the Host (and a
     * re-`ensure()` could not repair it: the restored value is the same `/home`
     * again, so no corrective event is ever appended).
     *
     * The alias spelling is unique per binding by construction, so it is the only
     * spelling that always routes back. Keep the remote spelling wherever it is
     * already unambiguous (every uniquely-mapped workspace stays byte-identical);
     * switch to the alias spelling only where the remote one cannot answer.
     * Paths outside the binding root keep the remote spelling — they name no alias
     * location and are only reached through a session cwd that already routes.
     */
    toSessionPath(route: Extract<WorldRoute, {
        kind: 'remote';
    }>, remoteAbsPath: string): string;
    /** Inverse of {@link toRemotePath}: the alias spelling of a remote path. */
    toAliasPath(route: Extract<WorldRoute, {
        kind: 'remote';
    }>, remoteAbsPath: string): string;
    /**
     * Express a sandbox policy's workspace root in the remote world.
     *
     * The helper validates `workspaceRoot` as an absolute POSIX path
     * (`dsh-ssh/lib/schemas.js`), so anything Windows-spelled has to be converted
     * or the write dies with a zod error that names the field but not the caller's
     * mistake. Three cases, and the last one is why this is a fallback rather than
     * a conditional rewrite:
     *
     * - under the alias directory  -> map through the alias arithmetic
     * - already a remote path      -> use it as-is
     * - anything else (a Windows-spelled root that is neither) -> fall back to the
     *   remote workspace base. Refusing is strictly worse: the operation is legal,
     *   only the policy spelling is not, and `remotePolicy` already fences the same
     *   way for the child's own service policy.
     */
    rewritePolicy<T extends {
        workspaceRoot?: string;
    }>(policy: T | undefined, route: WorldRoute): T | undefined;
    /** Shadow-mode note (remote/tombstone decisions only; locals stay silent). */
    note(route: WorldRoute, what: string): void;
    /** Ensure alias dirs + native registry entries for every binding. */
    syncWorkspaces(): Promise<void>;
    /** Remote $HOME for one host alias (deploy record, else one probe). */
    homeFor(alias: string): Promise<string>;
    /** Best-effort remote mkdir -p (for paths the fs seam cannot create). */
    mkdirRemote(alias: string, dir: string): Promise<void>;
    /** Drop one host's RPC + fs view + proc runtime (call after host update/delete). */
    dropHost(alias: string): Promise<void>;
    dispose(): Promise<void>;
    /** Remote fs view for one host alias (official fs-ssh on our RPC). */
    fsFor(alias: string): Promise<FileSystem>;
    /**
     * Drop one alias's cached fs view. `fsViews` keeps the resolved promise, so
     * leaving that entry in place would hand the next caller the same dead
     * closure. The child fiber owns the fs-ssh instance, so it is torn down
     * best-effort: the connection is already dead, nothing in flight through it
     * can succeed, and a failed teardown must not block the rebuild.
     */
    private evictFsView;
    /** Sync accessor for already-warm views (sync seams only, never creates). */
    cachedFs(alias: string): FileSystem | undefined;
    /** Shared ssh process runtime for one host alias. */
    procFor(alias: string): SshProcRuntime;
    private createFsView;
    /** Shared helper RPC connection for one host alias (auto-deploys). */
    rpcFor(alias: string): Promise<RpcConnection>;
    private dial;
    /** Fail fast while an alias is inside its cooldown; the cooldown never dials. */
    private assertDialAllowed;
    private noteDialFailure;
    private createRpc;
}
