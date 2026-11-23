/**
 * The editor area: one tab strip for code files, previews and diffs, an info
 * row, the body, and (in the full-width conversation-view variant) a status bar.
 *
 * The chrome follows the local sidebar plugin's editor (same tab strip, info
 * row, empty states, status bar, image preview and editor background tokens),
 * while every remote-only capability stays exactly where it was: the remote
 * read/write routes, the save-conflict banner and its on-demand difference, the
 * diff tabs, markdown/HTML previews, session change marks and the offline
 * read-only degradation.
 *
 * Three variants share this component, chosen from the store's effective
 * surface — never from a prop, so a surface can never mount two live buffers:
 *  - `sidebar`: the docked pane — a FULL-COLUMN rail page and the default seat
 *    (opening a file switches the rail to it; closing the last file switches
 *    back to the directory);
 *  - `center`: the conversation-view tab next to 对话 / 轨迹 (optional, full
 *    width, breadcrumb + status bar);
 *  - `float`: the frame-wide floating window (its own font zoom applies).
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
