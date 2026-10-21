/**
 * Minimal bilingual copy (zh default, en fallback). P0 keeps its own tiny
 * dictionary instead of the locale service; keys are added with each view.
 */
/**
 * Keys reached through a LOOKUP rather than a literal translator call.
 *
 * The status chip picks its label from a table and the hunk toast picks one of
 * three by action, so a source scan cannot see them — `.spike/i18n-check.mjs`
 * would report them as orphans and invite someone to delete live copy. Listing
 * them here keeps the check meaningful in both directions: every entry must
 * exist in both dictionaries, and nothing else may be unreferenced.
 */
export declare const DYNAMIC_KEYS: readonly ["common.loading", "editor.saving", "editor.unsaved", "editor.saved", "scm.hunkStaged", "scm.hunkUnstaged", "scm.hunkReverted"];
export type Lang = 'zh' | 'en';
export declare function detectLang(): Lang;
export declare function makeT(lang: Lang): (key: string) => string;
