import { type ClientChannel, type SFTPWrapper } from 'ssh2';
import type { RemoteStore } from './store.ts';
import type { RemoteExecResult } from './protocol.ts';
export interface ExecOptions {
    timeoutMs?: number;
    /**
     * Internal: send the line exactly as given — no session wrapper, and no group
     * kill when it times out. Only the two commands the pool sends on its own
     * behalf (the setsid probe and the group kill) use it; wrapping those would
     * recurse into the machinery that dispatched them.
     */
    bare?: boolean;
}
export interface ShellOptions {
    cols?: number;
    rows?: number;
}
export interface SftpOptions {
    /**
     * Wall-clock cap for the callback body. `0` disables it for an operation that
     * is bounded by progress instead (a bulk upload: see putFile); a fixed wall
     * clock there only turns a healthy transfer on a slow link into a timeout.
     * Omitted means the per-operation default. The session-open deadline applies
     * either way, so a server that never answers cannot pin the connection.
     */
    timeoutMs?: number;
}
export declare class RemotePool {
    private readonly store;
    private readonly conns;
    /** TOFU fingerprints observed this process (alias -> sha256). */
    private readonly hostKeys;
    /** Per-alias `setsid --wait` capability, probed once (see supportsSetsid). */
    private readonly setsidProbes;
    /** Per-alias channel slots and the queue waiting for one (see acquireSlot). */
    private readonly slots;
    constructor(store: RemoteStore);
    /** Drop one pooled connection (call after host update/delete). */
    drop(alias: string): void;
    /** Close every pooled connection. */
    dispose(): void;
    /** Test a connection without disturbing the pool. */
    test(alias: string): Promise<{
        ok: boolean;
        banner?: string;
        error?: string;
        durationMs: number;
    }>;
    /**
     * Run one non-interactive command.
     *
     * The command needs a channel slot: a burst of SCM or search calls is exactly
     * how a host runs past `MaxSessions`, where the surplus channels fail instead
     * of queueing. The pool's own housekeeping (`bare`: the setsid probe and the
     * group kill) is exempt — a kill that waits behind user traffic would be a
     * worse bug than the one it fixes.
     */
    exec(alias: string, command: string, opts?: ExecOptions): Promise<RemoteExecResult>;
    /** The exec body, run while the caller already holds a channel slot. */
    private runExec;
    /** Open an interactive PTY shell. The caller owns the channel lifecycle. */
    shell(alias: string, opts?: ShellOptions): Promise<ClientChannel>;
    /** Open one exec channel. The caller owns the channel lifecycle. */
    execChannel(alias: string, command: string): Promise<ClientChannel>;
    /** Run one callback with a fresh SFTP session (closed afterwards). */
    withSftp<T>(alias: string, fn: (sftp: SFTPWrapper) => Promise<T>, opts?: SftpOptions): Promise<T>;
    /** Upload one local file to an absolute remote path (parallel fastPut). */
    putFile(alias: string, localPath: string, remotePath: string): Promise<void>;
    /**
     * Take one channel slot for `alias`, waiting FIFO when the limit is reached.
     * The wait is bounded: waiting forever behind a peer that never finishes is
     * worse than a readable error naming the cause and what to do about it.
     */
    private acquireSlot;
    /** Give a slot back, handing it straight to the longest-waiting operation. */
    private releaseSlot;
    private slotState;
    /**
     * Whether this alias offers a util-linux-style `setsid --wait` — the only
     * shape that both detaches the command into its own session AND reports its
     * exit code (p2/ssh-proc.ts:7-21 learned that plain `setsid` double-forks and
     * the channel then reports the wrapper's exit 0, which would turn every exit
     * fact into fiction). The probe also verifies status propagation, so a broken
     * setsid fails it instead of quietly corrupting exit codes.
     *
     * Probed once per alias: the probe is a whole extra channel, and exec is the
     * hot path (SCM polling, search, agent tools). A remote without a compatible
     * setsid keeps the pre-existing behaviour, where a timeout can only close the
     * channel, and says so in the log.
     *
     * Only SUCCESS is remembered. A failed probe means "this host has no
     * setsid OR this one call did not get through", and folding the second case
     * into the first would be permanent: a single transient blip — a dropped
     * connection, a 15 s probe timeout on a slow link — would silently switch the
     * alias to the unwrapped path for the rest of the process, i.e. quietly
     * disable the kill this wrapper exists to perform. Every other backoff in
     * this codebase retries rather than blacklisting; so does this one now.
     */
    private supportsSetsid;
    /** Hold the connection against idle eviction (balanced by release). */
    private hold;
    private release;
    private acquire;
    private dial;
}
