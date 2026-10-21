/**
 * Pure status model: buckets the detailed porcelain status into the SCM
 * sections and derives the per-path / per-directory marks the file tree
 * paints.
 *
 * Directory marks come from the STATUS PATH SET, never from materialized
 * children: the remote tree is lazy (one SFTP listing per expanded folder),
 * so a collapsed folder holding changes must still light up. Ignored state is
 * inherited downward, because `git status --ignored=matching` reports an
 * ignored directory once, unexpanded.
 */
import type { GitStatusDetail } from '../../protocol.ts';
/** One changed path as the SCM panel shows it. */
export interface ChangeEntry {
    path: string;
    /** Single letter (`M`, `A`, `D`, `R`, `C`, `U`, `T`, `?`). */
    status: string;
    /** Rename/copy source. */
    oldPath?: string;
    /** True when this entry belongs to the staged (index) half. */
    staged: boolean;
}
/** The SCM sections: conflicts, changes (unstaged + untracked), staged. */
export interface StatusBuckets {
    conflicts: ChangeEntry[];
    changes: ChangeEntry[];
    staged: ChangeEntry[];
    untracked: ChangeEntry[];
    ignored: string[];
    /** Badge count: staged + unstaged + untracked (conflicts excluded). */
    total: number;
}
/** True for a merge-conflict pair (UU/AA/DD/AU/UA/DU/UD). */
export declare function isConflictStatus(x: string, y: string): boolean;
/** Bucket the detailed status into the panel's sections. */
export declare function bucketStatus(detail: GitStatusDetail): StatusBuckets;
/**
 * Whether one porcelain record counts as STAGED for the panel.
 *
 * Mirrors `bucketStatus` exactly, because a verification that disagreed with
 * the list would "correct" a change the user can see was applied: an untracked
 * record is not in the index at all, and a conflict pair lives in its own
 * section (never in "staged changes").
 */
export declare function isStagedStatus(x: string, y: string): boolean;
/**
 * The verb one row's action button issues.
 *
 * The button is the OPPOSITE of the section the row sits in: a row in "staged
 * changes" offers unstage, a row in "changes" offers stage. This exists because
 * the two are trivially confusable — the row already KNOWS which section it is
 * in (`isStaged`), and passing that flag straight through as the verb's target
 * inverts the action, which is silent: the optimistic model has nothing to move
 * (`git add` on an already-staged path, `git restore --staged` on an unstaged
 * one), the probe agrees with the row it never changed, so the click reports
 * neither success nor failure. That is exactly what shipped in 0.8.0 for both
 * directions (stage was a no-op AND unstage was a no-op) while the section-level
 * buttons, which pass a literal, stayed correct.
 *
 * A named verb instead of a boolean, so the call site reads as the action rather
 * than as a state (`applyStage(paths, rowVerb(isStaged))`).
 */
export declare function rowVerb(isStaged: boolean): 'stage' | 'unstage';
/**
 * The staged-ness of one path in a PATH-LIMITED status probe
 * (`git status --porcelain -z -uno -- <paths>`).
 *
 * The probe runs with `--untracked-files=no`, so a path that is not in the
 * index has no record at all: absence means "not staged" (measured against
 * real git — untracked → no record, staged → `A `/`M `).
 *
 * A trailing slash is an untracked DIRECTORY row (`-u normal` reports the
 * directory once): `git add -- dir/` puts every file inside into the index and
 * the probe then reports those files individually, never `dir/` itself — so a
 * directory path is answered by prefix (also measured).
 */
export declare function stagedStateOf(detail: GitStatusDetail, path: string): boolean;
/**
 * The local (optimistic) projection of one stage/unstage: what the detailed
 * status looks like the moment the user clicks, before the host answers.
 *
 * The transform mirrors what git does to the two halves of a porcelain record
 * (`git add` clears the worktree half, `git restore --staged` clears the index
 * half) and was checked against real git for the cases that are not obvious:
 *   - staging an untracked path (`??`) makes it `A `;
 *   - unstaging a staged NEW file returns it to `??` (untracked rows are listed
 *     under "changes", so the record stays in the model);
 *   - unstaging a staged RENAME leaves HEAD's path deleted in the INDEX — the
 *     old path becomes `D ` and the new one untracked (measured, not assumed);
 *   - staging a conflict resolves it into the index.
 *
 * Pure, so the panel's instant feedback is assertable without a host: the
 * caller decides WHEN to apply it (and when to apply the inverse).
 *
 * @param detail - the status the panel is showing.
 * @param paths - repo-relative paths that were just staged/unstaged.
 * @param staged - true for a stage, false for an unstage.
 * @returns the projected status (the same object when no path matched).
 */
export declare function optimisticStageDetail(detail: GitStatusDetail, paths: readonly string[], staged: boolean): GitStatusDetail;
/**
 * Add a path the detailed status does not list yet as a STAGED ADDITION.
 *
 * The panel can stage a file that its own status call never reported: a file
 * inside an expanded untracked DIRECTORY (`-u normal` collapses the directory
 * into one `dir/` row, so the file has no record of its own). Without this the
 * row would simply vanish — staged, yet shown nowhere until the next full
 * refresh. A path that already has a record is left alone.
 *
 * @param detail - the status the panel is showing.
 * @param path - repo-relative path that was just staged.
 * @returns the status with the added record (the same object when it is known).
 */
export declare function insertStagedEntry(detail: GitStatusDetail, path: string): GitStatusDetail;
/** One local stage/unstage result a full status read may not have seen. */
export interface StageOverride {
    staged: boolean;
    /** Monotonic sequence number of the local change. */
    at: number;
}
/**
 * Re-apply the local stage results a FULL status read could not have seen.
 *
 * Skipping the repository-wide refresh after a stage is what makes the click
 * instant, but another verb (a save, a discard, a commit) can still have a full
 * `git status` in flight — and on a large repository that read started minutes
 * ago. Landing it as-is would flip the row the user just staged back into
 * "changes", i.e. the panel would contradict itself for as long as it takes to
 * run the next full read. A read that STARTED before a local change cannot have
 * seen it, so those paths keep the local value; a read that started after them
 * is authoritative and prunes them.
 *
 * @param detail - the freshly read status.
 * @param overrides - repo-relative path → local stage result (one repository).
 * @param startedAt - the sequence number when the read was issued.
 * @returns the detail with the newer local results re-applied.
 */
export declare function applyStageOverrides(detail: GitStatusDetail, overrides: ReadonlyMap<string, StageOverride>, startedAt: number): GitStatusDetail;
/** Per-path marks the tree paints: file letter, directory roll-up, ignored. */
export interface TreeMarks {
    /** Repo-relative path → single status letter (`M`, `A`, `D`, `U`, `?`). */
    files: Map<string, string>;
    /** Repo-relative directory → `M` when any descendant changed. */
    dirs: Map<string, string>;
    /** Repo-relative paths (files and directories) git ignores. */
    ignored: Set<string>;
    /** Directory prefixes implied by the ignored set, for deep paths. */
    ignoredDirs: Set<string>;
}
/**
 * Build tree marks from the detailed status.
 *
 * `buckets` may be supplied when the caller has already bucketed the same
 * status. The marks need the same four lists, and recomputing them meant every
 * store publish walked the whole change list twice.
 */
export declare function buildTreeMarks(detail: GitStatusDetail, buckets?: StatusBuckets): TreeMarks;
