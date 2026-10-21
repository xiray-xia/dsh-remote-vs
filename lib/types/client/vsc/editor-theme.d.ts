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
import { Compartment, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
/**
 * The theme extension for a scheme.
 *
 * Chrome only, and it stays inside the compartment: token colors come from
 * fixed class names in vsc.css, so the highlighter needs no reconfiguration
 * and a scheme flip cannot drop it.
 */
export declare function vscodeEditorTheme(dark: boolean): Extension;
/** Compartment holding the theme, so the scheme can flip at runtime. */
export declare const editorThemeCompartment: Compartment;
/** Initial (compartment-held) theme extension. */
export declare function initialEditorTheme(): Extension;
/**
 * Re-apply the theme when the app scheme flips.
 * @returns the disposer.
 */
export declare function watchEditorScheme(view: EditorView): () => void;
