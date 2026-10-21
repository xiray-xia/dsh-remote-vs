import type { Extension } from '@codemirror/state';
/** The extension of a remote path ('' when it has none). */
export declare function extensionOf(path: string): string;
/** The grammar extension list for a file path (empty = plain text). */
export declare function langFor(path: string): Extension[];
