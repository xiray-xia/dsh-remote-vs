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
  /**
   * Ctrl/Cmd+S → the pane's save path.
   *
   * MUST be a no-op while a modal layer is open: `CodeEditor` (the only caller)
   * checks `isModalLayerOpen()` before saving. The binding itself stays pure —
   * this module imports no DOM — but because CodeMirror handles the key first and
   * prevents the default, the window listener in `save-shortcut.ts` never gets to
   * apply its own gate to this path.
   */
  save(): void
  /** Ctrl/Cmd+F → seed our find widget from the selection and open it. */
  openFindForSelection(view: EditorView): void
  /** F3 / Shift+F3 → step through matches. */
  stepFind(view: EditorView, forward: boolean): void
  /** Jump to the previous/next change hunk; false when the panel is closed. */
  stepHunk(delta: 1 | -1): boolean
  /** Escape → close the find widget; false when it was not open. */
  closeFind(): boolean
  /**
   * Ctrl/Cmd+G → ask for a line number and jump there.
   *
   * The prompt is the caller's (`promptDialog`), so this module stays free of
   * DOM/React; the binding always claims the key (browsers use Ctrl+G for
   * "find next", which has nothing to do inside a code editor).
   */
  gotoLine(view: EditorView): void
  /**
   * Ctrl/Cmd+D → select the next occurrence of the current selection.
   *
   * Returns the command's own answer: `false` (nothing to expand, or a mixed
   * selection) must fall through to the browser instead of being swallowed —
   * the same rule the hunk bindings follow.
   */
  selectNextOccurrence(view: EditorView): boolean
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
export function parseGotoLine(text: string, total: number): number | undefined {
  const match = /^\s*(\d+)(?::\d+)?\s*$/.exec(text)
  if (match === null) return undefined
  const value = Number(match[1])
  if (!Number.isSafeInteger(value) || value < 1) return undefined
  return Math.min(value, Math.max(1, Math.floor(total)))
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
    /**
     * Ctrl/Cmd+G → go to line, Ctrl/Cmd+D → select next occurrence.
     *
     * `@codemirror/search` exports both, but this plugin deliberately does NOT
     * mount `searchKeymap`: that keymap also opens the stock search panel, which
     * the editor replaced with its own find widget. So the two commands are
     * wired through injected handlers instead (the goto-line one renders no
     * CodeMirror panel at all — the caller prompts).
     *
     * Mod-g claims the key even when the prompt is dismissed: Ctrl+G means
     * "find next" in the browser and must never leave the editor. Mod-d does NOT
     * set `preventDefault` — CodeMirror prevents the default for a key whenever
     * one of its bindings sets that flag, even when every command returns false,
     * and a failed expansion has to be able to fall through.
     */
    { key: 'Mod-g', run: (view) => { handlers.gotoLine(view); return true }, preventDefault: true },
    { key: 'Mod-d', run: (view) => handlers.selectNextOccurrence(view) },
  ]
}
