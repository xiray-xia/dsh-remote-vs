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

import { REMOTE_API } from '../protocol.ts'

/** What one download attempt ended as. */
export type DownloadOutcome = 'saved' | 'downloaded'

/** One progress sample: `total` is absent for a streamed archive (chunked). */
export interface DownloadProgress {
  loaded: number
  total?: number
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
 * activation, policy) falls back to the browser download flow instead of
 * failing the download outright.
 *
 * @returns `'saved'` for the picked destination, `'downloaded'` for the
 *   browser-default fallback.
 */
export async function saveRemoteUrl(href: string, fileName: string, options: SaveOptions = {}): Promise<DownloadOutcome> {
  const picker = (globalThis as unknown as SaveFilePickerApi).showSaveFilePicker
  if (typeof picker !== 'function') {
    if (options.signal?.aborted === true) throw abortError()
    triggerDownload(href, fileName)
    return 'downloaded'
  }
  let handle: SaveFileHandle
  try {
    handle = await picker.call(globalThis, { suggestedName: fileName })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    if (error instanceof Error && (error.name === 'SecurityError' || error.name === 'NotAllowedError')) {
      if (options.signal?.aborted === true) throw abortError()
      triggerDownload(href, fileName)
      return 'downloaded'
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
  return 'saved'
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
