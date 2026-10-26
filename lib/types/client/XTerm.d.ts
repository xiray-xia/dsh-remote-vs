/**
 * xterm.js wrapper over the /api/dsh-remote/terminal WebSocket. Mount-once;
 * the parent remounts (key) to (re)connect. Reports the server session id
 * for refresh-safe reattach and the exit state for the view chrome.
 */
import '@xterm/xterm/css/xterm.css';
import { type ReactNode } from 'react';
export declare function XTerm(props: {
    wsUrl: string;
    onReady: (id: string) => void;
    onExit: (code: number | null, message?: string) => void;
    fontFamily?: string;
    /** When the parent sub-tab hides/shows this view without unmounting. */
    visible?: boolean;
    /**
     * Line typed into the fresh shell once its PTY reports ready (a menu entry's
     * `cd`). Sent ONCE per mount: a reconnect is a new mount and thus a new shell,
     * which correctly re-runs the line.
     */
    initialInput?: string;
}): ReactNode;
