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
    /** Translator for the right-click menu (copy / paste / select all). */
    t: (key: string) => string;
    /** Tab identity, used by the snippet panel to target THIS terminal. */
    tabId: string;
    /**
     * Ctrl/Cmd+B inside the terminal: open the "add snippet" form.
     *
     * Absent → the keystroke stays the shell's (readline's backward-char), which
     * is what a host that did not wire the panel should keep.
     */
    onQuickAddSnippet?: () => void;
    /**
     * Remote home directory of this tab's host, when known.
     *
     * Used to resolve a `~/x` token printed by the shell. The SSH user's home is
     * the only honest source — the terminal protocol carries no home directory.
     */
    home?: string;
    /**
     * Ctrl/Cmd + click on a path printed in the terminal.
     *
     * Receives the path AS PRINTED plus the hints that make sense of a relative
     * one: the shell's cwd when it reports it (OSC 7) and the remote home.
     */
    onPathClick?: (token: string, context: {
        cwd?: string;
        home?: string;
    }) => void;
}): ReactNode;
