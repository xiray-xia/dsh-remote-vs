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
import type { HostNotice } from '../notices.ts';
/** How the toast layer receives one rendered message. */
export type HostNoticeEmitter = (text: string) => void;
/**
 * Install (or remove) the toast emitter; the client entry owns the lifetime.
 *
 * Messages that arrived before the entry registered are flushed, so a notice
 * produced during the first remote operation of a page load cannot be lost.
 */
export declare function setHostNoticeEmitter(next: HostNoticeEmitter | undefined): void;
/** Render one notice in the page language. */
export declare function formatHostNotice(notice: HostNotice, lang?: import("./i18n.ts").Lang): string;
/**
 * Show every valid notice carried by one API response.
 *
 * `emit` is injectable so a gate can drive this without React or a DOM. A
 * malformed payload is ignored: a newer/older peer must never turn a successful
 * remote operation into a client exception.
 */
export declare function dispatchHostNotices(payload: unknown, emit?: HostNoticeEmitter): number;
