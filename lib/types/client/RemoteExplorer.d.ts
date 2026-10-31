/**
 * Remote file explorer, VS Code style: per-type icons, git status letters and
 * name tinting, ignored-path greying, right-click file operations, multi
 * select, drag & drop and inline create / rename.
 *
 * The tree stays lazy — one SFTP listing per expanded directory — so git
 * precedence (directory roll-up, ignored inheritance) is computed from the
 * status path set instead of from materialized children; see `scm/status-map`.
 * The `@文件` insertion and the row hover affordance are kept from the
 * previous explorer, and `insertRemoteReference` still writes into the
 * on-screen session's composer draft.
 */
import { type MutableRefObject, type ReactNode } from 'react';
import { type RemoteFileEntry } from '../protocol.ts';
/** True when `path` is `prefix` itself or a descendant of it. */
export declare function pathUnder(path: string, prefix: string): boolean;
/**
 * Where a copy/cut/move of `sourcePath` into `intoDir` lands.
 *
 * `fs-ops`' commands copy/move the entry KEEPING its basename, so the new path
 * is `intoDir/<basename>`; the explorer needs it to re-key its path indexes.
 */
export declare function destinationOfMove(intoDir: string, sourcePath: string): string;
/**
 * Drop every path that is (or lives under) a removed path from a path-keyed set.
 *
 * `expanded` / `selected` / `anchor` are absolute-path indexes. Renaming re-keys
 * them (see `rekeyPaths`), but deleting or moving a subtree used to leave the
 * old paths behind: the root refresh effect then re-listed directories that no
 * longer exist on every revision bump (one failed SFTP request and one error
 * toast each), and `trimListings` protected those dead keys from eviction.
 */
export declare function withoutPaths(set: Set<string>, removed: readonly string[]): Set<string>;
/** Re-key a path-keyed set after a rename/move of `from` to `to`. */
export declare function rekeyPaths(set: Set<string>, from: string, to: string): Set<string>;
/**
 * Drop cached listings for removed paths.
 *
 * Same reason as `withoutPaths`, for the listing cache: a dead key would keep a
 * whole directory's rows in memory forever (plus a requested-but-failing list
 * on every refresh), while `trimListings` still counts it against the 50-entry
 * budget of LIVE directories.
 */
export declare function withoutListingPaths(listings: Record<string, RemoteFileEntry[]>, alias: string, removed: readonly string[]): Record<string, RemoteFileEntry[]>;
/** Re-key cached listings after a rename/move (memo keys are `alias:path`). */
export declare function rekeyListings(listings: Record<string, RemoteFileEntry[]>, alias: string, from: string, to: string): Record<string, RemoteFileEntry[]>;
/**
 * One rendered line of the flattened tree.
 *
 * The tree is rendered as a FLAT pre-order list (not nested components): the
 * rows of a large directory then each own one memoized component whose props are
 * primitives, so a selection change, an upload progress tick or an unrelated
 * store publish only re-renders the rows that actually changed. Nesting the
 * recursion in JSX made every row a child of its parent row, which defeated
 * `memo` (the children element was new on every render).
 */
export type ExplorerRow = {
    kind: 'entry';
    entry: RemoteFileEntry;
    depth: number;
} | {
    kind: 'create';
    dir: string;
    createKind: 'file' | 'folder';
    depth: number;
}
/** An expanded directory whose listing is not available yet (loading/offline). */
 | {
    kind: 'pending';
    dir: string;
    depth: number;
    reason: 'loading' | 'offline';
};
/**
 * What double-clicking a row should open.
 *
 * `undefined` for a directory: `store.openFile()` has no type guard of its own,
 * so handing it a directory path produced an editor tab whose Host read answers
 * `not a file: … is a directory` — and the click also switched the surface to
 * the editor. The guard lives here (and is applied in the row action) so every
 * caller inherits it; the pre-refactor renderer had the same check inline.
 */
export declare function rowOpenTarget(entry: RemoteFileEntry): string | undefined;
/**
 * Flatten the loaded part of the tree into pre-order rows.
 *
 * Pure: the gate drives it with a synthetic `rowsOf`/`isExpanded` pair. The
 * depth of a directory's entries is its own depth + 1 (same indentation the
 * recursive renderer used), and the inline "new file/folder" row is emitted
 * before that directory's children.
 *
 * `placeholderOf` makes an expanded directory with no listing yet emit a
 * `pending` row. Before the flat rewrite the recursive renderer did this for
 * EVERY directory; after it only the root had a placeholder, so expanding a
 * cold (or offline) directory showed nothing until the listing landed.
 */
export declare function buildVisibleRows(input: {
    root: string;
    rowsOf: (dir: string) => RemoteFileEntry[] | undefined;
    isExpanded: (path: string) => boolean;
    creating?: {
        dir: string;
        kind: 'file' | 'folder';
    };
    placeholderOf?: (dir: string) => 'loading' | 'offline' | undefined;
}): ExplorerRow[];
/** Handlers one row needs, held in a ref so a memoized row never re-renders for them. */
export interface ExplorerRowActions {
    select: (entry: RemoteFileEntry, event: React.MouseEvent) => void;
    openFile: (entry: RemoteFileEntry) => void;
    hoverDir: (path: string | undefined) => void;
    openMenu: (event: React.MouseEvent, entry: RemoteFileEntry) => void;
    contextMenu: (event: React.MouseEvent, entry: RemoteFileEntry) => void;
    startDrag: (entry: RemoteFileEntry) => void;
    dragOver: (entry: RemoteFileEntry, event: React.DragEvent) => void;
    dragLeave: (entry: RemoteFileEntry) => void;
    dropOn: (entry: RemoteFileEntry, event: React.DragEvent) => void;
    commitRename: (entry: RemoteFileEntry, name: string) => void;
    cancelRename: () => void;
    reference: (entry: RemoteFileEntry) => void;
}
interface ExplorerRowProps {
    entry: RemoteFileEntry;
    depth: number;
    status: string | undefined;
    ignored: boolean;
    isSelected: boolean;
    isOpen: boolean;
    isCut: boolean;
    isDropTarget: boolean;
    isRenaming: boolean;
    chatEnabled: boolean;
    /** Precomputed so `t` (whose identity may change with a store publish) is not a prop. */
    referenceTitle: string;
    symlinkTitle: string;
    actions: MutableRefObject<ExplorerRowActions>;
}
/**
 * One tree row.
 *
 * Memoized on primitive props: the parent re-renders on every store publish and
 * on each upload-progress tick, and without this every one of those re-rendered
 * the whole expanded tree (a 20 000-entry directory means 20 000 rows).
 */
export declare const ExplorerRowView: import("react").NamedExoticComponent<ExplorerRowProps>;
export declare function RemoteExplorer(props: {
    showHidden: boolean;
    onToggleHidden: () => void;
    visible: boolean;
}): ReactNode;
export {};
