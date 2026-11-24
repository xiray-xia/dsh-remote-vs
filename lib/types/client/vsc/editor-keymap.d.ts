/**
 * The editor's key bindings, in one testable place.
 *
 * Why this module exists
 * ----------------------
 * Bug (2026-11-10, user report): "the remote editor cannot input Tab".
 *
 * CodeMirror 6's `defaultKeymap` deliberately does NOT bind Tab — the browser
 * default (move focus) stays available for accessibility. Indentation is the
 * opt-in `indentWithTab` binding, and this plugin never added it, so Tab fell
 * through to the browser: the caret left the editor instead of indenting. The
 * local sidebar editor binds it, which is why the same key worked there.
 *
 * The binding list used to live inline inside the CodeMirror mount effect, which
 * meant the only way to test it was to render the whole component. It lives here
 * so `scripts/check-editor-tab.mjs` can mount a real CodeMirror with the REAL
 * binding list and dispatch real Tab/Shift-Tab presses.
 *
 * Handlers are injected (no React, no editor state): the component wires them to
 * its refs/stores.
 */
import type { EditorView, KeyBinding } from '@codemirror/view';
/** The editor actions the key bindings dispatch into. */
export interface EditorKeyHandlers {
    /**
     * Ctrl/Cmd+S → the pane's save path.
     *
     * MUST be a no-op while a modal layer is open: `CodeEditor` (the only caller)
     * checks `isModalLayerOpen()` before saving. The binding itself stays pure —
     * this module imports no DOM — but because CodeMirror handles the key first and
     * prevents the default, the window listener in `save-shortcut.ts` never gets to
     * apply its own gate to this path.
     */
    save(): void;
    /** Ctrl/Cmd+F → seed our find widget from the selection and open it. */
    openFindForSelection(view: EditorView): void;
    /** F3 / Shift+F3 → step through matches. */
    stepFind(view: EditorView, forward: boolean): void;
    /** Jump to the previous/next change hunk; false when the panel is closed. */
    stepHunk(delta: 1 | -1): boolean;
    /** Escape → close the find widget; false when it was not open. */
    closeFind(): boolean;
    /**
     * Ctrl/Cmd+G → ask for a line number and jump there.
     *
     * The prompt is the caller's (`promptDialog`), so this module stays free of
     * DOM/React; the binding always claims the key (browsers use Ctrl+G for
     * "find next", which has nothing to do inside a code editor).
     */
    gotoLine(view: EditorView): void;
    /**
     * Ctrl/Cmd+D → select the next occurrence of the current selection.
     *
     * Returns the command's own answer: `false` (nothing to expand, or a mixed
     * selection) must fall through to the browser instead of being swallowed —
     * the same rule the hunk bindings follow.
     */
    selectNextOccurrence(view: EditorView): boolean;
}
/**
 * Resolve the "go to line" answer to a 1-based line number inside `total`.
 *
 * Accepts what VS Code's box accepts for the LINE half: `42`, ` 42 `, `42:7`
 * (the column half is ignored — this editor jumps to a line, the status bar
 * reports the column). Anything else (empty, `0`, text) is `undefined`, and a
 * number past the end CLAMPS to the last line instead of failing: the answer
 * usually comes from a file the user is reading, not from its exact length.
 */
export declare function parseGotoLine(text: string, total: number): number | undefined;
/**
 * Build the editor keymap.
 *
 * Order: the stock keymaps first, then the two additions that make this editor
 * behave like VS Code — `indentWithTab` (Tab / Shift-Tab indent or dedent) and
 * our own shortcuts. `indentWithTab` is deliberately NOT part of CodeMirror's
 * defaults, which is exactly what shipped the "Tab does nothing" bug; a red
 * proof in the gate removes it again.
 */
export declare function editorKeymap(handlers: EditorKeyHandlers): KeyBinding[];
