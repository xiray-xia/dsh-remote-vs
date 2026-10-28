/**
 * The VS Code-style widget kit shared by every new surface: icons, the
 * file-kind helpers, the themed context menu, and the modal/toast layer that
 * replaces `window.confirm` / `window.prompt` (the reference implementation
 * ships the same split, and the confirm dialogs are what guard destructive
 * remote git verbs).
 *
 * Icon sourcing: when dsh-better-sidebar is installed its service answers
 * `fileIcon` / `folderIcon`, which run the host's own classifier and any
 * user-registered icon theme — the remote tree then matches the user's local
 * sidebar glyph for glyph. Without that service the built-in SVG set below
 * takes over, so the native fallback surface still renders a real tree.
 */
import { type ReactNode } from 'react';
type IconProps = {
    size?: number;
    className?: string;
};
export declare function IconChevronRight(props: IconProps): ReactNode;
/** Mirror of {@link IconChevronRight}, for the commit pane's "previous file". */
export declare function IconChevronLeft(props: IconProps): ReactNode;
/** Expand: two arrows pushing the corners apart (the pane's full-height toggle). */
export declare function IconExpand(props: IconProps): ReactNode;
/** Restore: the same two arrows pulling the corners back in. */
export declare function IconCollapse(props: IconProps): ReactNode;
/** Wrap long lines: a line turning back on itself instead of running off. */
export declare function IconWrap(props: IconProps): ReactNode;
export declare function IconChevronDown(props: IconProps): ReactNode;
/** Mirror of `IconChevronDown`, for the diff's "previous change" button. */
export declare function IconChevronUp(props: IconProps): ReactNode;
export declare function IconFolder(props: IconProps & {
    open?: boolean;
}): ReactNode;
export declare function IconFile(props: IconProps): ReactNode;
export declare function IconRefresh(props: IconProps): ReactNode;
export declare function IconPlus(props: IconProps): ReactNode;
export declare function IconNewFolder(props: IconProps): ReactNode;
export declare function IconTrash(props: IconProps): ReactNode;
export declare function IconClose(props: IconProps): ReactNode;
/** Copy glyph: two offset sheets, the front one the clipboard's payload. */
export declare function IconCopy(props: IconProps): ReactNode;
/** Author glyph for the commit pane's metadata rows. */
export declare function IconUser(props: IconProps): ReactNode;
/** Date glyph, the pair of {@link IconUser} in the commit pane's metadata. */
export declare function IconClock(props: IconProps): ReactNode;
export declare function IconSearch(props: IconProps): ReactNode;
/**
 * "Search file NAMES": a page with a magnifier tucked into its lower-right
 * corner — the page reads as "a file", the magnifier as "find it by name".
 */
export declare function IconFileSearch(props: IconProps): ReactNode;
/**
 * "Search file CONTENTS": three text lines with a magnifier over the last one
 * — "look inside the lines", the counterpart to {@link IconFileSearch}'s
 * whole-file glyph, so the mode toggle reads at a glance.
 */
export declare function IconContentSearch(props: IconProps): ReactNode;
/** "Find in Folder…": a folder with a magnifier on its lower-right corner. */
export declare function IconFindInFolder(props: IconProps): ReactNode;
/**
 * The three search options, drawn as the glyphs everyone already knows from
 * VS Code: `Aa` (match case), `ab_` (whole word), `.*` (regex). They are text
 * rather than SVG on purpose — a drawn "Aa" reads worse at 14px than the
 * letters themselves, and the shapes stay recognizable in any UI language.
 */
export declare function IconCase(props: IconProps): ReactNode;
export declare function IconWholeWord(props: IconProps): ReactNode;
export declare function IconRegex(props: IconProps): ReactNode;
export declare function IconBranch(props: IconProps): ReactNode;
export declare function IconHistory(props: IconProps): ReactNode;
export declare function IconTerminal(props: IconProps): ReactNode;
export declare function IconServer(props: IconProps): ReactNode;
export declare function IconCode(props: IconProps): ReactNode;
export declare function IconCheck(props: IconProps): ReactNode;
export declare function IconUndo(props: IconProps): ReactNode;
export declare function IconDiff(props: IconProps): ReactNode;
export declare function IconImage(props: IconProps): ReactNode;
export declare function IconSync(props: IconProps): ReactNode;
export declare function IconSave(props: IconProps): ReactNode;
/** Upload: an arrow into a tray (the explorer's drag & drop / upload affordance). */
export declare function IconUpload(props: IconProps): ReactNode;
/** The slice of the better-sidebar service this kit consumes. */
export interface IconServiceLike {
    fileIcon(path: string, size: number): ReactNode;
    folderIcon(path: string, open: boolean, size: number): ReactNode;
}
/** Install the host icon provider (called once from the client entry). */
export declare function setIconService(service: IconServiceLike | undefined): void;
/** File row icon: host glyph when available, else the built-in SVG. */
export declare function FileIcon(props: {
    path: string;
    size?: number;
    className?: string;
}): ReactNode;
/** Directory row icon: host glyph when available, else the built-in SVG. */
export declare function FolderIcon(props: {
    path: string;
    open: boolean;
    size?: number;
    className?: string;
}): ReactNode;
export declare function isImageFile(path: string): boolean;
export declare function isMarkdownFile(path: string): boolean;
export declare function isHtmlFile(path: string): boolean;
export declare function mimeFor(path: string): string;
/** True for a file that always opens as a preview, never as a diff. */
export declare function isPreviewOnlyFile(path: string): boolean;
/**
 * Status → CSS class: `?` becomes `q` (untracked), `!` becomes `x` (ignored)
 * and any two-letter conflict state collapses to its first letter.
 */
