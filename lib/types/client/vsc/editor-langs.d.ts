import type { Extension } from '@codemirror/state';
/** The extension of a remote path ('' when it has none). */
export declare function extensionOf(path: string): string;
/** The grammar extension list for a file path (empty = plain text). */
export declare function langFor(path: string): Extension[];
/**
 * Guess the indentation style from the file body (status-bar hint only).
 *
 * Only the first stretch of lines that really starts with whitespace is
 * inspected: the goal is a quick hint, not a formatter. `undefined` means "no
 * indented line in the head", and the status bar then omits the item instead of
 * inventing a default.
 */
export declare function detectIndentLabel(text: string): string | undefined;
