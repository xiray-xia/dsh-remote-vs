/**
 * The editor area: one tab strip for code files, previews and diffs, an info
 * row, and the body dispatch.
 *
 * The `@文件` insertion and the selection→conversation popup are preserved
 * from the previous editor: `CodeEditor` still receives the chat target, and
 * every code pane is the same CodeMirror buffer with Ctrl+S wired to the
 * remote write route.
 */
import { type ReactNode } from 'react';
/**
 * The React `key` of one code editor — the tab's identity PLUS its reload nonce.
 *
 * `CodeEditor` reads `initial` exactly ONCE (on mount), so a re-read of the
 * remote file can only reach the live buffer by remounting it. `store.reloadTab`
 * bumps the nonce after it stores the new text, which turns "new bytes arrived"
 * into a key change instead of a dead prop update: without it the mounted
 * buffer kept showing the pre-reload content while the file on disk had the new
 * one, and the next Ctrl+S wrote the stale bytes back over the file.
 *
 * Exported so a self-check can assert the key really moves (and that it moves
 * only when a reload happened).
 */
export declare function editorKey(tab: {
    id: string;
    reloadNonce?: number;
}): string;
export declare function EditorPane(props: {
    visible: boolean;
}): ReactNode;
