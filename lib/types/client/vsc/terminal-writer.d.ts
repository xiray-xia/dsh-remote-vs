/**
 * Terminal OUTPUT writer: an ordered, coalescing buffer between the WebSocket
 * frames and `term.write`.
 *
 * Why this is not just `term.write(frame.d)` per frame, and NOT a chain of
 * `write(..., callback)`:
 *
 *  - xterm parses writes in slices of a few milliseconds; handing it one string
 *    per frame costs per-call overhead on a busy stream (`cat`, `dmesg`).
 *  - chaining on the write CALLBACK couples our queue to xterm's parse/render
 *    completion. A callback is delivered after the data is parsed AND rendered,
 *    and rendering is driven by the browser's frames — a throttled window, an
 *    occluded tab or a very large previous chunk delays it, and while it is
 *    delayed this queue refuses to hand xterm anything new. That is exactly the
 *    "typing sometimes has no echo for a while, then it catches up" symptom:
 *    the echo was sitting in our queue behind a callback that had not fired yet.
 *
 * So: order is preserved by APPENDING to one buffer and flushing it on a timer
 * (or immediately when the buffer is large). Nothing here waits for a write to
 * finish — xterm's own queue already serialises the chunks we hand it.
 *
 * Pure for the gate (`scripts/check-terminal-writer.mjs`): the scheduler and the
 * write sink are injected, no DOM, no timers at import time.
 */
/** Dependencies of {@link createTerminalWriter}. */
export interface TerminalWriterDeps {
    /** Hand one chunk to the terminal (xterm's `write`). Must not throw. */
    write: (text: string) => void;
    /** Schedule one flush; the default is `setTimeout(run, 0)`. */
    schedule?: (run: () => void) => unknown;
    /**
     * Largest string handed to `write` in one call.
     *
     * Joining a multi-megabyte backlog into ONE string would itself block the main
     * thread (and the join is O(total) on every flush), so a big queue is written
     * in pieces and the rest is scheduled immediately.
     */
    maxChunkChars?: number;
}
/** Handle returned by {@link createTerminalWriter}. */
export interface TerminalWriter {
    /** Append output; the returned value is ignored (kept for symmetry/tests). */
    push: (text: string) => void;
    /** Flush everything right now (tab closing, exit frame). */
    flush: () => void;
    /** Characters still waiting (diagnostics/tests). */
    pendingChars: () => number;
}
/** Default cap for one `write` call (256 Ki UTF-16 units). */
export declare const WRITER_MAX_CHUNK_CHARS: number;
/** Create one ordered, coalescing writer. */
export declare function createTerminalWriter(deps: TerminalWriterDeps): TerminalWriter;
