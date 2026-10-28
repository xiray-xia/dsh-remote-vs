import type { GitCommitFile } from '../../protocol.ts';
/** The pane's three views, in strip order. */
export declare const HISTORY_TABS: readonly ["details", "content", "diff"];
export type HistoryTab = (typeof HISTORY_TABS)[number];
/** Guard for persisted values (`localStorage` may hold anything). */
export declare function isHistoryTab(value: unknown): value is HistoryTab;
/**
 * Keyboard navigation for the pane's tab strip: arrows cycle (wrapping, so the
 * last tab's → returns to the first), Home/End jump to the ends. `undefined`
 * means "not a navigation key" and the caller leaves the event alone.
 */
export declare function stepHistoryTab(current: HistoryTab, key: string): HistoryTab | undefined;
/** The state the 差异 tab's lazy read keeps for one commit. */
export interface PatchLoadState {
    key: string;
    text?: string;
    truncated?: boolean;
    error?: string;
}
/**
 * Whether the 差异 tab still has to read the patch for `key`.
 *
 * The subtle case is a SUPERSEDED read: switching the tab or the commit while
 * a read is in flight used to leave the key marker behind with no data, and an
 * equality-only guard (`state.key === key`) then treated that marker as
 * "already loaded" forever — the reported "点击文件后差异一直说没有改动" bug.
 * A marker without text/error therefore means RETRY, never "done".
 */
export declare function needsPatchLoad(state: PatchLoadState, key: string, tab: HistoryTab): boolean;
/** One rendered patch line. */
export interface PatchRow {
    kind: 'context' | 'add' | 'del' | 'skip';
    /** Old-revision line number; null on added lines and skip markers. */
    oldLine: number | null;
    /** New-revision line number; null on deleted lines and skip markers. */
    newLine: number | null;
    /** Line content without the leading ` ` / `+` / `-` marker. */
    text: string;
}
/** One file block of a commit patch. */
export interface CommitPatchFile {
    /** Destination path (the source for deletions). */
    path: string;
    /** Source path when the block is a rename/copy (equals `path` otherwise). */
    oldPath: string;
    status: string;
    binary: boolean;
    added: number;
    deleted: number;
    rows: PatchRow[];
    /** True when the global row cap kept this block's rows (partly) out. */
    truncated: boolean;
}
export interface CommitPatchModel {
    files: CommitPatchFile[];
    added: number;
    deleted: number;
    /** True when the row cap cut the model (later blocks may have no rows). */
    truncated: boolean;
}
/**
 * Rendered-row ceiling for one commit patch.
 *
 * A commit that rewrites a generated file can carry hundreds of thousands of
 * lines; painting them all freezes the sidebar on a click. The header counts
 * stay exact (they come from the parsed hunks, not from the rendered rows), so
 * the truncation notice only claims what is actually missing: the paint.
 */
export declare const PATCH_ROW_CAP = 6000;
/** Build the render model for one commit's `git show --patch` text. */
export declare function buildCommitPatch(text: string, rowCap?: number): CommitPatchModel;
/** The file block a path selects in the diff view (rename-aware). */
export declare function blockForPath(model: CommitPatchModel, path: string): string | undefined;
/**
 * Split one commit patch into its per-file raw texts, in the SAME order
 * `buildCommitPatch` reports the files.
 *
 * Used by "copy this file's patch": the view still holds the original text, so
 * the exact bytes git produced are what lands on the clipboard — no
 * re-serialization from rows, which would drop headers a future git adds.
 */
export declare function splitCommitPatch(text: string): string[];
/** One directory of the 内容 tree ('' = repository root). */
export interface CommitFileGroup {
    dir: string;
    files: GitCommitFile[];
}
/**
 * Group one commit's files by directory for the 内容 tree: a commit touching
 * 40 files in 6 folders is a wall of paths as a flat list, and the folder row
 * is also what lets a reader collapse the part they do not care about.
 * Root-level files come first; every level keeps git's own order by path.
 */
export declare function groupCommitFiles(files: readonly GitCommitFile[]): CommitFileGroup[];
/**
 * The next path in `paths` from `current` (wrapping at both ends), the diff
 * toolbar's prev/next-file math. `current` unknown → the first/last path, so a
 * fresh pane steps into the list instead of doing nothing.
 */
export declare function stepPath(paths: readonly string[], current: string | undefined, direction: 1 | -1): string | undefined;
/**
 * Ref badge decoration for one `%D` entry (shared by the graph rows and the
 * commit card). Split for the same reason the history panel split them: the
 * CSS modifier and the display text are different jobs.
 */
export declare function refBadgeClass(ref: string): string;
/** Display text of one `%D` entry (`HEAD -> main` → `main`, `tag: v1` → `v1`). */
export declare function refBadgeLabel(ref: string): string;
