/**
 * Pure parsing/formatting for `git blame` (and the shared vocabulary the
 * editor UI uses for a line's provenance). No CodeMirror and no DOM here, so
 * the gate can feed it real porcelain output.
 */
import type { GitCommit } from '../protocol.ts';
/** One blamed line: 1-based final line number plus the commit that owns it. */
export interface BlameLine {
    line: number;
    hash: string;
    author: string;
    email: string;
    /** Author timestamp, seconds since the epoch (git's `author-time`). */
    time: number;
    summary: string;
}
/** A run of consecutive lines owned by the same commit. */
export interface BlameRun {
    from: number;
    to: number;
    hash: string;
}
/** One `--follow` file-history row, plus the name the file had in that commit. */
export interface FileHistoryCommit extends GitCommit {
    /** Path to show/diff for THIS commit (old name before a rename). */
    path: string;
    /** Rename source when this commit renamed the file. */
    origPath?: string;
}
/**
 * Parse `git blame --line-porcelain`.
 *
 * `--line-porcelain` repeats the commit header and metadata for every line (no
 * previous-commit grouping), which keeps this parser stateless: a header starts
 * a record, the metadata lines fill it, and the tab-prefixed content line ends
 * it. Lines that do not match the shape are ignored rather than aborting the
 * whole read — a partially understood blame is still useful.
 */
export declare function parseBlamePorcelain(stdout: string): BlameLine[];
/** Group consecutive lines of one commit; non-adjacent runs stay separate. */
export declare function blameRuns(rows: readonly BlameLine[]): BlameRun[];
/** Short author name for the narrow blame gutter. */
export declare function shortAuthor(author: string): string;
/**
 * Relative age labels, deliberately compact (`now`, `5m`, `3h`, `2d`, `4w`,
 * `3mo`, `2y`) because this text lives in a gutter.
 */
export declare function relativeBlameTime(timeSeconds: number, nowSeconds?: number): string;
/** One-line gutter label: author initials/name plus relative age. */
export declare function blameLabel(row: BlameLine, nowSeconds?: number): string;
/**
 * Hover text: full attribution. The browser renders `title` as plain text, so
 * no markup is needed (and no translator dependency leaks into the model).
 */
export declare function blameTitle(row: BlameLine): string;
/** False for git's all-zero "not committed yet" pseudo-commit. */
export declare function isCommittedBlame(hash: string): boolean;
/**
 * The next `-L` window to request, or undefined when the viewport is covered.
 *
 * Pure and exported so the gate can prove the "3000-line file only asks for
 * the visible window" requirement without a browser. `overscan` keeps a small
 * buffer above/below so a normal scroll does not immediately need a new call.
 */
export declare function planBlameWindow(first: number, last: number, total: number, covered: ReadonlySet<number>, overscan?: number): {
    from: number;
    to: number;
} | undefined;
/**
 * Parse `git log --follow --name-status -M` output into per-commit rows.
 *
 * `--follow` reports the file under its name AT THAT COMMIT. Starting from the
 * current name and walking newest→oldest, each rename row supplies the next
 * (older) name, so a click on an old history row opens the right path instead
 * of an empty diff for the current name.
 */
export declare function parseFileHistory(stdout: string, currentPath: string): FileHistoryCommit[];
