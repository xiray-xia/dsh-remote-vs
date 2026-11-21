import { type RemoteViewSettings } from './protocol.ts';
export declare class RemoteViewSettingsStore {
    private readonly file;
    constructor(file?: string);
    /**
     * The current preferences (a missing file answers the defaults).
     *
     * Read from disk on every call: the file is tiny, GET hands it to a page load,
     * and two processes sharing `$DSH_HOME` (desktop + `dsh web`) must see each
     * other's edit without a restart.
     */
    get(): RemoteViewSettings;
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
    patch(patch: Record<string, unknown>): RemoteViewSettings;
    /** Write one document atomically: a crash never leaves a half-written file. */
    private save;
}
