/**
 * Download one remote file to the local machine.
 *
 * The Host streams the raw bytes over `REMOTE_API.download`, so this side must
 * NOT fetch the body: an anchor click lets the browser write straight to disk
 * (and lets Desktop's Electron shell run its native save flow) instead of
 * buffering a multi-GB file in page memory. The UI preflights with `files`
 * op=stat first, so a vanished or unreadable file shows the Host's real error
 * instead of saving an error page.
 */

import { REMOTE_API } from '../protocol.ts'

/** File name a remote POSIX path should be saved as. */
export function downloadFileName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const at = trimmed.lastIndexOf('/')
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

/**
 * Hand one download to the browser.
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
