import { type ClientChannel, type SFTPWrapper } from 'ssh2';
import type { RemoteStore } from './store.ts';
import { DeadlineError } from './timeouts.ts';
import type { RemoteConnectionStatus, RemoteExecResult } from './protocol.ts';
/**
 * The budget-out type lives in `timeouts.ts` (both halves need it); re-exported
 * here because existing callers and the browse gate import it from the pool.
 */
export { DeadlineError };
/** Whether `error` is a transport-level failure worth showing as a link problem. */
export declare function isConnectionFailure(error: unknown): boolean;
export interface ExecOptions {
    timeoutMs?: number;
    /**
     * Live sink for the command's output (the streaming network verbs). Called
     * with already-decoded text so a multi-byte character split across ssh2
     * chunks is never mangled; the accumulated `stdout`/`stderr` on the result
     * keep the same bytes.
     */
    onData?: (stream: 'out' | 'err', text: string) => void;
    /** Receives the cancel handle once the run is under way (see `cancel`). */
    onCancel?: (cancel: () => void) => void;
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
    /** Per-alias BROWSE SFTP session (see withBrowseSftp). */
    private readonly browsed;
    /** Per-alias connection health for the browser's status chip (see status). */
    private readonly health;
    constructor(store: RemoteStore);
    /** Drop one pooled connection (call after host update/delete). */
    drop(alias: string): void;
    /** Close every pooled connection. */
    dispose(): void;
    /**
     * Forget one alias's connection HEALTH (host edited/removed), not just its
     * connection.
     *
     * `drop` is also the idle eviction path, so it must keep the health record
     * (idle-closed is not an error). Only a host mutation discards what the pool
     * learned about that alias.
     */
    forget(alias: string): void;
    /**
     * Per-alias connection health for the browser's status indicator.
     *
     * Read-only and dial-free: it reports what the pool already knows, so the
     * indicator's poll never creates a connection as a side effect.
     */
    status(): RemoteConnectionStatus[];
    /** Record a successful dial or transport-level operation. */
    private markOk;
    /** Record a connection-level failure the status chip should show. */
    private markError;
    /**
     * Record one operation's failure, EXCEPT when the budget simply ran out.
     *
     * A deadline means "this request did not answer in time", not "the link is
     * down": the connection can be perfectly healthy and merely slow (a huge
     * directory, an 8 MiB read on a thin link, a cold filesystem). Painting the
     * chip red used to flip the editor to read-only and block saving — a false
     * alarm with a real cost. Real transport failures still arrive as transport
     * errors (`close`, `No response from server`, a channel open failure), and
     * those keep marking; the operation itself still fails either way.
     */
    private noteOpFailure;
    /**
     * Probe one connection and record the outcome for the status indicator.
     *
     * "Test" must PROVE the link, not report that a pooled Client object exists:
     * the old version answered ok without any traffic, so a retry against a
     * half-open link painted the host green until the next real request failed.
     *
     * It must also NOT disturb the pool: this is what host settings' "test" and
     * the chip's retry run, and the host being tested is often the one the user is
     * working on (a terminal open, a transfer running). So a live connection gets
     * a real round trip on itself (a trivial bare command under the control
     * deadline), and only a COLD alias dials. Tearing the connection down instead
     * would end every channel on it, including the terminal that the user opened
     * to debug the flaky host.
     */
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
    /**
     * Run one bulk-transfer callback with a dedicated SFTP session, plus extra
     * channel windows on demand (`addChannel`).
     *
     * Why extra channels: ssh2 (Channel.js `MAX_WINDOW`) and OpenSSH cap ONE SSH
     * channel's window at 2 MiB, so a single channel can never hold 8 MiB of READs
     * in flight however much concurrency the caller asks for; the rest queue
     * client-side. Each extra session is another 2 MiB window. Measured against a
     * real host (96 MiB file, 256 KiB chunks, same total concurrency):
     * 1 channel 28.6 MiB/s, 2 channels 46.1, 4 channels 51.3 — two channels take
     * most of the gain, four cost twice the channels for little more. Uploads
     * showed no such gain (server-side write bound: 46.0 → 50.4 MiB/s), so only
     * downloads spread out.
     *
     * `addChannel` is best-effort and late on purpose: a small download must not
     * pay for a second channel, so the caller opens one only after it has the
     * size. It never queues for a channel slot (a 30 s wait would stall a body that
     * is already streaming) and a late call after the callback settled is a no-op.
     * Every session opened here is closed, and every slot/hold released, when the
     * callback settles — including a partially successful `addChannel`.
     *
     * There is no wall-clock deadline of its own: streaming is progress-bounded by
     * the caller, and the caller also bounds the one-shot SFTP calls it makes
     * around the stream (metadata phase, optional channel opens), because nothing
     * there produces progress to watch.
     */
    withTransferSftp<T>(alias: string, fn: (sftp: SFTPWrapper, addChannel: () => Promise<SFTPWrapper | undefined>) => Promise<T>): Promise<T>;
    /**
     * Run one callback on this alias's long-lived BROWSE SFTP session.
     *
     * Why: every list/stat/read used to open its own SFTP session, which is a
     * whole channel-open round trip BEFORE the operation's own round trip. A single
     * folder open is one list plus a stat per entry the explorer probes, and the
     * panel's revision refresh re-lists every open directory, so that open/close
     * churn sat directly on the click-to-pixels path. The session is shared by
     * every browse request for the alias; ssh2 multiplexes concurrent requests
     * over one channel by packet id (the same request map fastGet/fastPut use).
     *
     * Only read-only browse operations use it (`RemoteFiles.list/stat/read`):
     * writes, uploads and downloads keep their own short-lived session, so a
     * mutation never inherits a channel that a previous request may have left in
     * an odd state.
     *
     * The session holds one channel slot and one connection hold while it exists,
     * which is what a per-request session took too, so peak channel usage against
     * the server's MaxSessions does not change. The trade-off is that the slot
     * stays PARKED for up to `BROWSE_IDLE_MS` after the last request: the extras a
     * bulk transfer asks for use `tryAcquireSlot`, so they never wait on it.
     */
    withBrowseSftp<T>(alias: string, fn: (sftp: SFTPWrapper) => Promise<T>, opts?: SftpOptions): Promise<T>;
    /** Upload one local file to an absolute remote path (parallel fastPut). */
    putFile(alias: string, localPath: string, remotePath: string): Promise<void>;
    /**
     * Open one SFTP session under its own deadline.
     *
     * ssh2 has no channel-open timeout: a server that never answers leaves this
     * promise pending forever, which pins the connection's hold count and blocks
     * idle re-arming (the "SSH looks dead" symptom) while the HTTP request hangs.
     *
     * The deadline is spelled out here instead of wrapped around the promise
     * because the ANSWER can arrive after it: `conn.sftp`'s callback is the only
     * place that can still see the session, and a late one would otherwise leak a
     * server-side channel that no slot or hold accounts for (the caller has long
     * returned its own and moved on).
     */
    private openSession;
    /**
     * Take the browse channel for one operation (open it on first use).
     *
     * The returned lease counts as one in-flight operation; the caller's `finally`
     * calls touchBrowse(). An open failure takes neither a slot nor a hold, so a
     * failed host does not leave the pool's accounting skewed.
     */
    private leaseBrowse;
    /**
     * Open the browse session: a channel slot + a connection hold + the SFTP
     * session itself, all released together by evictBrowse().
     */
    private openBrowse;
    /** One completed browse operation: idle-close the channel when it is unused. */
    private touchBrowse;
    /**
     * Close the browse session and give its slot and hold back. Idempotent; every
     * way the session can end (idle, open failure, channel close, connection drop)
     * goes through here so the accounting cannot drift.
     *
     * `expected` ties the eviction to ONE session object: a timer or a channel
     * `close` event that fires after the state was already replaced must not close
     * its successor. Callers that end the connection (drop/dispose) omit it.
     */
    private evictBrowse;
    private browseState;
    /**
     * Take one channel slot for `alias`, waiting FIFO when the limit is reached.
     * The wait is bounded: waiting forever behind a peer that never finishes is
     * worse than a readable error naming the cause and what to do about it.
     */
    private acquireSlot;
    /**
     * Take one channel slot only if one is free RIGHT NOW; never queue.
     *
     * Optional work (a bulk transfer's second channel) must not wait behind
     * `CHANNEL_WAIT_MS` of other operations: a "best effort" extra channel that
     * delays the body of an already-streaming download by 30 s is worse than the
     * one channel the transfer would have used anyway. A queued waiter also blocks
     * the attempt on purpose — it has been waiting longer, and stealing its slot
     * would just move the wait.
     */
    private tryAcquireSlot;
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
    /**
     * The ssh2 client factory.
     *
     * A seam, not a preference: `dial` is the only place that has to react to
     * "connect emitted close but never error", and a fake client is the only way a
     * self-check can produce that shape without a real server. Production never
     * overrides it.
     */
    private makeClient;
    private dial;
}
