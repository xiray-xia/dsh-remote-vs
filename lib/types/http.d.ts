/**
 * Small JSON body/response helpers for the /api/dsh-remote route family.
 */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
/**
 * Lenient bounded body reader: parse a request body as JSON, or null on an
 * empty body, invalid JSON, or a body past maxBytes (default 64 KiB).
 */
export declare function readJsonBody(req: IncomingMessage, opts?: {
    maxBytes?: number;
    objectOnly?: boolean;
}): Promise<unknown | null>;
/** Write one JSON response. */
export declare function writeJson(res: ServerResponse, status: number, body: unknown, headers?: OutgoingHttpHeaders): void;
