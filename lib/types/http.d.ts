/**
 * Small JSON body/response helpers for the /api/dsh-remote route family.
 */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
/**
 * Outcome of one bounded body read.
 *
 * The discriminant exists because `null` collapsed three very different cases
 * (empty, malformed, too large) into one, and the caller could only answer them
 * all the same way. `too-large` is what a 413 should be built from.
 */
export type JsonBodyResult = {
    kind: 'ok';
    value: unknown;
} | {
    kind: 'empty';
} | {
    kind: 'invalid';
} | {
    kind: 'too-large';
    maxBytes: number;
};
/**
 * Bounded body reader with a truthful outcome.
 *
 * Oversize no longer destroys the request immediately: returning early from the
 * `for await` loop would tear the socket down, and the caller's 400/413 then
 * reaches the client as a connection reset (the reported A11 symptom). The body
 * is drained instead, up to `DRAIN_LIMIT_BYTES`, so the route can answer with a
 * readable JSON error; an absurd stream is still cut off with `destroy()`.
 */
export declare function readJsonBodyResult(req: IncomingMessage, opts?: {
    maxBytes?: number;
    objectOnly?: boolean;
}): Promise<JsonBodyResult>;
/**
 * Lenient bounded body reader: parse a request body as JSON, or null on an
 * empty body, invalid JSON, or a body past maxBytes (default 64 KiB).
 *
 * Facade over {@link readJsonBodyResult} for the existing route call sites; new
 * code should use the result form so `too-large` can be answered with a 413.
 */
export declare function readJsonBody(req: IncomingMessage, opts?: {
    maxBytes?: number;
    objectOnly?: boolean;
}): Promise<unknown | null>;
/** Write one JSON response. */
export declare function writeJson(res: ServerResponse, status: number, body: unknown, headers?: OutgoingHttpHeaders): void;
/**
 * Write one failed-operation response, tagging a budget that merely ran out.
 *
 * `code: 'deadline'` is what lets the browser tell "this one request was too
 * slow" from "the link is down": the client keeps the status chip green and the
 * editor editable, while the operation still fails with a readable reason. Only
 * the error object carries that distinction — the message is prose, and matching
 * on prose stops working the moment the sentence changes.
 */
export declare function writeRouteError(res: ServerResponse, error: unknown): void;
