/**
 * Caret readout maths for the editor status bar (pure, no CodeMirror/DOM).
 *
 * Kept out of `CodeEditor.tsx` so the gate can assert the 1-based conversion and
 * the "selected characters" count without mounting an editor.
 */

/** Caret readout for the status bar (1-based, matching what the user sees). */
export interface CodeEditorCaret {
  /** 1-based line of the caret (the selection's head). */
  line: number
  /** 1-based column of the caret. */
  column: number
  /** Number of selected characters (0 = empty selection). */
  selected: number
}

/** The caret reading of one editor state. */
export function caretOf(state: {
  doc: { lineAt(offset: number): { number: number; from: number; to: number } }
  selection: { main: { head: number; from: number; to: number } }
}): CodeEditorCaret {
  const main = state.selection.main
  const line = state.doc.lineAt(main.head)
  return {
    line: line.number,
    column: main.head - line.from + 1,
    selected: Math.max(0, main.to - main.from),
  }
}
