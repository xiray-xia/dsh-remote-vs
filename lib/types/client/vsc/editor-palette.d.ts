/**
 * The editor token palette (VS Code Dark+ / Light+).
 *
 * Token colors are expressed as FIXED CLASS NAMES (`rvs-ck-*`) and the actual
 * colors live in `vsc.css`:
 *
 *  - CodeMirror's `HighlightStyle` normally emits generated class names
 *    (`ͼq`, `ͼ12`, …) together with an injected stylesheet. That pipeline can
 *    fail silently — every token renders in one color — and such a failure is
 *    invisible to a type checker.
 *  - With `class:` in the specs the emitted names are stable, so the colors
 *    come from the same stylesheet that demonstrably paints the rest of the UI,
 *    the light/dark switch is plain CSS, and the self-check harness can assert
 *    both halves of the contract (class emitted ↔ rule defined).
 *
 * This module intentionally imports no DOM-bearing package, so the harness can
 * run it in Node.
 */
import { HighlightStyle } from '@codemirror/language';
/** Every class `vscodeHighlightStyle()` can emit (all must exist in vsc.css). */
export declare const TOKEN_CLASSES: readonly ["rvs-ck-comment", "rvs-ck-keyword", "rvs-ck-control", "rvs-ck-string", "rvs-ck-regexp", "rvs-ck-number", "rvs-ck-constant", "rvs-ck-func", "rvs-ck-type", "rvs-ck-variable", "rvs-ck-attr", "rvs-ck-meta", "rvs-ck-punct", "rvs-ck-op", "rvs-ck-heading", "rvs-ck-em", "rvs-ck-link", "rvs-ck-strike", "rvs-ck-invalid"];
/** Tag → fixed class mapping. Colors live in vsc.css, not here. */
export declare function vscodeHighlightStyle(): HighlightStyle;
/** Chrome palette (background, gutters, selection) — the part CodeMirror themes. */
export interface Palette {
    bg: string;
    fg: string;
    gutterBg: string;
    gutterFg: string;
    activeLine: string;
    activeGutter: string;
    selection: string;
    cursor: string;
}
export declare const DARK: Palette;
export declare const LIGHT: Palette;
export declare function paletteFor(dark: boolean): Palette;
