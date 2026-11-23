/**
 * Terminal path links: find path-like tokens in a terminal line and turn them
 * into absolute remote paths (pure, no xterm/DOM).
 *
 * The terminal prints paths constantly (compiler errors, `ls`, `grep`, logs) and
 * the tree already knows how to reveal a folder over SFTP, so the missing piece
 * is only "which text is a path, and what absolute path does it mean". Both
 * questions are decided here; the xterm link provider and the store action are
 * thin wiring on top.
 *
 * Scope decisions (kept deliberately conservative — a wrong jump is worse than a
 * missing one):
 *  - absolute (`/opt/src/a.c`), home-relative (`~/build.log`) and relative
 *    tokens that contain a `/` (`v_sys/system/core.c`) are offered;
 *  - a `:line` / `:line:col` suffix is stripped (`src/a.ts:12:5` → `src/a.ts`);
 *  - URLs, flags (`--opt/x`) and pure numbers are not links;
 *  - resolution never guesses silently: it returns a CANDIDATE list, and the
 *    caller validates each candidate against the host before acting.
 */
/** One path-looking range inside a terminal line. */
export interface TerminalPathToken {
    /** 0-based index of the first character. */
    start: number;
    /** 0-based index of the LAST character (inclusive). */
    end: number;
    /** The path itself, with any `:line(:col)` suffix removed. */
    path: string;
}
/** Everything {@link resolutionCandidates} may use to anchor a relative token. */
export interface PathResolutionContext {
    /** Remote home directory, when knowable (derived from the SSH user). */
    home?: string;
    /** Shell working directory, when the shell reports it (OSC 7). */
    cwd?: string;
    /** Remote workspace roots on this host, most specific first. */
    roots?: readonly string[];
}
/** Collapse `//`, resolve `.`/`..` and drop a trailing slash (POSIX semantics). */
export declare function normalizeRemotePath(path: string): string;
/** Join a base directory and a relative token (POSIX, no trailing slash). */
export declare function joinRemotePath(base: string, token: string): string;
/** The parent directory of an absolute path (`/a/b/c` → `/a/b`; `/a` → `/`). */
export declare function parentDirectoryOf(path: string): string;
/** Whether `path` is `root` itself or lives under it. */
export declare function isWithinRoot(path: string, root: string): boolean;
/**
 * Every path-looking token of one terminal line, in order.
 *
 * Trailing sentence punctuation is trimmed rather than excluded beforehand, so
 * `see /opt/src/a.c.` links `a.c`; a location suffix is removed before that trim
 * so `a.c:12` links `a.c` (not `a.c:12`).
 */
export declare function findTerminalPathTokens(text: string): TerminalPathToken[];
/**
 * Absolute candidates for one token, in the order they should be validated.
 *
 * The caller stats each in turn (bounded) and acts on the first hit, which is
 * why the order matters: the shell's reported cwd beats a workspace-root guess,
 * and the home directory is the last resort (most relative paths a shell prints
 * are relative to where the user is).
 */
export declare function resolutionCandidates(token: string, ctx?: PathResolutionContext): string[];
