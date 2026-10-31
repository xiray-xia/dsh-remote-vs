/**
 * Undo provenance: which repository a set of change marks belongs to.
 *
 * The revert (`git apply -R`, see `client/scm/actions.ts`) is the only user
 * action in this plugin that WRITES to the remote, so its coordinates must come
 * from the marks themselves — not from "whichever change panel updated last".
 * The panel therefore records one {@link ChangeOrigin} per tab when it attaches
 * the marks, and publishes it (validated) only while that tab is the one on
 * screen. The store's undo path keeps calling `undoContext()` unchanged; it now
 * receives proven provenance or nothing.
 *
 * Three failure modes this closes:
 * - **cross-session**: the panel's session and the marks' session must agree, so
 *   switching conversations cannot leave session A's patch aimed at session B's
 *   coordinates;
 * - **cross-binding (same alias)**: two bindings can share one host alias
 *   (`ssh_xiray_new` carries P710 and Z700). The alias is not an identity; the
 *   `bindingId` is, and the file path must sit under the recorded ledger root —
 *   otherwise a revert computed for one checkout can land in an identical sibling
 *   one, where git's context check would happily accept it;
 * - **stale binding**: a binding edited or moved keeps its id but changes its
 *   alias/root; the recorded snapshot no longer matches, so the revert refuses
 *   instead of guessing.
 *
 * Pure functions + a bounded registry here (no React, no cordis), so
 * `scripts/check-undo-target.mjs` drives the real decisions.
 */
import type { RemoteOpenBinding } from '../remote-file-open-target.ts';
/** Where one tab's change marks came from. */
export interface ChangeOrigin {
    /** Session whose ledger produced the hunks. */
    sessionId: string;
    /** Binding identity at attach time (the ONE unique key; alias is not). */
    bindingId: string;
    /** Host alias snapshot, for the binding-changed check. */
    alias: string;
    /** Ledger root the patch paths are relative to (`git apply -R` runs here). */
    root: string;
}
/** Why a revert must be refused. */
export type UndoRefusal = 'no-origin' | 'session-mismatch' | 'binding-gone' | 'binding-changed' | 'path-outside';
export type UndoTargetResult = {
    ok: true;
    origin: ChangeOrigin;
} | {
    ok: false;
    reason: UndoRefusal;
};
/**
 * Decide whether a revert may run, and with which coordinates.
 *
 * @param input.origin - provenance recorded when the marks were attached.
 * @param input.tabPath - the tab's absolute remote path (the file the patch names).
 * @param input.panelSessionId - the session whose panel is on screen right now.
 * @param input.bindings - the live binding table (`remoteOpenBindings()`).
 */
export declare function resolveUndoTarget(input: {
    origin: ChangeOrigin | undefined;
    tabPath: string;
    panelSessionId: string | undefined;
    bindings: readonly RemoteOpenBinding[];
}): UndoTargetResult;
/** Record where one tab's marks came from (called by the change panel). */
export declare function rememberChangeOrigin(tabId: string, origin: ChangeOrigin): void;
/** Drop one tab's provenance (marks cleared, file closed, diff failed). */
export declare function forgetChangeOrigin(tabId: string): void;
/** Provenance recorded for one tab, if any. */
export declare function changeOriginForTab(tabId: string | undefined): ChangeOrigin | undefined;
/**
 * The value the undo slot should hold for the tab currently on screen: the tab's
 * own validated provenance, or `undefined` (which makes undo refuse, never guess).
 */
export declare function publishableUndoOrigin(input: {
    tabId: string | undefined;
    tabPath: string | undefined;
    panelSessionId: string | undefined;
    bindings: readonly RemoteOpenBinding[];
}): ChangeOrigin | undefined;
