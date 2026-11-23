/**
 * Breadcrumb above the editor in the full-width (conversation view) variant.
 *
 * Every path segment is clickable and opens a VS Code-style sibling picker: a
 * directory segment lists itself, the file segment lists its parent directory,
 * so "open the file next to this one" costs one click instead of a trip to the
 * tree (whose expansion state lives in another view and cannot be expressed in
 * a URL).
 *
 * Read-only: it only calls `fileOp.list` on the remote. The remote path is the
 * Host's own business — no second validation layer here.
 */
import { type ReactNode } from 'react';
/** Props of {@link Breadcrumb}. */
export interface BreadcrumbProps {
    /** i18n lookup (falls back to inline copy when a key is missing). */
    t: (key: string) => string;
    /** SSH host alias the workspace lives on (the file route's first argument). */
    alias: string;
    /** Remote workspace root, absolute. */
    root: string;
    /** Display name of the workspace root. */
    rootName: string;
    /** Absolute path of the file on screen. */
    path: string;
    /** Open one remote file in the editor. */
    onOpen: (fullPath: string) => void;
}
/** Breadcrumb: path segments + sibling dropdown. */
export declare function Breadcrumb(props: BreadcrumbProps): ReactNode;
