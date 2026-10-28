/**
 * History view: the commit graph with branch lanes and merge curves (lane
 * layout ported from the previous Git view), plus a COMMIT PANE below it —
 * the selected commit's 提交详情 / 内容 / 差异 tabs (see `./CommitPane.tsx`).
 *
 * The pane replaced the old per-row inline expansion: a commit is a subject
 * with three answers, not a disclosure widget, and the pane keeps the graph
 * readable while one commit is open. Clicking a row selects (the pane opens on
 * 提交详情), clicking a changed file shows its patch in 差异, and a commit's
 * per-file two-sided diff still opens in the editor through `openCommitFile`.
 *
 * Loading is a SINGLE capped call (`api.git.log(..., GIT_LOG_MAX)`); a deep
 * repository shows the newest GIT_LOG_MAX commits and is filtered client-side.
 *
 * Each repository's last answer is kept in memory (`./panel-cache.ts`), so a
 * switch back to a workspace repaints its commit list at once and the log is
 * re-read behind it — the tab used to blank on every switch, and worse, kept the
 * PREVIOUS repository's rows until the new log arrived.
 *
 * Per-commit reads are cached separately (message + files, and the lazy patch),
 * keyed by repository AND hash, so switching repositories can never show one
 * host's commit body under another host's graph.
 */
import { type ReactNode } from 'react';
export declare function HistoryPanel(): ReactNode;
