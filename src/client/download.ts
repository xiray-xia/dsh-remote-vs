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

import { REMOTE_API, selectionDownloadName } from '../protocol.ts'

/** What one download attempt ended as. */
export type DownloadOutcome =
  /** Bytes went through the save picker into the user's chosen file. */
  | 'saved-picker'
  /** Bytes were fully received and then handed to the browser to save. */
  | 'saved-browser'
  /**
   * The URL was handed to the browser, which now owns the transfer: its bytes,
   * its failures and its cancel. The panel must NOT report completion.
   */
  | 'handedOff'

/** One progress sample: `total` is absent for a streamed archive (chunked). */
export interface DownloadProgress {
  loaded: number
  total?: number
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
export const FALLBACK_BUFFER_MAX_BYTES = 64 * 1024 * 1024

/**
 * What the fallback should do with a body of `declaredTotal` bytes.
 *
 * `handoff` means the browser must own the transfer: too large to assemble in
 * memory, and no failure/progress/cancel can be reported for it. Exported pure
 * so the gate can pin the boundary without allocating 64 MiB.
 */
export function fallbackPlan(declaredTotal: number | undefined): 'buffer' | 'handoff' {
  return declaredTotal !== undefined && declaredTotal > FALLBACK_BUFFER_MAX_BYTES ? 'handoff' : 'buffer'
}

/** Hooks the runner uses for the progress panel and its cancel button. */
export interface SaveOptions {
  onProgress?: (progress: DownloadProgress) => void
  signal?: AbortSignal
}

/** The writable file the save picker hands back (FileSystemWritableFileStream). */
interface SaveFileWritable {
  write: (chunk: Uint8Array) => Promise<void>
  close: () => Promise<void>
  abort: () => Promise<void>
}

/** Minimal shape of the File System Access save picker (Chromium/Edge). */
interface SaveFileHandle {
  createWritable: () => Promise<SaveFileWritable>
  remove?: () => Promise<void>
}

interface SaveFilePickerApi {
  showSaveFilePicker?: (options: { suggestedName?: string }) => Promise<SaveFileHandle>
}

/** File name a remote POSIX path should be saved as. */
export function downloadFileName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at < 0 ? trimmed : trimmed.slice(at + 1)
}

/**
 * Same-origin URL of the streaming download route for one remote file.
 *
 * Deliberately RELATIVE, including on Desktop: the page origin there is
 * `dsh-app://app` and the Electron shell proxies app-origin HTTP to its Host,
 * so the click stays same-origin (the `download` attribute applies) and passes
 * the route's loopback/same-origin fence. Naming the published loopback origin
 * instead would make it a cross-site GET, which that fence rejects.
 */
export function downloadUrl(alias: string, path: string): string {
  return `${REMOTE_API.download}?${new URLSearchParams({ alias, path }).toString()}`
}

/** Same-origin URL of the streaming directory-archive route. */
export function downloadDirUrl(alias: string, path: string): string {
  return `${REMOTE_API.downloadDir}?${new URLSearchParams({ alias, path }).toString()}`
}

/** Same-origin URL of the multi-selection archive route (one `path` per entry). */
export function downloadManyUrl(alias: string, paths: readonly string[]): string {
  const query = new URLSearchParams({ alias })
  for (const path of paths) query.append('path', path)
  return `${REMOTE_API.downloadMany}?${query.toString()}`
}

/**
 * Hand one download to the browser (fallback when no save picker exists).
 *
 * The element is attached to the document on purpose: a detached anchor is
 * ignored by some Chromium versions, and Desktop's shell hooks the download at
 * the document level.
 */
export function triggerDownload(href: string, fileName: string): void {
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = fileName
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.append(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
  }
}

/** An error shaped like the one `AbortSignal` consumers expect. */
function abortError(): Error {
  const error = new Error('download cancelled')
  error.name = 'AbortError'
  return error
}

/** Hand a fully received body to the browser's own "save file" path. */
export function saveBytesViaBrowser(bytes: readonly Uint8Array[], fileName: string): void {
  const blob = new Blob([...bytes] as unknown as BlobPart[])
  const url = URL.createObjectURL(blob)
  triggerDownload(url, fileName)
  // The click has already started the read; revoking later keeps slower shells
  // (and the Electron download hook) able to finish it.
  const revoke = (): void => {
    try {
      URL.revokeObjectURL(url)
    } catch {
      // Already revoked.
    }
  }
  const timer = setTimeout(revoke, 60_000)
  timer.unref?.()
}

/**
 * Fallback for browsers without the save picker (Firefox, some Electron shells).
 *
 * The old shape clicked an anchor and immediately reported COMPLETE, so the
 * panel claimed a saved file before a byte had landed, a Host error response
 * (502 JSON) was saved as a file, and the cancel button did nothing. This path
 * owns the transfer whenever the body is small enough to buffer:
 *
 * - `fetch` first, so a non-2xx Host answer is a FAILED download, not a file;
 * - the body is read chunk by chunk (progress + AbortSignal), capped at
 *   {@link FALLBACK_BUFFER_MAX_BYTES};
 * - only a complete body is handed to the browser (`saved-browser`);
 * - a body known to be larger (or an unknown-length archive that grows past the
 *   cap) is handed to the browser as a URL (`handedOff`) — the panel then says
 *   the browser owns it instead of claiming a completion it cannot verify.
 */
