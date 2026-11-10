/**
 * Coloured file-type / folder icons for the remote DIRECTORY TREE
 * (`RemoteExplorer`), so a remote folder looks like the local sidebar's folder.
 *
 * Scope: the tree only. Search hits, SCM rows, commit panes and download rows
 * keep the neutral outline glyphs from `kit.tsx` — this set is deliberately not
 * the fallback of `FileIcon` / `FolderIcon`.
 *
 * Provenance
 * ----------
 * These are a straight port of the icon set the local sidebar plugin draws
 * (`FileTypeIcon` and its amber folder icon): one paper sheet whose colour and
 * bottom-right mark carry the type — TS blue + `<>`, JS yellow + `<>`, Python
 * blue with a yellow mark, Markdown blue + lines, images purple + a mountain,
 * archives yellow + a zip, `.gitignore` orange + a commit graph.
 *
 * The copy exists on purpose: the client bundle may not import another plugin's
 * values (tsdown's purity gate rejects cross-plugin imports), and that plugin
 * publishes no `fileIcon` / `folderIcon` service that `kit.tsx` could call.
 * `kit.tsx` still prefers such a service if a host ever provides one (the
 * better-sidebar contract is where it would come from); this set is the
 * fallback that paints a real, typed tree whenever that plugin is present.
 *
 * One deliberate difference from the source: the image mark used
 * `fill="currentColor"`, which in a tree inherits the row's dim text colour —
 * `.rvs-node-icon` sets `color: var(--rvs-fg3)` — so the mountain would render
 * grey on the purple sheet. Here the mark group pins `color` to the type colour
 * and the artwork stays the colour the palette intends.
 */
import type { ReactNode } from 'react';
/** The bottom-right mark that carries the category (drawn in the type colour). */
type FileMark = 'code' | 'markup' | 'style' | 'data' | 'doc' | 'image' | 'archive' | 'shell' | 'config' | 'git' | 'lock' | 'box' | 'table';
/** How one file type looks: sheet colour + category mark + optional mark colour. */
export interface FileLook {
    color: string;
    mark: FileMark;
    /** Mark colour; defaults to the sheet colour (Python = blue sheet + yellow mark). */
    markColor?: string;
}
/**
 * The extension / exact-name tables, exposed read-only for the gate's full-table
 * snapshot: one changed hex or mark must turn `scripts/check-file-icons.mjs`
 * red, instead of shipping a silently different palette.
 *
 * `baseName` stays private on purpose — `kit.tsx` already exports a `baseName`
 * with different semantics (POSIX only, strips a trailing slash), and exporting
 * both invites the wrong import.
 */
export declare const FILE_TYPE_LOOKS: Readonly<Record<string, FileLook>>;
export declare const FILE_NAME_LOOKS: Readonly<Record<string, FileLook>>;
/** Resolve a path's look from its name / extension. */
export declare function lookOf(path: string): FileLook;
/** Props for {@link FileTypeIcon} / {@link FolderGlyph}. */
export interface FileIconProps {
    /** Workspace-relative path (any separator); only the basename is read. */
    path: string;
    /** Edge length in px, default 16. */
    size?: number;
    className?: string;
}
/**
 * Coloured file-type icon: sheet + top-right fold + bottom-right category mark.
 *
 * At 16 px this reads better than two-letter badges and does not depend on font
 * rendering.
 */
export declare function FileTypeIcon(props: FileIconProps): ReactNode;
/** Every extension the file-type icon recognises (reporting / gate). */
export declare const FILE_TYPE_EXTENSIONS: readonly string[];
/** Props for the amber folder glyph. */
export interface FolderGlyphProps {
    /** Expanded: the front flap drops down and reveals the inner sheet (VSCode-like). */
    open?: boolean;
    /** Edge length in px, default 16. */
    size?: number;
    className?: string;
}
/**
 * Amber folder icon. The folder colour is content colour, in the same scheme as
 * the file types — it does not follow the skin.
 */
export declare function FolderGlyph(props: FolderGlyphProps): ReactNode;
export {};
