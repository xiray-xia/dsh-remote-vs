/**
 * Outbound proxy support for SSH dials.
 *
 * Why this is not just `HTTP_PROXY`: ssh2 dials a raw TCP socket, and the
 * harness's proxy plumbing (`@deepseek-ai/dsh-http-proxy`) only wraps `fetch`,
 * so a host that can only be reached through a proxy needs the tunnel built
 * here. Three flavours, in the order a user meets them:
 *
 *  - `http` — `CONNECT host:port`, optional `Proxy-Authorization: Basic …`;
 *  - `socks5` — greeting / optional user+password sub-negotiation / CONNECT;
 *  - jump (`ProxyJump` / `ProxyCommand ssh -W`) — NOT dialled here: the pool
 *    opens a `direct-tcpip` channel on ANOTHER pooled connection and hands it
 *    to ssh2 as its socket. This module only parses those specs into a target.
 *
 * **Error taxonomy is the point.** "The proxy refused the tunnel" and "the
 * target closed the port" and "your password is wrong" all fail the dial, and
 * the user debugs the wrong thing if they all read "connection failed". Each
 * failure therefore leaves as a `ProxyError` with a stable `reason` and one
 * actionable sentence.
 *
 * **Bytes are never lost.** A proxy may send tunnel bytes in the same packet as
 * its handshake reply; everything read past the handshake is pushed back onto
 * the socket before it is handed to ssh2, or the SSH banner would be swallowed
 * and the handshake would stall.
 *
 * @module
 */
import { type Socket } from 'node:net';
/** Proxy flavours this plugin dials itself. A jump host is not one of them. */
export type ProxyKind = 'http' | 'socks5';
/** One validated proxy endpoint (secrets included: host-side only). */
export interface ProxyConfig {
    kind: ProxyKind;
    /** Proxy hostname / IPv4 / IPv6 literal. */
    host: string;
    port: number;
    /** Basic auth (http) or user/password sub-negotiation (socks5). */
    username?: string;
    password?: string;
}
/** A `ProxyJump` / `ProxyCommand ssh -W` hop, parsed but not yet resolved. */
export interface JumpTarget {
    /** Login user named in the spec, when it had one. */
    user?: string;
    host: string;
    port: number;
}
/** Every way a proxy dial can fail, as a stable value (not a message). */
export type ProxyFailure = 
/** The proxy itself could not be reached (TCP refused/unreachable). */
'unreachable'
/** The proxy accepted TCP but never finished talking to us. */
 | 'timeout'
/** The proxy demanded credentials we do not have, or rejected ours. */
 | 'auth'
/** The proxy answered, and refused the tunnel (bad status / SOCKS reply). */
 | 'refused'
/** The proxy answered with something that is not the protocol we speak. */
 | 'protocol'
/** The destination is not a legal target (bad port, empty host). */
 | 'target';
/** A proxy dial failure that knows which layer broke. */
export declare class ProxyError extends Error {
    readonly reason: ProxyFailure;
    /** Which proxy kind was attempted (absent for target validation). */
    readonly kind?: ProxyKind | undefined;
    constructor(reason: ProxyFailure, message: string, 
    /** Which proxy kind was attempted (absent for target validation). */
    kind?: ProxyKind | undefined);
}
/**
 * Validate one proxy endpoint.
 *
 * @param input - value as it arrived from the browser / store file.
 * @returns the normalized config (empty credentials dropped).
 * @throws {ProxyError} `target` when a field is unusable, with the field named.
 */
export declare function normalizeProxy(input: unknown): ProxyConfig;
/** True when a value looks like a proxy config at all (shape, not validity). */
export declare function looksLikeProxy(value: unknown): boolean;
/**
 * Parse an OpenSSH `ProxyJump` value (`jump`, `user@jump:2222`, `a,b`).
 *
 * Only a single hop is supported: the pool builds the tunnel on one existing
 * pooled connection, and a chain would need nested channels whose failure modes
 * we cannot explain to the user yet. Multi-hop is therefore a named refusal
 * rather than a silent half-feature.
 */
export declare function parseProxyJump(value: string): {
    ok: true;
    target: JumpTarget;
} | {
    ok: false;
    reason: string;
};
/** What a `ProxyCommand` line means to this plugin. */
export type ProxyCommandPlan = {
    kind: 'proxy';
    proxy: Omit<ProxyConfig, 'username' | 'password'>;
} | {
    kind: 'jump';
    target: JumpTarget;
} | {
    kind: 'unsupported';
    reason: string;
};
/**
 * Map the ProxyCommand forms users actually write onto a tunnel we can build.
 *
 * Recognised: `ssh … -W %h:%p [user@]host`, `nc -X connect -x host:port %h %p`
 * (http), `nc -x host:port %h %p` (socks5), `ncat --proxy … --proxy-type …`.
 * Everything else is refused by name — a ProxyCommand is a shell command, and
 * running one from a browser-supplied config is not a feature this plugin
 * offers.
 */
export declare function parseProxyCommand(command: string): ProxyCommandPlan;
/** How this module reaches a TCP socket (a seam for the gates). */
export type SocketFactory = (host: string, port: number) => Socket;
/** One tunnel request. */
export interface OpenProxyOptions {
    /** Total budget for connect + handshake (default 8000 ms). */
    timeoutMs?: number;
    /** Test seam: replaces `net.createConnection`. */
    connect?: SocketFactory;
}
/** Default budget: a proxy that cannot answer in this long is not worth waiting for. */
export declare const PROXY_TIMEOUT_MS = 8000;
/**
 * Dial `host:port` through `proxy` and hand back the tunnelled socket.
 *
 * The caller owns the socket (ssh2 takes it as its transport). Everything read
 * past the handshake is pushed back, so the SSH banner is not swallowed.
 *
 * @throws {ProxyError} when the proxy layer — not SSH — is what failed.
 */
export declare function openProxySocket(proxy: ProxyConfig, host: string, port: number, options?: OpenProxyOptions): Promise<Socket>;
