/**
 * The window-level Ctrl/Cmd+S shortcut.
 *
 * `CodeEditor` owns that keystroke only while its CodeMirror view has focus (the
 * editor's keymap), so after clicking the tab strip, the info row, the find box
 * or any sidebar panel the very same keystroke did nothing at all — silently,
 * while the UI advertises Ctrl+S as the save key (the save button's title and
 * the empty-pane hint). A missed save is invisible until the tab is closed.
 *
 * Two rules make a global listener safe here:
 *
 *  - BUBBLE phase plus `defaultPrevented`: CodeMirror handles its own keydown
 *    first and calls `preventDefault()` when a keymap binding matches (its event
 *    dispatch does exactly that), so this listener must step aside then — one
 *    press may never save twice.
 *  - the CALLER decides what "save" means: `resolve()` returns undefined when the
 *    surface on screen has nothing of ours to save (a diff tab is `DiffView`'s own
 *    contract, a themed dialog owns its input, a terminal owns its keys).
 *
 * Dependency-free on purpose (no React, no CodeMirror): the gate drives it with
 * real `KeyboardEvent`s in jsdom, so the rule is testable without mounting the
 * whole editor.
 */
/** The fields `isSaveShortcut` reads — a structural type keeps it testable. */
export interface SaveShortcutEvent {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    isComposing?: boolean | undefined;
    defaultPrevented: boolean;
    target: EventTarget | null;
}
/**
 * Is this the save shortcut this module should act on?
 *
 * Pure: the caller passes the event's fields, so the gate can pin every rule
 * without a DOM.
 */
export declare function isSaveShortcut(event: SaveShortcutEvent): boolean;
/** A registered save target: `undefined` = this surface has nothing to save. */
export type SaveShortcutResolver = () => (() => void) | undefined;
/**
 * Install the window-level save shortcut for one surface.
 *
 * Re-entrant by design: the FIRST call installs the one window listener, later
 * calls only register their resolver (no second listener), and the last disposer
 * removes it.
 *
 * @param resolve - What to save RIGHT NOW; return the save action, or undefined
 *   when this surface is not ours to save. Called once per candidate keypress, so
 *   it always sees the current state.
 * @returns the disposer (unregisters this resolver; removes the listener when the
 *   last surface is gone).
 */
export declare function installSaveShortcut(resolve: SaveShortcutResolver): () => void;
