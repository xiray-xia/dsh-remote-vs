import type { Context } from '@deepseek-ai/cordis';
export interface RemoteChatTarget {
    /** The session on screen, or undefined while none is mounted. */
    sessionId: string | undefined;
    /** The canonical host dir of the workspace that session belongs to. */
    sessionWorkspacePath: string | undefined;
}
/** Host-confirmed workspace path for one session (exact membership). */
export declare function workspacePathOf(ctx: Context, sessionId: string): string | undefined;
/**
 * Live chat target for remote reference insertion. Snapshot-cached (stable
 * identity while the values stand) for `useSyncExternalStore`.
 *
 * `ctx` is optional because the shared explorer store boots asynchronously:
 * before it is installed the buttons simply stay disabled.
 */
export declare function useRemoteChatTarget(ctx: Context | undefined): RemoteChatTarget;
