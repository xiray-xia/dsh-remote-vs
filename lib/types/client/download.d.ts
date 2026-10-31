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
export type DownloadOutcome = 
/** Bytes went through the save picker into the user's chosen file. */
'saved-picker'
/** Bytes were fully received and then handed to the browser to save. */
 | 'saved-browser'
/**
 * The URL was handed to the browser, which now owns the transfer: its bytes,
 * its failures and its cancel. The panel must NOT report completion.
 */
 | 'handedOff';
/** One progress sample: `total` is absent for a streamed archive (chunked). */
export interface DownloadProgress {
    loaded: number;
    total?: number;
}
/**
 * Largest body the fallback path buffers before handing the URL to the browser.
 *
 * The save picker streams straight to disk, but a browser without the File
 * System Access API can only be given a URL. Owning the transfer for small and
 * medium files is what lets the panel see a Host error (a 502 JSON used to be
 * saved as a file), report real progress and cancel; a 64 MiB ceiling keeps a
 * multi-GB artifact from being assembled in the tab's memory.
 */
export declare const FALLBACK_BUFFER_MAX_BYTES: number;
/**
 * What the fallback should do with a body of `declaredTotal` bytes.
 *
 * `handoff` means the browser must own the transfer: too large to assemble in
 * memory, and no failure/progress/cancel can be reported for it. Exported pure
 * so the gate can pin the boundary without allocating 64 MiB.
 */
export declare function fallbackPlan(declaredTotal: number | undefined): 'buffer' | 'handoff';
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
/** Hand a fully received body to the browser's own "save file" path. */
export declare function saveBytesViaBrowser(bytes: readonly Uint8Array[], fileName: string): void;
/**
 * Save one streamed URL to a destination the user picks.
 *
 * The picker runs while the click's transient activation is still valid, so it
 * must come before the network work. A picker that refuses the call (expired
 * activation, policy) falls back to {@link saveViaFallback} instead of failing
 * the download outright.
 *
 * @returns `'saved-picker'` for the picked destination, `'saved-browser'` when
 *   the fallback received every byte and handed them to the browser, and
 *   `'handedOff'` when the browser owns an unverified transfer.
 */
export declare function saveRemoteUrl(href: string, fileName: string, options?: SaveOptions): Promise<DownloadOutcome>;
/** Save one remote file (fresh name from its POSIX basename). */
export declare function saveRemoteFile(alias: string, path: string, options?: SaveOptions): Promise<DownloadOutcome>;
/** Save one remote directory as a single `.tar.gz`. */
export declare function saveRemoteDir(alias: string, path: string, options?: SaveOptions): Promise<DownloadOutcome>;
/** Save several selected entries as one `.tar.gz` archive. */
export declare function saveRemoteMany(alias: string, paths: readonly string[], options?: SaveOptions): Promise<DownloadOutcome>;
