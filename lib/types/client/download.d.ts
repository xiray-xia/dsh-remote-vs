/**
 * Download one remote file or directory to the local machine.
 *
 * The Host streams the bytes over `REMOTE_API.download` (file) or
 * `REMOTE_API.downloadDir` (one remote `tar -czf -` archive). When the browser
 * offers the File System Access API the user picks the destination in a native
 * "save as" dialog and the response body is written chunk by chunk into that
 * file — streamed, never assembled into a Blob — which is also what feeds the
 * progress meter. Without the API (Firefox, some Electron shells) the download
 * falls back to an anchor click, i.e. the browser's configured download folder,
 * with no progress to report.
 *
 * The runner (`downloads.ts`) preflights with `files` op=stat, so a vanished or
 * unreadable path shows the Host's real error instead of an empty saved file.
 */
/** What one download attempt ended as. */
export type DownloadOutcome = 'saved' | 'downloaded';
/** One progress sample: `total` is absent for a streamed archive (chunked). */
export interface DownloadProgress {
    loaded: number;
    total?: number;
}
/** Hooks the runner uses for the progress panel and its cancel button. */
export interface SaveOptions {
    onProgress?: (progress: DownloadProgress) => void;
    signal?: AbortSignal;
}
/** File name a remote POSIX path should be saved as. */
export declare function downloadFileName(path: string): string;
/**
 * Same-origin URL of the streaming download route for one remote file.
 *
 * Deliberately RELATIVE, including on Desktop: the page origin there is
 * `dsh-app://app` and the Electron shell proxies app-origin HTTP to its Host,
 * so the click stays same-origin (the `download` attribute applies) and passes
 * the route's loopback/same-origin fence. Naming the published loopback origin
 * instead would make it a cross-site GET, which that fence rejects.
 */
export declare function downloadUrl(alias: string, path: string): string;
/** Same-origin URL of the streaming directory-archive route. */
export declare function downloadDirUrl(alias: string, path: string): string;
/** Same-origin URL of the multi-selection archive route (one `path` per entry). */
export declare function downloadManyUrl(alias: string, paths: readonly string[]): string;
/**
 * Hand one download to the browser (fallback when no save picker exists).
 *
 * The element is attached to the document on purpose: a detached anchor is
 * ignored by some Chromium versions, and Desktop's shell hooks the download at
 * the document level.
 */
export declare function triggerDownload(href: string, fileName: string): void;
/**
 * Save one streamed URL to a destination the user picks.
 *
 * The picker runs while the click's transient activation is still valid, so it
 * must come before the network work. A picker that refuses the call (expired
 * activation, policy) falls back to the browser download flow instead of
 * failing the download outright.
 *
 * @returns `'saved'` for the picked destination, `'downloaded'` for the
 *   browser-default fallback.
 */
export declare function saveRemoteUrl(href: string, fileName: string, options?: SaveOptions): Promise<DownloadOutcome>;
/** Save one remote file (fresh name from its POSIX basename). */
export declare function saveRemoteFile(alias: string, path: string, options?: SaveOptions): Promise<DownloadOutcome>;
/** Save one remote directory as a single `.tar.gz`. */
export declare function saveRemoteDir(alias: string, path: string, options?: SaveOptions): Promise<DownloadOutcome>;
/** Save several selected entries as one `.tar.gz` archive. */
export declare function saveRemoteMany(alias: string, paths: readonly string[], options?: SaveOptions): Promise<DownloadOutcome>;
