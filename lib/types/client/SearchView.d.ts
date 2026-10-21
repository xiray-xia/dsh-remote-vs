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
export declare function SearchView(): ReactNode;
