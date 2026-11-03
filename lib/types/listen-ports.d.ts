/**
 * Remote listening-TCP-socket enumeration for the port panel.
 *
 * One bounded POSIX one-liner does the work: `ss` (iproute2, every modern
 * Linux) first, `netstat` as the fallback (older Linux, and macOS with a
 * different address spelling), and an explicit `none` when neither exists. The
 * answer is a POOL of three facts the panel must keep apart:
 *
 *  - `none` / `unknown` are "cannot enumerate", never "no ports are open";
 *  - a tool that ran but produced nothing recognizable is a parse failure, not
 *    an empty machine;
 *  - process names are only visible for the invoking user's own processes
 *    (`ss -p` is allowed for everyone, but the kernel hides other users'
 *    sockets), so a missing name is UNKNOWN, not "not a service".
 *
 * Pure functions only (command builder + parser) so the gate can feed real
 * sample outputs; the route owns the exec round trip and its deadline.
 */
import type { RemoteListenPortsResult } from './protocol.ts';
/** Prefix of every control line the probe prints (also the "did it answer" proof). */
export declare const LISTEN_PORTS_MARK = "@@RVS-PORTS";
/**
 * Budget for the whole probe. A handful of local commands over one channel; if
 * `ss` hangs (a stuck kernel table), the route answers with the exec deadline
 * instead of holding the panel's refresh forever.
 */
export declare const LISTEN_PORTS_TIMEOUT_MS = 15000;
/**
 * Most listeners one probe reports. A container host or a dev box running a
 * port scanner can have thousands; the panel is a picker, not an inventory.
 */
export declare const LISTEN_PORTS_MAX = 500;
/**
 * The remote probe line.
 *
 * `if/elif/fi` rather than `a && b || c` chains: the shell's operator
 * precedence would make a failing `ss` fall through into `netstat`'s branch in
 * ways that depend on the last command's status, and one missing tool would be
 * indistinguishable from a tool that ran and failed.
 *
 * `-p` is requested first and silently degrades to `-n`: it only ADDS process
 * names, and it is allowed for a non-root user (the kernel just omits other
 * users' sockets). `netstat -an` is the last resort for macOS, whose `-l` is
 * not the Linux spelling; the parser understands both the colon and the dotted
 * `addr.port` form.
 */
export declare function listenPortsCommand(): string;
/**
 * Parse one probe's stdout into the panel's result.
 *
 * @param stdout - the probe's standard output (both tools plus markers).
 * @param exitCode - the exec exit code; a non-zero run with no `end` marker is
 *   reported as `unknown`, because an interrupted probe proves nothing about
 *   the ports it never reached.
 */
export declare function parseListenPorts(stdout: string, exitCode: number | null): RemoteListenPortsResult;
