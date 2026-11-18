/**
 * Client side of the Host's one-shot notices (`src/notices.ts`).
 *
 * The Host attaches notices to a JSON response when an automatic helper push ran
 * during that request; the API wrapper calls {@link dispatchHostNotices} after
 * parsing, and the message goes through the plugin's toast layer (bottom-right,
 * auto-dismiss) so the event is visible wherever the user is — including the
 * conversation view, where no remote-workspace surface is mounted.
 *
 * The emitter is REGISTERED by the client entry instead of imported here: this
 * module sits on the API path, which several offline gates load with a
 * TypeScript-only loader. Importing the JSX widget kit from `api.ts` would drag
 * React components into those loaders (they cannot transpile JSX) for a message
 * that only needs a string.
 */
import type { HostNotice } from '../notices.ts'
import { detectLang, makeT } from './i18n.ts'

/** How the toast layer receives one rendered message. */
export type HostNoticeEmitter = (text: string) => void

const MAX_QUEUED = 8
let emitter: HostNoticeEmitter | undefined
let queued: string[] = []

/**
 * Install (or remove) the toast emitter; the client entry owns the lifetime.
 *
 * Messages that arrived before the entry registered are flushed, so a notice
 * produced during the first remote operation of a page load cannot be lost.
 */
export function setHostNoticeEmitter(next: HostNoticeEmitter | undefined): void {
  emitter = next
  if (next === undefined) return
  const pending = queued
  queued = []
  for (const text of pending) next(text)
}

/** Render one notice in the page language. */
export function formatHostNotice(notice: HostNotice, lang = detectLang()): string {
  const t = makeT(lang)
  if (notice.kind === 'helper-pushed') {
    return t('hosts.helperPushed')
      .replace('{alias}', notice.alias)
      .replace('{version}', notice.version)
  }
  // Unknown kinds are dropped by the dispatcher before reaching here.
  return ''
}

/** Deliver one rendered message: to the emitter when present, else queue it. */
function deliver(text: string, emit?: HostNoticeEmitter): void {
  const target = emit ?? emitter
  if (target !== undefined) {
    target(text)
    return
  }
  if (queued.length < MAX_QUEUED) queued = [...queued, text]
}

/**
 * Show every valid notice carried by one API response.
 *
 * `emit` is injectable so a gate can drive this without React or a DOM. A
 * malformed payload is ignored: a newer/older peer must never turn a successful
 * remote operation into a client exception.
 */
export function dispatchHostNotices(payload: unknown, emit?: HostNoticeEmitter): number {
  if (typeof payload !== 'object' || payload === null) return 0
  const raw = (payload as { notices?: unknown }).notices
  if (!Array.isArray(raw)) return 0
  let shown = 0
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const notice = entry as Partial<HostNotice>
    if (notice.kind !== 'helper-pushed') continue
    if (typeof notice.alias !== 'string' || typeof notice.version !== 'string') continue
    if (notice.alias === '' || notice.version === '') continue
    const text = formatHostNotice({ kind: 'helper-pushed', alias: notice.alias, version: notice.version })
    if (text === '') continue
    deliver(text, emit)
    shown += 1
  }
  return shown
}
