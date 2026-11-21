/**
 * Durable store for the two client view preferences: `$DSH_HOME/dsh-remote-view.json`.
 *
 * Why a file of its own (and not the routing store, nor a browser-local key):
 *  - the settings describe how the PLUGIN behaves in the right panel, and they
 *    must apply to every Web/Desktop window of this profile — the browser's
 *    localStorage is per origin/per machine and would drift;
 *  - they are GUI behaviour, not routing facts: keeping them out of
 *    `dsh-remote.json` means a hand-edited preference can never break the store
 *    the routers read on every remote operation.
 *
 * Shape of the file (`version: 1`), written atomically (tmp + rename, 0600):
 *
 *   { "version": 1, "autoOpenRemoteWorkspace": false, "remoteWorkspaceWidthRatio": 0.45 }
 *
 * Field-by-field validation with defaults on READ (so a missing, older or
 * half-edited field costs only that field), and a flat PATCH on write (unknown
 * keys are ignored — the browser is the only writer, and a stale tab must not be
 * able to corrupt the file with an extra key).
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  REMOTE_VIEW_SETTINGS_DEFAULTS,
  clampViewWidthRatio,
  type RemoteViewSettings,
} from './protocol.ts'
import { viewSettingsPath } from './paths.ts'

/** On-disk document shape. */
interface ViewSettingsDoc {
  version: 1
  autoOpenRemoteWorkspace: boolean
  remoteWorkspaceWidthRatio: number
}

/** Defaults as a fresh copy (callers may own the object). */
function defaults(): RemoteViewSettings {
  return { ...REMOTE_VIEW_SETTINGS_DEFAULTS }
}

/** A finite width share, clamped into the allowed band; anything else is a miss. */
function readWidthRatio(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return clampViewWidthRatio(value)
}

export class RemoteViewSettingsStore {
  private readonly file: string

  constructor(file: string = viewSettingsPath()) {
    this.file = file
  }

  /**
   * The current preferences (a missing file answers the defaults).
   *
   * Read from disk on every call: the file is tiny, GET hands it to a page load,
   * and two processes sharing `$DSH_HOME` (desktop + `dsh web`) must see each
   * other's edit without a restart.
   */
  get(): RemoteViewSettings {
    if (!existsSync(this.file)) return defaults()
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (error) {
      throw new Error(`cannot parse ${this.file}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${this.file}: root must be an object`)
    }
    const doc = parsed as Partial<ViewSettingsDoc>
    if (doc.version !== undefined && doc.version !== 1) {
      throw new Error(`${this.file}: unsupported version ${String(doc.version)}`)
    }
    // Field by field: an unknown/future key, or one bad value, keeps the rest.
    return {
      autoOpenRemoteWorkspace: typeof doc.autoOpenRemoteWorkspace === 'boolean'
        ? doc.autoOpenRemoteWorkspace
        : REMOTE_VIEW_SETTINGS_DEFAULTS.autoOpenRemoteWorkspace,
      remoteWorkspaceWidthRatio: readWidthRatio(doc.remoteWorkspaceWidthRatio)
        ?? REMOTE_VIEW_SETTINGS_DEFAULTS.remoteWorkspaceWidthRatio,
    }
  }

  /**
   * Merge one flat patch into the stored preferences and persist the result.
   *
   * Unknown keys are ignored and an unusable value of a known field keeps the
   * stored one: the browser's controls only ever send valid values, so a bad
   * field means a stale client, not something the user should be told about.
   *
   * @param patch - a partial document straight from the POST body.
   * @returns the settings as stored.
   */
  patch(patch: Record<string, unknown>): RemoteViewSettings {
    const current = this.get()
    const next: RemoteViewSettings = {
      autoOpenRemoteWorkspace: typeof patch.autoOpenRemoteWorkspace === 'boolean'
        ? patch.autoOpenRemoteWorkspace
        : current.autoOpenRemoteWorkspace,
      remoteWorkspaceWidthRatio: readWidthRatio(patch.remoteWorkspaceWidthRatio)
        ?? current.remoteWorkspaceWidthRatio,
    }
    this.save(next)
    return next
  }

  /** Write one document atomically: a crash never leaves a half-written file. */
  private save(settings: RemoteViewSettings): void {
    const doc: ViewSettingsDoc = { version: 1, ...settings }
    const payload = `${JSON.stringify(doc, null, 2)}\n`
    const dir = dirname(this.file)
    // A fresh $DSH_HOME may not exist yet: the first save must not ENOENT.
    mkdirSync(dir, { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    const fd = openSync(tmp, 'w', 0o600)
    try {
      writeSync(fd, payload)
      // Flush before the rename (best effort): the next boot must never load an
      // empty file, but an OS refusing fsync must not fail the save.
      try {
        fsyncSync(fd)
      } catch {
        // Durability is improved, not guaranteed.
      }
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, this.file)
  }
}
