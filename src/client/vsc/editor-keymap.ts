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
import type { EditorView, KeyBinding } from '@codemirror/view'
import { defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands'

/** The editor actions the key bindings dispatch into. */
export interface EditorKeyHandlers {
  /** Ctrl/Cmd+S → the pane's save path. */
  save(): void
  /** Ctrl/Cmd+F → seed our find widget from the selection and open it. */
  openFindForSelection(view: EditorView): void
  /** F3 / Shift+F3 → step through matches. */
  stepFind(view: EditorView, forward: boolean): void
  /** Jump to the previous/next change hunk; false when the panel is closed. */
  stepHunk(delta: 1 | -1): boolean
  /** Escape → close the find widget; false when it was not open. */
  closeFind(): boolean
}

/**
 * Build the editor keymap.
 *
 * Order: the stock keymaps first, then the two additions that make this editor
 * behave like VS Code — `indentWithTab` (Tab / Shift-Tab indent or dedent) and
 * our own shortcuts. `indentWithTab` is deliberately NOT part of CodeMirror's
 * defaults, which is exactly what shipped the "Tab does nothing" bug; a red
 * proof in the gate removes it again.
 */
export function editorKeymap(handlers: EditorKeyHandlers): KeyBinding[] {
  return [
    ...defaultKeymap,
    ...historyKeymap,
    // Tab inserts a unit of indentation at the caret line; Shift-Tab dedents the
    // selected lines. Read-only views make `indentMore` return false, so the key
    // still falls through to the browser there (diff panes stay navigable).
    indentWithTab,
    { key: 'Mod-s', run: () => { handlers.save(); return true }, preventDefault: true },
    // Ctrl/Cmd+F opens OUR widget (the built-in search panel is never mounted,
    // so `searchKeymap` is deliberately absent). A selection seeds the query,
    // the way it does in VS Code, so find-on-selection is one keystroke.
    {
      key: 'Mod-f',
      run: (view) => {
        handlers.openFindForSelection(view)
        return true
      },
      preventDefault: true,
    },
    { key: 'F3', run: (view) => { handlers.stepFind(view, true); return true }, preventDefault: true },
    { key: 'Shift-F3', run: (view) => { handlers.stepFind(view, false); return true }, preventDefault: true },
    /**
     * Previous / next change hunk.
     *
     * `Mod-Shift-Alt-ArrowUp/Down` is the free combination: defaultKeymap already
     * uses `Mod-Alt-Arrow*` (multi-cursor), `Alt-Arrow*` (move line) and
     * `Shift-Alt-Arrow*` (copy line), and browsers leave this extra Shift alone.
     *
     * NO `preventDefault: true` here, deliberately: CodeMirror prevents the
     * default whenever a binding for that key sets the flag, even if every
     * command returns false (view keymap `runFor`). With the panel closed the
     * handler returns false, and the key must fall through instead of being
     * swallowed — the 2026-11-10 gate found this latent swallow while pinning
     * the Tab fix.
     */
    {
      key: 'Mod-Shift-Alt-ArrowDown',
      run: () => handlers.stepHunk(1),
    },
    {
      key: 'Mod-Shift-Alt-ArrowUp',
      run: () => handlers.stepHunk(-1),
    },
    {
      key: 'Escape',
      run: () => handlers.closeFind(),
    },
  ]
}
