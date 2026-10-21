/**
 * Fallback syntax coloring for the editor.
 *
 * The primary highlighter is CodeMirror's: a grammar builds a syntax tree in
 * idle time and `syntaxHighlighting` turns its tags into decorated spans. When
 * that chain does not produce decorations, a file renders MONOCHROME — and the
 * symptom is indistinguishable from a missing grammar, which is exactly the
 * dead end this module removes.
 *
 * The fallback paints the SAME token classes the diff panes already use
 * (`rvs-t-*`, via the line tokenizer in `tokenize.ts`), so it needs nothing from
 * the tree pipeline: no grammar, no idle-time parse, no generated class names.
 * It is engaged only when the primary highlighter produced nothing, and only for
 * the visible lines, so the cost is bounded by the viewport.
 */
import { type Extension } from '@codemirror/state';
/**
 * Token colors for one editor.
 *
 * @param path - the file path (its extension selects the tokenizer language).
 * @param isPrimaryColoring - reports whether CodeMirror's highlighter has
 *   meanwhile produced spans; while it has, this plugin stays idle.
 */
export declare function fallbackHighlight(path: string, isPrimaryColoring: () => boolean): Extension;
/** True when the tokenizer has a language for this path at all. */
export declare function canFallbackHighlight(path: string): boolean;
