/**
 * Remote process snapshots for the monitor page.
 *
 * Same model as `listen-ports.ts`: one bounded POSIX probe (GNU `ps`, a BSD
 * `ps` fallback, then an explicit `none`), with all parsing done host-side so
 * the browser only receives a bounded table. A process is never killed by a
 * command assembled in the browser: the route validates the PID against the
 * latest snapshot and builds the one signal command here.
 */
import type { RemoteProcessesResult } from './protocol.ts';
/** Marker proving which probe branch actually ran. */
export declare const PROCESSES_MARK = "@@RVS-PROCS";
/** Budget for the whole probe; a stuck process table must not pin a channel. */
export declare const PROCESSES_TIMEOUT_MS = 15000;
/** Hard cap on rows per snapshot (a container host can have thousands). */
export declare const PROCESSES_MAX = 500;
/** Longest command string sent to the browser per row. */
export declare const PROCESS_COMMAND_MAX = 300;
/**
 * One bounded probe.
 *
 * GNU first (`--sort` + `etimes`), then the portable `ps aux` table for BSD /
 * old systems (`ppid` and elapsed time are unknown there). The marker
 * line is printed BEFORE the table so an interrupted probe is distinguishable
 * from a genuinely empty one; the final marker lets the parser reject a
 * truncated run.
 */
export declare function processesCommand(max?: number): string;
/** A kill signal the route accepts; never an arbitrary string from the client. */
export type KillSignal = 'TERM' | 'KILL';
export declare function isKillSignal(value: unknown): value is KillSignal;
/** Assert a PID a process snapshot may contain (1 is the remote init). */
export declare function assertProcessPid(value: unknown): number;
/**
 * Build the one kill command. The PID has already passed the snapshot check;
 * single-quoting it keeps the command shape uniform with every other builder.
 */
export declare function killCommand(pid: number, signal: KillSignal): string;
/**
 * Parse one probe. `exitCode === null` (channel died) or a missing end marker
 * means `unknown`, never an empty process table.
 */
export declare function parseProcesses(stdout: string, exitCode: number | null): RemoteProcessesResult;
