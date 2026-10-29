/** What a streamed push should do: remembered refspec ('' = plain) + remote. */
export interface PushTarget {
    refspec: string;
    remote: string;
}
/**
 * The commands one network verb runs, in order.
 *
 * Pure so the gate can pin the sequence: sync is pull-then-push (the historical
 * order), and a push with a refspec must not fall back to the bare form.
 */
export declare function networkCommands(root: string, kind: 'fetch' | 'pull' | 'push' | 'sync', push: PushTarget): string[];
/** Live-log cap: keep the TAIL, because the head of a long push is never the point. */
export declare const EXEC_OUTPUT_CAP = 200000;
/** Append one decoded chunk, folding `\r` progress and keeping the TAIL. */
export declare function appendExecOutput(previous: string, chunk: string, cap?: number): string;
/**
 * Split an SSE buffer into complete frames and the incomplete tail.
 *
 * A chunk can end in the middle of `data: {...}` or between the two newlines
 * that terminate a frame, so the caller must carry `rest` into the next read.
 */
export declare function takeSseFrames(buffer: string): {
    frames: string[];
    rest: string;
};
/**
 * One SSE frame's JSON payload; `undefined` for comments (heartbeats), empty
 * frames and malformed JSON — a broken heartbeat must not kill the stream.
 */
export declare function parseSseFrame(frame: string): unknown | undefined;
/** `m:ss` (or `h:mm:ss`) for the running timer. */
export declare function formatElapsed(ms: number): string;
/**
 * The network verbs' budget: at least 20 minutes, or twice the configured git
 * budget when that is larger, never past the host's 30-minute ceiling.
 */
export declare function networkBudgetMs(gitTimeoutMs: number): number;
