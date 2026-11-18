/**
 * One-shot notices the Host hands to the browser on the next JSON response.
 *
 * Why a queue instead of a push channel: the Host half is request/response, and
 * an event that matters (an automatic helper push) is produced *inside* a
 * request the browser already made — the remote operation that needed a dial.
 * Attaching the notice to that response reaches the surface that caused it with
 * no extra connection, and a queue means a push during a streaming response or
 * a failed request still arrives on the next successful one.
 */
export interface HostNotice {
    /** What happened. Only kinds the client knows how to render belong here. */
    kind: 'helper-pushed';
    /** Host alias the helper was pushed to. */
    alias: string;
    /** Helper version that was installed. */
    version: string;
}
/** Queue one notice for the next JSON response. */
export declare function pushHostNotice(notice: HostNotice): void;
/** Take everything queued; the caller attaches it and the queue starts over. */
export declare function drainHostNotices(): HostNotice[];
