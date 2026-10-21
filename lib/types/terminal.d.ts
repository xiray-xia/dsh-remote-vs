import type { WebSocket } from 'ws';
import type { RemotePool } from './pool.ts';
/**
 * The largest client frame accepted, in bytes.
 *
 * The only frame with a payload is `in` — keystrokes, and pastes, which the
 * client chunks to stay under this. The upgrade server (`routes.ts`) passes
 * this value as ws's `maxPayload`, so an oversized frame is refused before it
 * is buffered at all; the check in `hookSocket` is the second layer, and it is
 * what keeps such a frame from becoming a string plus an object graph in the
 * process that also runs the agent.
 */
export declare const TERMINAL_MAX_FRAME_BYTES: number;
export declare class TerminalSessionRegistry {
    private readonly pool;
    private readonly sessions;
    constructor(pool: RemotePool);
    /** Open a shell and attach the first socket. */
    open(ws: WebSocket, alias: string, cols: number, rows: number): Promise<string>;
    /**
     * Attach another socket to a live session; false when unknown/dead.
     *
     * The size in the URL is deliberately NOT applied here. It is the same
     * fixed 80x24 the view uses to open a shell, and re-applying it on every
     * reattach — which is what a page reload does — SHRANK a running shell:
     * SIGWINCH, and a full-screen program re-laying itself out at 80 columns,
     * until that tab became visible and refit. The session already has a size.
     * The socket sends a real `resize` frame as soon as it can measure itself
     * (`XTerm.pushSize`), which is the only place that knows how wide it is.
     *
     * The parameters stay because the upgrade handler owns the URL and passes
     * them on both paths; they matter to `open` (the PTY's initial size) only.
     */
    attach(ws: WebSocket, id: string, _cols: number, _rows: number): boolean;
    /** Close one session (kills the remote shell). */
    close(id: string): boolean;
    /** Close every session (plugin unload). */
    dispose(): void;
    list(): {
        id: string;
        alias: string;
        alive: boolean;
    }[];
    private hookSocket;
    /** Keep the shell for a while (reload can reattach), then close it for good. */
    private armReap;
    private cancelReap;
    private setPaused;
    private send;
    private broadcast;
}
