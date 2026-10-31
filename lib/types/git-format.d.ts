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
/**
 * Reverse git's C-style quoting of one porcelain path.
 *
 * `git status --porcelain` (without `-z`) quotes any path containing whitespace,
 * a quote, a backslash or a control character, and escapes the specials inside:
 * `"a\"b.txt"`, `"plain space.txt"`, `"ctl\001name.txt"`. Passing that field on
 * as if it were the path made every such file unusable in the SCM panel
 * (open/diff/stage asked for a literal filename with quotes in it) — and a space
 * in a name is common, not an exotic edge (2026-10 audit, A18-b).
 *
 * Unquoted input is returned unchanged. Octal escapes are decoded as BYTES and
 * only then interpreted as UTF-8: a multi-byte character can arrive as several
 * `\NNN` escapes and failing to group them would corrupt it.
 */
export declare function unquoteGitPath(path: string): string;
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
