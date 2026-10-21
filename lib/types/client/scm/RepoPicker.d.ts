/**
 * Repository directory picker (SCM): a workspace binding is often a container
 * (`/srv/sites`) while the repository sits one or more levels below it
 * (`/srv/sites/shop/.git`). Git only answers for the directory it runs in, so
 * this dialog browses the REMOTE tree under the workspace root and reports, per
 * directory, which repository it would resolve to before the user commits.
 *
 * Three ways in, because they cover different situations:
 *  - the discovered-repository list (one `find` under the workspace root, max
 *    depth 3) for the common case,
 *  - drilling through directories (dirs only, `..` included),
 *  - typing or pasting a path (relative or absolute inside the workspace) when
 *    the tree is deep.
 */
import { type ReactNode } from 'react';
export declare function RepoPicker(props: {
    alias: string;
    /** Absolute workspace root (the tree the picker may browse). */
    root: string;
    /** Currently selected workspace-relative directory ('' = the root). */
    current: string;
    onPick: (subdir: string) => void;
    onClose: () => void;
}): ReactNode;
