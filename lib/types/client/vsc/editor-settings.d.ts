/**
 * Editor view preferences (word wrap + font size), shared by every surface that
 * shows the editor (the sidebar pane, the conversation-view tab, the floating
 * window).
 *
 * Module-level, React/DOM-free on purpose: those three surfaces are three
 * different React trees, so React state cannot carry "I made the font bigger in
 * the floating window, dock it and the sidebar must show the same size" — which
 * is the whole point (it is ONE editor, only its mount changes).
 *
 * The pure parse/serialize half is exported because the self-check harness
 * imports this module in Node: it must not read localStorage at module load
 * (private mode throws on `getItem`).
 */
/** One shared view preference set. */
export interface EditorSettings {
    /** Soft wrap the long lines. */
    wrap: boolean;
    /** Editor type size in px (0.5 px steps are legal). */
    fontSize: number;
}
/** localStorage key: ONE JSON object, so the two fields cannot drift apart. */
export declare const EDITOR_SETTINGS_KEY = "dsh-remote-vs.editor.settings";
/** Legal font-size range, shared with the floating window's Ctrl+wheel zoom. */
export declare const FONT_MIN = 9;
export declare const FONT_MAX = 28;
export declare const FONT_STEP = 1;
/** Defaults used before anything was stored (matches the theme's 13px fallback). */
export declare const DEFAULT_EDITOR_SETTINGS: EditorSettings;
/** Clamp any input to a legal font size; non-numbers answer undefined. */
export declare function parseFontSize(value: unknown): number | undefined;
/** One zoom step (-1 = smaller, +1 = bigger), already clamped. */
export declare function stepFontSize(size: number, direction: -1 | 1): number;
/**
 * Parse the persisted JSON.
 *
 * Anything damaged (not JSON, not an object, wrong field types) falls back to
 * the defaults: this data only affects presentation, and a dirty localStorage
 * entry must never keep the page from starting.
 */
export declare function parseEditorSettings(raw: string | null | undefined): EditorSettings;
/** Serialize only the known fields (never whatever else the caller passed). */
export declare function serializeEditorSettings(settings: EditorSettings): string;
/** Current snapshot (identity-stable while unchanged, safe for useSyncExternalStore). */
export declare function editorSettingsSnapshot(): EditorSettings;
/** Subscribe to preference changes; returns the unsubscribe. */
export declare function subscribeEditorSettings(listener: () => void): () => void;
/**
 * Change one preference and persist it.
 *
 * Illegal values (out-of-range size) are clamped BEFORE the "did it change"
 * comparison: without that, every click on a "+" already at the cap would
 * re-render all three surfaces for nothing.
 */
export declare function updateEditorSettings(patch: Partial<EditorSettings>): void;
