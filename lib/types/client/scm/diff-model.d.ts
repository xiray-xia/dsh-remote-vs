import type { DiffModel } from '../../protocol.ts';
/** One `@@`-parsed line pair, before projection onto the full files. */
interface Pair {
    old: string;
    new: string;
    oldNum: number | null;
    newNum: number | null;
}
/** Parse the unified diff body into old/new line pairs (git's pairing). */
export declare function parsePairs(diff: string): Pair[];
export interface DiffInput {
    /** The unified diff text (`git diff ... -- <path>`). */
    diff: string;
    /** Left side (HEAD or index blob; '' for a new file). */
    oldText: string;
    /** Right side (index blob or worktree; '' for a deleted file). */
    newText: string;
}
/**
 * Build the render model. `rows` always covers both files completely, so a
 * one-line change in a 3000-line file still renders 3000 aligned rows.
 */
export declare function buildDiffModel(input: DiffInput): DiffModel;
/** Added / removed line counts for the diff toolbar. */
export declare function diffCounts(model: DiffModel): {
    added: number;
    removed: number;
};
export {};
