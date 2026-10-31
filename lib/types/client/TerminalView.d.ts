/**
 * Terminal view: a tab strip of independent remote shells under the host
 * picker. Each tab owns its own WebSocket and xterm instance, so several
 * sessions (or several hosts) can run side by side; hidden tabs stay MOUNTED,
 * which is what keeps their scrollback and running command alive.
 *
 * A tab is refresh-safe: the server session id is persisted, so reloading the
 * GUI reattaches to the still-running shell instead of spawning a new one.
 */
import { type ReactNode } from 'react';
import type { RemoteHostSummary } from '../protocol.ts';
import type { TerminalRequest } from './store.tsx';
/** First mount claims the panel, so a single-surface profile renders at once. */
export declare function claimTerminalOwnerIfNone(id: symbol): void;
/** Whether `id` is the surface that currently owns the terminal panel. */
export declare function terminalSurfaceOwnedBy(owner: symbol | undefined, id: symbol): boolean;
/** Why a terminal connection ended — and therefore whether the shell may live on. */
export type TerminalExitKind = 
/** The socket went away; the Host keeps the PTY for 10 minutes and can reattach. */
'reattach'
/** The remote shell really exited (or refused the connection at the shell level). */
 | 'exited'
/** The Host no longer knows this session id: drop it and open a fresh shell. */
 | 'expired';
/**
 * Classify one terminal exit report.
 *
 * `XTerm` reports the ssh channel's exit code and, for socket-level problems, a
 * message with `code === null`. A socket that closes with neither (page reload,
 * network blip, laptop sleep) must NOT destroy the tab's `session` id: the Host
 * keeps the PTY for `EMPTY_SOCKET_TTL_MS`, so the right answer is "keep the id,
 * offer a reattach". Only a real exit (a code, or a shell-level error message)
 * ends the session.
 */
export declare function classifyTerminalExit(code: number | null, message: string | undefined): TerminalExitKind;
/** What one tab should look like after an exit report. */
export interface TerminalExitState {
    connected: boolean;
    /** Kept for `reattach`, cleared for `exited`/`expired`. */
    session: string | undefined;
    kind: TerminalExitKind;
    /** i18n key for the note, when the note is a fixed sentence. */
    noteKey?: 'term.disconnected' | 'term.closed';
    /** Literal note (exit code or a host message), when it is not a fixed sentence. */
    noteText?: string;
}
/** Apply {@link classifyTerminalExit} to one tab. Pure, so the gate can pin it. */
export declare function terminalExitState(tab: {
    session?: string;
}, code: number | null, message: string | undefined): TerminalExitState;
export declare function TerminalView(props: {
    t: (key: string) => string;
    hosts: RemoteHostSummary[];
    visible: boolean;
    /** A pending "open a terminal here" request from the search results' menu. */
    request?: TerminalRequest;
}): ReactNode;
