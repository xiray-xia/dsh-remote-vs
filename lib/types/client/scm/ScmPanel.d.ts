/**
 * Source control panel: commit box, changes (unstaged + untracked), staged
 * changes, stash stack, and the repository block (branch, ahead/behind, sync,
 * branches and remotes).
 *
 * All verbs go to the remote host through `scm/actions`; destructive ones
 * (discard, delete branch, drop stash, push) raise the themed confirm first,
 * and every successful write refreshes the shared status so the tree markers
 * and the change list never disagree.
 */
import { type ReactNode } from 'react';
export declare function ScmPanel(props: {
    onOpenHistory: () => void;
    visible: boolean;
}): ReactNode;
