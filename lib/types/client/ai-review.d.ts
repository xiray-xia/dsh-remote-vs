/** Largest complete diff we inline into the prompt, in BYTES (≈8–10k tokens). */
export declare const AI_REVIEW_MAX_BYTES: number;
/** How many `@@` headers a summary prompt enumerates before it stops. */
export declare const AI_REVIEW_MAX_HUNKS = 40;
/** How much of the diff the prompt carries. */
export type ReviewMode = 'full' | 'summary' | 'pathOnly';
/** Which revision range the diff describes (the SCM view's three diff tabs). */
export type ReviewScope = 'worktree' | 'staged' | 'commit';
/** Prompt language. Follows the UI language (`store.lang`), no separate setting. */
export type ReviewLang = 'zh' | 'en';
/** Everything the prompt template needs, all of it already in the caller's hands. */
export interface ReviewPromptInput {
    /** SSH host alias the diff was read from (named in the prompt, no secrets). */
    alias: string;
    /** Repository root on that host (absolute POSIX path). */
    root: string;
    /** Repository-relative path of the file. */
    rel: string;
    /** Absolute remote path of the file. */
    fullPath: string;
    scope: ReviewScope;
    /** The commit the diff was drilled down from, for `scope: 'commit'`. */
    commitRef?: string;
    /** Unified diff text (`tab.diff.diff`), possibly empty for untracked/binary. */
    diff: string;
    mode: ReviewMode;
    /** The diff is a `GIT_CAP`-capped PREFIX (the host truncated it silently). */
    capped: boolean;
    lang: ReviewLang;
}
/** UTF-8 byte length — the unit `head -c` and therefore `GIT_CAP` count. */
export declare function diffByteLength(diff: string): number;
/**
 * Which revision range a diff tab shows.
 *
 * `ref` wins over `staged`, and that order is load-bearing: a commit drill-down
 * tab is BOTH `staged: true` and `ref: hash` (`store.openCommitFile`), so asking
 * `staged` first would label a commit's diff as "staged changes" and point the
 * model at the index instead of the commit.
 */
export declare function reviewScopeOf(staged: boolean, ref: string | undefined): ReviewScope;
/**
 * Which prompt shape this diff gets.
 *
 * Order matters. `pathOnly` answers "there is no diff text at all" (untracked /
 * binary / failed read) and outranks the rest because it needs no budget.
 * `capped` outranks the size test: a 1 KiB prefix of a 2 MB patch is not a
 * small diff, it is a CUT one. Only a complete, small diff earns `full`.
 */
export declare function pickReviewMode(input: {
    bytes: number;
    hasDiff: boolean;
    capped: boolean;
}): ReviewMode;
/** Longest unbroken run of backticks in `text` (0 when there is none). */
export declare function longestBacktickRun(text: string): number;
/**
 * A code fence `diff` itself cannot close: one backtick longer than the longest
 * run inside it, never shorter than the usual three.
 */
export declare function diffFence(diff: string): string;
/**
 * The `@@ … @@` hunk headers of a unified diff, in order.
 *
 * A line starting with `@@` can only be a header: every content line of a
 * unified diff begins with ' ', '+' or '-', and the file-level lines begin with
 * `diff --git`, `index`, `---`, `+++`, `new file` or `deleted file`.
 */
export declare function hunkHeaders(diff: string): string[];
/**
 * The prompt that goes into the composer draft.
 *
 * `mode` is what the caller decided (see {@link pickReviewMode}), but an empty
 * diff is normalized to `pathOnly` here as well: an empty file is not an empty
 * CHANGE, and an empty fenced block would answer the wrong question.
 */
export declare function buildReviewPrompt(input: ReviewPromptInput): string;
/** How many changed files a commit prompt enumerates before it stops. */
export declare const AI_REVIEW_MAX_FILES = 100;
/** One `git show --name-status` row, as the prompt needs it. */
export interface CommitFileLike {
    /** Single letter (`R`/`C` for renames/copies). */
    status: string;
    path: string;
    /** Rename/copy source. */
    origPath?: string;
}
/** Everything a whole-commit prompt needs — all of it already on the history pane. */
export interface CommitReviewInput {
    /** SSH host alias the commit was read from (named, no secrets). */
    alias: string;
    /** Repository root on that host (absolute POSIX path). */
    root: string;
    hash: string;
    subject: string;
    /** Message body below the subject ('' when there is none). */
    body: string;
    /** Files the commit touched (`git show --name-status`); empty when unread. */
    files: readonly CommitFileLike[];
    /** Raw `git show --patch` text ('' when the commit has no textual diff). */
    patch: string;
    mode: ReviewMode;
    /** The patch is a `GIT_CAP`-capped PREFIX (`loadCommitPatch.truncated`). */
    capped: boolean;
    lang: ReviewLang;
}
/**
 * The prompt for reviewing a WHOLE commit from the history pane (F6 v2).
 *
 * Same byte discipline as the single-file prompt (a capped `git show --patch`
 * must never be presented as the complete change), but the shape differs: a
 * commit is a set of files, so the facts list the files and the model is told
 * how to fetch the patch. `mode` is what the caller decided; an empty patch is
 * normalized to `pathOnly` here as well.
 */
export declare function buildCommitReviewPrompt(input: CommitReviewInput): string;
