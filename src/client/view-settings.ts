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
import {
  REMOTE_VIEW_SETTINGS_DEFAULTS,
  clampViewWidthRatio,
  type RemoteViewSettings,
} from '../protocol.ts'
import { api } from './api.ts'

let cached: RemoteViewSettings | undefined
let inflight: Promise<RemoteViewSettings | undefined> | undefined
/** Where one published value came from: a load answers the page, a save is a user action. */
export type ViewSettingsSource = 'load' | 'save'
const listeners = new Set<(settings: RemoteViewSettings, source: ViewSettingsSource) => void>()

/** The last known preferences, or `undefined` until the first successful load. */
export function currentViewSettings(): RemoteViewSettings | undefined {
  return cached
}

/**
 * Subscribe to every loaded/saved value; returns the unsubscribe.
 *
 * The source matters: only a SAVE is an explicit user action, and only that may
 * resize a panel the user already has open (a page-load answer must not).
 */
export function subscribeViewSettings(
  listener: (settings: RemoteViewSettings, source: ViewSettingsSource) => void,
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Normalize one answer: an older host may omit or round a field. */
function normalize(raw: RemoteViewSettings | undefined): RemoteViewSettings {
  return {
    autoOpenRemoteWorkspace: typeof raw?.autoOpenRemoteWorkspace === 'boolean'
      ? raw.autoOpenRemoteWorkspace
      : REMOTE_VIEW_SETTINGS_DEFAULTS.autoOpenRemoteWorkspace,
    remoteWorkspaceWidthRatio: typeof raw?.remoteWorkspaceWidthRatio === 'number'
      && Number.isFinite(raw.remoteWorkspaceWidthRatio)
      ? clampViewWidthRatio(raw.remoteWorkspaceWidthRatio)
      : REMOTE_VIEW_SETTINGS_DEFAULTS.remoteWorkspaceWidthRatio,
  }
}

function publish(next: RemoteViewSettings, source: ViewSettingsSource): RemoteViewSettings {
  cached = next
  for (const listener of [...listeners]) {
    try {
      listener(next, source)
    } catch {
      // One broken surface must not starve the others.
    }
  }
  return next
}

/**
 * Load the preferences once (cached), or force a reload.
 *
 * @param force - ignore the cache (the retry path behind a failed first load).
 * @returns the current values, or `undefined` when the host cannot answer.
 */
export function loadViewSettings(force = false): Promise<RemoteViewSettings | undefined> {
  if (!force && cached !== undefined) return Promise.resolve(cached)
  if (!force && inflight !== undefined) return inflight
  const request = api.getViewSettings()
    .then(raw => publish(normalize(raw), 'load'), () => undefined)
    .finally(() => {
      if (inflight === request) inflight = undefined
    })
  inflight = request
  return request
}

/**
 * Persist a flat patch and publish the answer.
 *
 * @throws RemoteApiError when the host refuses (the settings page shows it).
 */
export async function saveViewSettings(patch: Partial<RemoteViewSettings>): Promise<RemoteViewSettings> {
  return publish(normalize(await api.setViewSettings(patch)), 'save')
}
