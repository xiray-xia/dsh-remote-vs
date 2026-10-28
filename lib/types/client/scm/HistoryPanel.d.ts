/**
 * History view: the commit graph with branch lanes and merge curves (lane
 * layout ported from the previous Git view), plus click-to-expand changed
 * files and a per-file diff of that commit.
 *
 * Loading is a SINGLE capped call (`api.git.log(..., GIT_LOG_MAX)`); a deep
 * repository shows the newest GIT_LOG_MAX commits and is filtered client-side.
 * The docstring here used to promise scroll-triggered paging that does not
 * exist, which is worse than no comment: a reader trusts it.
 *
 * Each repository's last answer is kept in memory (`./panel-cache.ts`), so a
 * switch back to a workspace repaints its commit list at once and the log is
 * re-read behind it — the tab used to blank on every switch, and worse, kept the
 * PREVIOUS repository's rows until the new log arrived.
 */
import { type ReactNode } from 'react';
export declare function HistoryPanel(): ReactNode;