async function saveViaFallback(href: string, fileName: string, options: SaveOptions): Promise<DownloadOutcome> {
  const signal = options.signal
  // Read through a closure: a direct signal?.aborted === true check above would
  // narrow the optional chain and make every later comparison look impossible.
  const cancelled = (): boolean => signal?.aborted === true
  if (cancelled()) throw abortError()
  const canFetch = typeof fetch === 'function'
  const canSaveBytes = canFetch && typeof URL !== 'undefined'
    && typeof URL.createObjectURL === 'function' && typeof Blob !== 'undefined'
  if (!canSaveBytes) {
    triggerDownload(href, fileName)
    return 'handedOff'
  }
  let response: Response
  try {
    response = await fetch(href, signal === undefined ? undefined : { signal })
  } catch (error) {
    if (cancelled()) throw abortError()
    throw error
  }
  if (!response.ok || response.body === null) {
    const detail = await response.text().catch(() => '')
    throw new Error(detail.trim() === '' ? `HTTP ${response.status}` : detail.trim())
  }
  const lengthHeader = response.headers.get('content-length')
  const parsedLength = lengthHeader === null ? Number.NaN : Number(lengthHeader)
  const declared = Number.isFinite(parsedLength) && parsedLength >= 0 ? parsedLength : undefined
  if (fallbackPlan(declared) === 'handoff') {
    // Too large to assemble in memory: the browser streams it to disk itself.
    try {
      await response.body.cancel()
    } catch {
      // Already gone.
    }
    triggerDownload(href, fileName)
    return 'handedOff'
  }
  const chunks: Uint8Array[] = []
  let loaded = 0
  const reader = response.body.getReader()
  try {
    options.onProgress?.({ loaded, ...(declared === undefined ? {} : { total: declared }) })
    for (;;) {
      if (cancelled()) throw abortError()
      const { done, value } = await reader.read()
      if (done) break
      loaded += value.byteLength
      if (loaded > FALLBACK_BUFFER_MAX_BYTES) {
        // Unknown-length body (a chunked tar archive) crossed the cap: abandon
        // this read and hand the URL over — a fresh request, no partial file.
        try {
          await reader.cancel()
        } catch {
          // Already gone.
        }
        triggerDownload(href, fileName)
        return 'handedOff'
      }
      chunks.push(value)
      options.onProgress?.({ loaded, ...(declared === undefined ? {} : { total: declared }) })
    }
  } catch (error) {
    try {
      await reader.cancel()
    } catch {
      // Already gone.
    }
    if (cancelled()) throw abortError()
    throw error
  }
  saveBytesViaBrowser(chunks, fileName)
  return 'saved-browser'
}

/** Delete the just-created target after a failed transfer (best effort). */
async function discard(handle: SaveFileHandle): Promise<void> {
  try {
    await handle.remove?.()
  } catch {
    // The browser may keep the handle locked for a moment; an empty file is a
    // better outcome than masking the real error.
  }
}

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
export async function saveRemoteUrl(href: string, fileName: string, options: SaveOptions = {}): Promise<DownloadOutcome> {
  const picker = (globalThis as unknown as SaveFilePickerApi).showSaveFilePicker
  if (typeof picker !== 'function') {
    return saveViaFallback(href, fileName, options)
  }
  let handle: SaveFileHandle
  try {
    handle = await picker.call(globalThis, { suggestedName: fileName })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    if (error instanceof Error && (error.name === 'SecurityError' || error.name === 'NotAllowedError')) {
      return saveViaFallback(href, fileName, options)
    }
    throw error
  }
  const signal = options.signal
  let response: Response
  try {
    response = await fetch(href, signal === undefined ? undefined : { signal })
  } catch (error) {
    await discard(handle)
    throw error
  }
  if (!response.ok || response.body === null) {
    const detail = await response.text().catch(() => '')
    await discard(handle)
    throw new Error(detail.trim() === '' ? `HTTP ${response.status}` : detail.trim())
  }
  const lengthHeader = response.headers.get('content-length')
  const parsedTotal = lengthHeader === null ? Number.NaN : Number(lengthHeader)
  const total = Number.isFinite(parsedTotal) && parsedTotal >= 0 ? parsedTotal : undefined
  const writable = await handle.createWritable()
  const reader = response.body.getReader()
  let loaded = 0
  try {
    options.onProgress?.({ loaded, ...(total === undefined ? {} : { total }) })
    for (;;) {
      if (signal?.aborted === true) throw abortError()
      const { done, value } = await reader.read()
      if (done) break
      loaded += value.byteLength
      await writable.write(value)
      options.onProgress?.({ loaded, ...(total === undefined ? {} : { total }) })
    }
    await writable.close()
  } catch (error) {
    try {
      await reader.cancel()
    } catch {
      // Stream already gone.
    }
    try {
      await writable.abort()
    } catch {
      // Already closed.
    }
    await discard(handle)
    throw error
  }
  return 'saved-picker'
}

/** Save one remote file (fresh name from its POSIX basename). */
export function saveRemoteFile(alias: string, path: string, options: SaveOptions = {}): Promise<DownloadOutcome> {
  return saveRemoteUrl(downloadUrl(alias, path), downloadFileName(path), options)
}

/** Save one remote directory as a single `.tar.gz`. */
export function saveRemoteDir(alias: string, path: string, options: SaveOptions = {}): Promise<DownloadOutcome> {
  const name = downloadFileName(path) || 'root'
  return saveRemoteUrl(downloadDirUrl(alias, path), `${name}.tar.gz`, options)
}

/** Save several selected entries as one `.tar.gz` archive. */
export function saveRemoteMany(alias: string, paths: readonly string[], options: SaveOptions = {}): Promise<DownloadOutcome> {
  return saveRemoteUrl(downloadManyUrl(alias, paths), selectionDownloadName(paths.length), options)
}
