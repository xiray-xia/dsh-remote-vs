/**
 * Line-level diff for the session change ledger.
 *
 * The recorder gets *content* (see `status.ts`) and needs the same thing git
 * would have printed with `-U3`: hunks a reviewer can read, counts for the file
 * list, and a patch that can undo the change. Doing it here, on the host side,
 * means a file's before/after text is compared without another round trip to
 * the remote — and without teaching git about the session baseline.
 *
 * No dependency, no IO, on purpose. The algorithm is Myers' greedy edit script
 * (the one git's own xdiff implements): common prefix and suffix are stripped
 * first, then the middle is diffed, so the cost follows the size of the edit
 * rather than the size of the file.
 *
 * Line conventions, chosen to match `git diff` byte for byte:
 *
 * - a final `\n` does not produce an extra empty line;
 * - `\r` stays inside the line, so a CRLF file keeps its `\r` and a CRLF/LF
 *   mismatch shows up as changed lines instead of a phantom whole-file edit;
 * - a file that does not end in `\n` keeps its last line, and the hunk is
 *   flagged `oldNoEol` / `newNoEol` so {@link hunkPatch} can emit git's
 *   `\ No newline at end of file` marker — without it `git apply -R` refuses to
 *   touch such a file.
 */
/** One unified-diff hunk. Line numbers are 1-based, like git's. */
export interface TextHunk {
    /** First old-side line in the hunk; 0 when the hunk only adds lines. */
    oldStart: number;
    /** Number of old-side lines the hunk covers (context + removed). */
    oldLines: number;
    /** First new-side line in the hunk; 0 when the hunk only removes lines. */
    newStart: number;
    /** Number of new-side lines the hunk covers (context + added). */
    newLines: number;
    /**
     * Lines with their leading `' '`, `'-'` or `'+'`, and without the trailing
     * `\n` — the shape the client's diff view already consumes.
     */
    lines: string[];
    /** The hunk reaches the end of `before`, which does not end in a newline. */
    oldNoEol?: true;
    /** The hunk reaches the end of `after`, which does not end in a newline. */
    newNoEol?: true;
}
/** A whole text comparison: hunks plus the counts the file list shows. */
export interface TextDiff {
    hunks: TextHunk[];
    /** `'+'` lines, counted from {@link hunks} so the two can never disagree. */
    added: number;
    /** `'-'` lines, counted from {@link hunks}. */
    deleted: number;
}
/** Compare two texts into git-shaped hunks (default 3 lines of context). */
export declare function diffText(before: string, after: string, context?: number): TextDiff;
/**
 * Serialize one hunk as a patch `git apply` accepts (and `git apply -R` undoes).
 *
 * The `@@ -a,b +c,d @@` counts are always written out — git accepts the elided
 * `,1` and `,-0` spellings, but a reviewer reading a log is better served by the
 * explicit form, and one spelling means one code path to test.
 *
 * @param displayPath - repo-relative path, as the panel shows it.
 * @param hunk - one hunk of {@link diffText}.
 */
export declare function hunkPatch(displayPath: string, hunk: TextHunk): string;
