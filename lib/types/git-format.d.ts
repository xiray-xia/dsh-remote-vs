/**
 * Shared git helpers: shell-safe command builders + output parsers. Pure
 * functions, zero dependencies — imported by the browser half (git over the
 * existing exec route) and reusable by any host-side caller.
 */
import type { GitBranch, GitCommit, GitShow, GitStatus } from './protocol.ts';
/** Maximum commits per log call. */
export declare const GIT_LOG_MAX = 200;
/** Wrap a value for POSIX sh single-quote context. */
export declare function shQuote(value: string): string;
/** Assert an absolute POSIX path (no shell escapes possible after shQuote). */
export declare function assertRemoteDir(path: string): string;
/** Assert a safe git ref/branch/hash (strict charset, no shell metachars). */
export declare function assertRef(ref: string): string;
/** Branch + porcelain status in one call. */
export declare function statusCommand(workdir: string): string;
/** Structured log for the graph renderer. */
export declare function logCommand(workdir: string, max: number, branch?: string): string;
/** Local branch list. */
export declare function branchesCommand(workdir: string): string;
/** Full message of one commit. */
export declare function messageCommand(workdir: string, ref: string): string;
/** Diffstat of one commit. */
export declare function statCommand(workdir: string, ref: string): string;
/** True when stderr reports a non-repository / missing git. */
export declare function gitFailed(stderr: string): string | undefined;
/** Parse `status --porcelain=v1 -b` into branch + file rows. */
export declare function parseStatus(stdout: string): GitStatus;
/** Parse the \x1f/\x1e log format into commits. */
export declare function parseLog(stdout: string): GitCommit[];
/** Parse for-each-ref branch lines. */
export declare function parseBranches(stdout: string, current: string): GitBranch[];
/** Split a raw `%B` message into its subject line and the body below it. */
export declare function parseMessage(text: string): {
    subject: string;
    body: string;
};
/** Assemble commit detail from message + stat outputs. */
export declare function parseShow(hash: string, message: string, stat: string): GitShow;
