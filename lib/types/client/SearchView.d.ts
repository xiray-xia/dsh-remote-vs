/**
 * Search panel: one view, two modes.
 *
 *  - **文件名** — a remote `find -iname` (depth- and count-capped).
 *  - **内容** — a recursive remote `grep` with the VS Code option set
 *    (Aa / ab_ / .*), a scope field ("in folder"), and results grouped per
 *    file; clicking a hit opens the file at that line.
 *
 * The explorer's context menu raises a scoped request through the shared
 * store (`requestSearch`), which is what makes "Find in Folder…" work from the
 * tree without the two views knowing about each other.
 */
import { type ReactNode } from 'react';
import type { RemoteExecResult } from '../protocol.ts';
/**
 * Whether a scope still belongs to the workspace root it was entered under.
 *
 * The scope is an ABSOLUTE remote directory, so a workspace switch leaves it
 * pointing at a tree the new host may not have: the next search would run
 * `find`/`grep` in the OLD workspace's path against the NEW alias (wrong or
 * empty results, and an error that names no cause). Callers reset the scope when
 * this answers false.
 */
export declare function scopeBelongsToRoot(scope: string, root: string): boolean;
/**
 * Which "truncated"/"lines clipped" banners may be shown RIGHT NOW.
 *
 * Both flags describe one answered search, so a banner left over from a cleared
 * query, from the other mode, or from the previous workspace is a claim about a
 * result the panel is no longer showing. Pure so the gate can pin the rules.
 */
export declare function visibleSearchBanners(input: {
    mode: 'name' | 'content';
    ran: boolean;
    nameTruncated: boolean;
    contentTruncated: boolean;
    linesClipped: boolean;
}): {
    nameTruncated: boolean;
    contentTruncated: boolean;
    linesClipped: boolean;
};
/** First non-empty warning line from a finished search, or undefined. */
export declare function stderrWarning(stderr: string, maxChars?: number): string | undefined;
/**
 * What clicking one NAME result should do.
 *
 * `find` can report a DIRECTORY, and `store.openFile()` has no type guard: a
 * click used to hand the directory path to the editor (the Host answered
 * "not a file: … is a directory" and the surface was switched for nothing).
 */
export declare function nameHitAction(hit: {
    isDir: boolean;
}): 'reveal' | 'open';
/** True when a rejection is a user cancel (not a failure to report). */
export declare function isSearchCancellation(error: unknown, signal: AbortSignal | undefined): boolean;
/**
 * One content search over the STREAMING exec route.
 *
 * `api.exec` cannot be cancelled: a replaced query left the remote `grep`
 * running for its whole 120 s budget while the client ignored the answer.
 * `execStream` carries an AbortSignal and the Host kills the remote process
 * group when the response closes, so a cancelled search really stops. The
 * route forwards output as SSE frames instead of `stdout`/`stderr`, so they are
 * accumulated here and handed to the same parser as before. A Host without the
 * route (404/405) is remembered and served by `api.exec` from then on.
 */
export declare function runContentSearch(alias: string, command: string, signal: AbortSignal): Promise<RemoteExecResult>;
export declare function SearchView(): ReactNode;
