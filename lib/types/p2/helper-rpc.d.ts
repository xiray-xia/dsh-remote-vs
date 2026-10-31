import { z } from 'zod';
import type { RemoteHostEntry } from '../protocol.ts';
export interface RpcDialOpts {
    entry: RemoteHostEntry;
    /** Absolute remote path of the helper executable. */
    helperPath: string;
    /** Expected sha256 of the helper binary (verified at hello). */
    helperHash: string;
    /** Remote default workspace for the hello handshake. */
    workspace: string;
    leaseMs?: number;
}
export interface RpcHello {
    protocol: number;
    kind: string;
    hash: string;
    platform: string;
    nodeVersion: string;
}
/**
 * Close each resource, ignoring failures — and keeping going.
 *
 * Teardown runs while an error is already unwinding: one resource that throws on
 * close must not stop the NEXT one from being released (that skipped socket is
 * exactly the leak this exists to prevent). Exported so the gate can drive the
 * real behaviour with fake resources; there is no transport to stub locally.
 */
export declare function closeQuietly(resources: ReadonlyArray<{
    close?: () => void;
    end?: () => void;
}>): void;
export declare class RpcConnection {
    private readonly opts;
    private conn;
    private channel;
    private peer;
    private readyPromise;
    private heartbeat;
    private dead;
    private disposed;
    /**
     * The helper's own error output, kept so its reason survives.
     *
     * Nothing read this stream before, so a helper that died on startup took its
     * explanation with it and the caller only ever saw "channel closed". Reading
     * it also removes a real hazard: an undrained stderr pipe blocks the child
     * once its buffer fills. The tail is bounded because a chatty helper must not
     * grow host memory.
     */
    private stderrTail;
    /** Per-connection in-flight cap; see MAX_IN_FLIGHT. */
    private readonly gate;
    constructor(opts: RpcDialOpts);
    /** True while the channel is open and no fatal error occurred. */
    get alive(): boolean;
    /** Whatever the helper last wrote to stderr — empty when it said nothing. */
    get diagnostics(): string;
    get ready(): Promise<RpcHello>;
    /** Send one helper operation (mirrors SshConnection.request for fs-ssh). */
    request<T>(method: string, params: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T>;
    /** Race one request against the stall deadline. */
    private withDeadline;
    /**
     * Dial again under the same identity.
     *
     * The `ssh` provider handed to fs-ssh captures THIS object, so replacing the
     * instance would strand every view holding it; re-opening in place keeps those
     * closures valid while giving the retry a fresh channel.
     */
    private reconnect;
    dispose(): Promise<void>;
    private peerReady;
    /**
     * Release the current transport, whatever state it is in.
     *
     * Shared by `reconnect()`, a failed `open()` and `dispose()` because all three
     * carry the same obligation: afterwards no ssh session, channel or heartbeat may
     * survive. A half-open transport is a real leak — the socket lives until the
     * remote's keepalive gives up, and the next attempt opens a SECOND session.
     * `stderrTail` is cleared too: it describes the connection being torn down, and
     * keeping it would attribute the NEXT failure to the previous transport's error
     * output.
     */
    private teardownTransport;
    private open;
    /** The part of {@link open} that runs once the socket object exists. */
    private dialAndHello;
    private invalidate;
}
