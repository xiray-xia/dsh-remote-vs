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
export declare function SearchView(): ReactNode;
