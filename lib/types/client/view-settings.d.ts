/**
 * Client cache of the two view preferences (`/api/dsh-remote/view-settings`).
 *
 * Two very different consumers read the same values and must agree:
 *  - the Settings page renders the controls and writes them;
 *  - the frame-wide auto-open behaviour (`auto-open-remote.ts`) reads them while
 *    the Settings page is closed — often it is the ONLY reader, because a page
 *    that never opened Settings still has to know whether to open the panel.
 *
 * So the cache lives at module scope with a one-listener-set subscription: a
 * save from the Settings page is visible to the behaviour in the SAME page
 * without a reload. Every read is soft — an older host without the route answers
 * nothing, `loadViewSettings` reports `undefined`, and the caller keeps its
 * defaults instead of crashing the surface that asked.
 */
import { type RemoteViewSettings } from '../protocol.ts';
/** Where one published value came from: a load answers the page, a save is a user action. */
export type ViewSettingsSource = 'load' | 'save';
/** The last known preferences, or `undefined` until the first successful load. */
export declare function currentViewSettings(): RemoteViewSettings | undefined;
/**
 * Subscribe to every loaded/saved value; returns the unsubscribe.
 *
 * The source matters: only a SAVE is an explicit user action, and only that may
 * resize a panel the user already has open (a page-load answer must not).
 */
export declare function subscribeViewSettings(listener: (settings: RemoteViewSettings, source: ViewSettingsSource) => void): () => void;
/**
 * Load the preferences once (cached), or force a reload.
 *
 * @param force - ignore the cache (the retry path behind a failed first load).
 * @returns the current values, or `undefined` when the host cannot answer.
 */
export declare function loadViewSettings(force?: boolean): Promise<RemoteViewSettings | undefined>;
/**
 * Persist a flat patch and publish the answer.
 *
 * @throws RemoteApiError when the host refuses (the settings page shows it).
 */
export declare function saveViewSettings(patch: Partial<RemoteViewSettings>): Promise<RemoteViewSettings>;
