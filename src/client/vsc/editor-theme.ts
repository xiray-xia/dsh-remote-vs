/**
 * VS Code Dark+ / Light+ editor theme for CodeMirror.
 *
 * The DSH panels are translucent by design, but a code editor is not a panel:
 * it needs an OPAQUE surface and a real token palette, or syntax colors wash
 * out against whatever sits behind the sidebar. The palette itself lives in
 * `editor-palette.ts` (dependency-light, so the self-check harness can verify
 * that tokens really receive colors); this module adds the editor chrome and
 * the runtime theme swap.
 *
 * The theme is held in a Compartment, so flipping the app scheme recolors a
 * live editor without losing undo history or the cursor.
 */
import { Compartment, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { isDarkScheme, subscribeColorScheme } from '../theme.ts'
import { paletteFor, type Palette } from './editor-palette.ts'

/**
 * The chrome (background, gutters, selection) for one palette.
 *
 * `dark` is passed in rather than inferred from `p.bg === '#1e1e1e'`: deriving
 * it from a colour literal meant that editing the dark background silently
 * flipped the gutter border and tooltip colours to their light values, with no
 * error anywhere.
 */
function chrome(p: Palette, dark: boolean): Extension {
  return EditorView.theme({
    '&': {
      backgroundColor: p.bg,
      color: p.fg,
      // The floating window changes ONLY its own editor's type size (Ctrl+wheel,
      // see FloatingEditorWindow); the variable is unset everywhere else, so the
      // normal editor keeps 13px. A plain literal here would freeze the size and
      // make the zoom silently do nothing. The zoom is a property of the window,
      // so a docked editor always renders at the default size.
      fontSize: 'var(--rvs-editor-font-size, 13px)',
      height: '100%',
    },
    '.cm-content': {
      fontFamily: 'var(--rvs-mono, ui-monospace, monospace)',
      caretColor: p.cursor,
      padding: '6px 0',
    },
    '.cm-scroller': { fontFamily: 'var(--rvs-mono, ui-monospace, monospace)' },
    '.cm-gutters': {
      backgroundColor: p.gutterBg,
      color: p.gutterFg,
      border: 'none',
      borderRight: `1px solid ${dark ? '#333' : '#e8e8e8'}`,
    },
    '.cm-activeLine': { backgroundColor: p.activeLine },
    '.cm-activeLineGutter': { backgroundColor: p.activeGutter, color: p.fg },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: p.cursor },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: `${p.selection} !important`,
    },
    '.cm-selectionMatch': { backgroundColor: 'rgba(120, 170, 255, .25)' },
    '.cm-searchMatch': { backgroundColor: 'rgba(255, 200, 0, .28)' },
    '.cm-panels': { backgroundColor: p.bg, color: p.fg },
    '.cm-tooltip': { backgroundColor: dark ? '#252526' : '#f3f3f3', color: p.fg, border: '1px solid #454545' },
  }, { dark })
}

/**
 * The theme extension for a scheme.
 *
 * Chrome only, and it stays inside the compartment: token colors come from
 * fixed class names in vsc.css, so the highlighter needs no reconfiguration
 * and a scheme flip cannot drop it.
 */
export function vscodeEditorTheme(dark: boolean): Extension {
  return chrome(paletteFor(dark), dark)
}

/** Compartment holding the theme, so the scheme can flip at runtime. */
export const editorThemeCompartment = new Compartment()

/** Initial (compartment-held) theme extension. */
export function initialEditorTheme(): Extension {
  return editorThemeCompartment.of(vscodeEditorTheme(isDarkScheme()))
}

/**
 * Re-apply the theme when the app scheme flips.
 * @returns the disposer.
 */
export function watchEditorScheme(view: EditorView): () => void {
  return subscribeColorScheme(() => {
    try {
      view.dispatch({ effects: editorThemeCompartment.reconfigure(vscodeEditorTheme(isDarkScheme())) })
    } catch {
      // View disposed mid-flip.
    }
  })
}
