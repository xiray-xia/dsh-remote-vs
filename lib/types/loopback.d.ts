/**
 * Loopback trust fence: socket address 127/8 or ::1 (incl. IPv4-mapped),
 * loopback Host header, and browser same-origin markers. X-Forwarded-For is
 * never trusted. Every /api/dsh-remote route enforces this.
 */
import type { IncomingMessage } from 'node:http';
export declare function isLoopbackRequest(request: IncomingMessage): boolean;
