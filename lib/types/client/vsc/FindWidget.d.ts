/**
 * VS Code-style find widget for the editor: Ctrl/Cmd+F opens it, Enter / Shift+
 * Enter step through matches, Esc closes and returns focus to the buffer.
 *
 * Matching is delegated to CodeMirror's `@codemirror/search` (the same engine
 * its own panel uses, so `Aa` / `ab_` / `.*` behave identically), but the
 * widget itself is ours: the built-in panel is a plain form that never matches
 * the rest of this UI. Match counting walks the query's cursor, which is what
 * gives the "3/17" readout VS Code shows.
 */
import { type ReactNode } from 'react';
import { StateField } from '@codemirror/state';
import { EditorView, type DecorationSet } from '@codemirror/view';
import { SearchQuery } from '@codemirror/search';
/**
 * What the running query is, plus what was derived from it.
 *
 * The match list is kept alongside the decorations because the count readout
 * and the "which match is current" answer are both derivable from it without
 * touching the document again.
 */
interface FindMarks {
    query: SearchQuery | null;
    marks: DecorationSet;
    matches: {
        from: number;
        to: number;
    }[];
    /** Which match is highlighted, 1-based, or 0 when the caret is not on one. */
    index: number;
}
/**
 * The find-match extension for one editor (installed by CodeEditor).
 *
 * Exported as a value, not a function, so the field identity is stable across
 * mounts.
 */
export declare const findMatchHighlight: StateField<FindMarks>;
export interface FindState {
    query: string;
    caseSensitive: boolean;
    wholeWord: boolean;
    regexp: boolean;
}
/**
 * Push the query into the editor (highlights every match) and count them.
 *
 * The count is read back OUT of the field the dispatch just wrote, so one walk
 * of the document serves the marks, the total and the caret's position — this
 * used to be two walks here and two more once the caller stepped.
 */
export declare function applyFind(view: EditorView, state: FindState): {
    total: number;
    index: number;
};
/** Drop every match mark (the widget was closed or reset). */
export declare function clearFindMarks(view: EditorView): void;
export declare function stepFind(view: EditorView, forward: boolean, state?: FindState): void;
export declare function FindWidget(props: {
    view: EditorView | undefined;
    open: boolean;
    /** A selection carried in by Ctrl+F (`id` bumps to re-trigger). */
    seed: {
        text: string;
        id: number;
    };
    /**
     * Viewport coordinates pinning the widget to the editor's top-right corner.
     *
     * The widget is `position: fixed` on those coordinates instead of living in
     * the editor's layout: the editor sits in a slot whose height this plugin does
     * not own, so ANY ancestor can end up being the scroller — and a box inside
     * that subtree travels away with the text. Fixed coordinates cannot.
     */
    anchor?: {
        top: number;
        right: number;
    } | undefined;
    onClose: () => void;
}): ReactNode;
export {};
