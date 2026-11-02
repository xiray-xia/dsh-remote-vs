/**
 * Ctrl+P quick open: the portal modal, its list and its keyboard handling.
 *
 * Mounted by `RemoteRoot` only while it is open, so unmounting IS closing (no
 * "is it visible" state to keep in sync), and it reads the same store the tree
 * does: opening a hit is one `store.openFile()`, which makes a quick-open file
 * indistinguishable from one opened in the tree — including cross-workspace
 * binding resolution and the "already open → activate" rule.
 *
 * The index, scoring and the remote command live in `quickopen-model.ts` (pure, and
 * covered by `scripts/check-quickopen.mjs`); this file owns pixels, focus and
 * keys only.
 */
import { type ReactNode } from 'react';
export declare function QuickOpen(props: {
    onClose: () => void;
}): ReactNode;
