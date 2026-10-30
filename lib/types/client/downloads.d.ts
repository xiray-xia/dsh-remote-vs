/**
 * Download runner and its tiny observable store.
 *
 * The explorer/search menus start one download each; this module owns the
 * stat preflight, the file-vs-directory choice, the cancel handle and the
 * progress/status snapshot the dock renders. Kept outside React on purpose:
 * the dock is portaled to `<body>` and may unmount with its sidebar tab, while
 * a download already streaming must keep running to completion.
 */
/** One download's lifecycle state. */
export type DownloadStatus = 'running' | 'done' | 'failed' | 'cancelled';
/** One task as the dock renders it. */
export interface DownloadTask {
    id: string;
    /** Basename of the remote path (or `selection-N` for a multi-selection). */
    name: string;
    /** Resolved from the stat preflight; `hint.directory` until then. */
    directory: boolean;
    /** Entries in a multi-selection archive; absent for a single path. */
    selection?: number;
    status: DownloadStatus;
    loaded: number;
    /** Absent for a streamed archive (chunked, size unknown). */
    total?: number;
    /** Failure text, or the note shown for the browser-default fallback. */
    error?: string;
    /** `browserDefault` means no save dialog existed and the file went to Downloads. */
    via?: 'picker' | 'browserDefault';
    startedAt: number;
    finishedAt?: number;
}
/** Human byte size for the progress line. */
export declare function formatByteCount(bytes: number): string;
/** Store surface: `useSyncExternalStore(subscribe, getSnapshot, getSnapshot)`. */
export declare const downloadsStore: {
    subscribe(listener: () => void): () => void;
    getSnapshot(): readonly DownloadTask[];
};
/**
 * Start one download (file or directory) and return its task id.
 *
 * The stat preflight runs here — not in the menus — so a deleted/unreadable
 * remote path becomes a failed task with the Host's real message, and the
 * file-vs-directory decision comes from the Host rather than a possibly stale
 * tree row.
 */
export declare function startDownload(alias: string, path: string, hint: {
    name: string;
    directory: boolean;
}): string;
/**
 * Start one multi-selection download.
 *
 * The Host archives every selected entry into a single `.tar.gz`, so the user
 * picks one destination instead of answering N save dialogs; mixed files and
 * directories are fine (tar recurses). Entry validation happens Host-side
 * before the archive starts, so no client preflight round trip is needed.
 */
export declare function startSelectionDownload(alias: string, paths: readonly string[]): string;
/** Cancel one running download (the panel's stop button). */
export declare function cancelDownload(id: string): void;
/** Drop one task from the dock (finished tasks only in practice). */
export declare function dismissDownload(id: string): void;