export declare function gitStatusClass(status: string): string;
/**
 * The single letter a row shows (empty for "no marker").
 *
 * `?` renders as `?`, NOT as `U`. Both are defensible in isolation — VS Code
 * shows `U` for untracked — but here `U` is already the letter a MERGE
 * CONFLICT carries (`bucketStatus` pushes `status: 'U'` for unmerged paths), so
 * mapping untracked onto it made the two indistinguishable in the change list
 * while behaving completely differently on click: a conflict opens the file to
 * resolve markers, an untracked entry opens an empty-side diff. Keeping `?`
 * distinct costs nothing and removes the ambiguity.
 */
export declare function gitLetter(status: string | undefined): string;
/** Base name of a POSIX path. */
export declare function baseName(path: string): string;
/** Parent directory of a POSIX path (`/` when at the root). */
export declare function dirName(path: string): string;
/** Relative time in the UI language (seconds → "3 分钟前"). */
export declare function relTime(unixSeconds: number, lang: 'zh' | 'en'): string;
/** Absolute timestamp for tooltips. */
export declare function fullTime(unixSeconds: number): string;
/** Themed confirm; resolves false when dismissed. */
export declare function confirmDialog(opts: {
    title: string;
    text?: string;
    danger?: boolean;
    okText?: string;
    cancelText?: string;
}): Promise<boolean>;
/** Themed prompt; resolves undefined when dismissed. */
export declare function promptDialog(opts: {
    title: string;
    text?: string;
    initial?: string;
    placeholder?: string;
    okText?: string;
    cancelText?: string;
}): Promise<string | undefined>;
/** Transient status message (bottom-right, auto-dismiss). */
export declare function toast(text: string, error?: boolean): void;
/**
 * The single host that renders the modal + toast layer.
 *
 * Two mount points now exist (the sidebar panel and the conversation-view
 * editor), so ownership is arbitrated: the first mounted host renders, and a
 * later one takes over only after the first unmounts — otherwise every
 * confirm dialog would paint twice.
 */
export declare function DialogHost(): ReactNode;
export interface MenuEntry {
    label: string;
    onSelect: () => void;
    danger?: boolean;
    disabled?: boolean;
    hint?: string;
    /** Renders a separator before this entry. */
    separated?: boolean;
}
/** Portal-rendered context menu, clamped to the viewport before paint. */
export declare function ContextMenu(props: {
    x: number;
    y: number;
    entries: MenuEntry[];
    onClose: () => void;
}): ReactNode;
/** Hook: context-menu state + the handler that opens it. */
export declare function useContextMenu(): {
    menu: {
        x: number;
        y: number;
        entries: MenuEntry[];
    } | undefined;
    open: (x: number, y: number, entries: MenuEntry[]) => void;
    close: () => void;
};
/** Copy text to the clipboard, falling back to a hidden textarea. */
export declare function copyText(text: string): Promise<void>;
export interface SegmentedProps<T extends string> {
    value: T;
    options: {
        id: T;
        label: string;
        title?: string;
    }[];
    onChange: (value: T) => void;
}
/** The small segmented control used by the diff and preview toolbars. */
export declare function Segmented<T extends string>(props: SegmentedProps<T>): ReactNode;
/** A toolbar icon button. */
export declare function IconButton(props: {
    title: string;
    onClick: () => void;
    children: ReactNode;
    danger?: boolean;
    disabled?: boolean;
    className?: string;
}): ReactNode;
/** Spinner used in busy buttons. */
export declare function MiniSpinner(): ReactNode;
export {};
