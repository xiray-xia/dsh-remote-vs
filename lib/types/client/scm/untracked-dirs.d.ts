/**
 * Untracked DIRECTORY rows, expanded in place.
 *
 * `git status -u normal` — the panel's performance mode — reports an untracked
 * directory as ONE row (`dir/`), so the files inside it are invisible. Clicking
 * that row runs a pathspec-limited `git status -uall -- dir/` (cost bounded by
 * the directory, never the repository) and the rows it answers with are shown
 * under the directory row. This module is the pure state half — expand,
 * collapse, prune and the row projection; the probe itself lives in
 * `scm/actions.ts` and the command in `git-ops.ts`.
 *
 * Rows keep their FULL repo-relative paths (`dir/sub/b.txt`), exactly like every
 * other row in the panel: nesting is then a matter of indentation, and a row can
 * never be ambiguous when two directories hold the same file name.
 */
import type { GitPathStatus, GitStatusDetail } from '../../protocol.ts';
import { type ChangeEntry } from './status-map.ts';
/** Expanded directory rows: directory path (`dir/`) → the rows under it. */
export type DirExpansions = ReadonlyMap<string, readonly ChangeEntry[]>;
/** True when a status record is an untracked DIRECTORY row (`?? dir/`). */
export declare function isUntrackedDirRow(entry: GitPathStatus): boolean;
/**
 * One probe record as the row the panel shows.
 *
 * Same precedence as `bucketStatus` (an untracked record is a `?` row, a
 * conflict is `U`, an index half wins over the worktree half) but ONE row per
 * path, in the order git answered — the expansion is a list under a parent row,
 * not the two-section view.
 */
export declare function childRows(detail: GitStatusDetail): ChangeEntry[];
/**
 * Expand one directory row from a probe answer.
 *
 * @param current - the expansions in force.
 * @param dirPath - the directory row that was clicked (`dir/`).
 * @param stdout - the raw `-z` stdout of `statusDirCommand` for that directory.
 * @returns a new map (the same one when the path is unusable).
 */
export declare function expandDir(current: DirExpansions, dirPath: string, stdout: string): DirExpansions;
/**
 * Collapse one directory row.
 *
 * @returns a new map, or the same one when nothing was expanded for that path.
 */
export declare function collapseDir(current: DirExpansions, dirPath: string): DirExpansions;
/**
 * Drop rows that are no longer untracked from the expansions.
 *
 * A path that was just STAGED stops being an untracked row: it must leave the
 * expansion (it now lives under "staged changes"), and a directory that was
 * staged itself takes its whole expansion with it. Without this the same file
 * would be listed twice — once as `??` under its directory and once as `A `.
 *
 * @param current - the expansions in force.
 * @param paths - repo-relative paths that were just staged.
 * @returns a new map, or the same one when nothing matched.
 */
export declare function dropExpandedRows(current: DirExpansions, paths: readonly string[]): DirExpansions;
/**
 * Drop the expansions whose directory row is gone from the status.
 *
 * This is what keeps an expansion honest across a full refresh: it survives
 * while git still reports the same untracked directory row, and disappears the
 * moment that row does — staged, deleted, or simply no longer untracked. It is
 * applied to EVERY status the panel adopts (a refresh, or a local stage), so a
 * stale expansion can never outlive the row it hangs from.
 *
 * @param current - the expansions in force.
 * @param detail - the status the panel is about to show.
 * @returns a new map, or the same one when every expansion still applies.
 */
export declare function pruneDirExpansions(current: DirExpansions, detail: GitStatusDetail): DirExpansions;
