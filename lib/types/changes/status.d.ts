/**
 * Remote command builders and reply parsers for the session change ledger.
 *
 * Why this module exists: `@deepseek-ai/dsh-workspace-changes` (and the first
 * cut of this plugin) answer "what did this session change?" by staging the
 * whole worktree (`git add --all`) and diffing two trees. On a monorepo the
 * staging step alone ran past 40s without finishing, so the panel never left
 * "正在统计". Measured on a real AOSP checkout with a warm cache, same repo:
 *
 * | command                                      | time   |
 * | -------------------------------------------- | ------ |
 * | `git diff-files --name-status -z`            | 1.40s  |
 * | `git status --porcelain -z -uno`             | 1.67s  |
 * | `git ls-files --others --exclude-standard -z`| 11.25s |
 * | `git add --all` (the old baseline)           | >40s   |
 *
 * So the cheap path is: ask git *which* paths changed (status), read only those
 * paths' bytes, and diff locally. Cost becomes proportional to what the session
 * touched instead of to the size of the repository.
 *
 * Everything here is pure string in / string out — no pool, no fs, no DSH
 * import — so the recorder owns all the IO and this half stays testable.
 *
 * ## Paths, quoting, exit codes
 *
 * Every path is a POSIX absolute path on the host and every shell word is
 * single-quoted ({@link shq}); a path that reaches a shell unquoted is a bug.
 * A command exits `0` when it produced a reply, `90` when its root directory
 * does not exist (a stale alias), `92` when the host has no `base64`, and
 * otherwise with git's own exit status. The per-file problems of the read
 * commands (missing, unreadable, too big) are *not* failures: they are flags
 * inside a successful reply.
 *
 * ## Read reply wire format
 *
 * One block per requested path, in request order:
 *
 * ```
 * @@RVS-FILE <base64(path)> ok@@
 * <base64(content)>
 * @@RVS-FILE <base64(path)> big@@
 * @@RVS-FILE <base64(path)> absent@@
 * ```
 *
 * - Paths travel base64-encoded in the marker so spaces, quotes, CJK and even
 *   newlines cannot break the framing; content travels base64-encoded on the
 *   single line after the marker so NUL bytes and `\r\n` survive a text-only
 *   transport (one line, no wrapping — the shell strips base64's newlines).
 * - `ok` is followed by exactly one content line. An empty file is an empty
 *   content line (a bare `\n` after the marker line).
 * - `big` means "not transferred": the file alone is over `capBytes`, or the
 *   running total would pass `totalCapBytes`.
 * - `absent` means the path is not there *or* could not be read (permissions,
 *   a directory, a dangling blob); the recorder treats both as "no content".
 *
 * Binary detection is deliberately done in {@link parseReads} (any NUL byte in
 * the decoded content) rather than in the shell: one definition of "binary" for
 * every caller, and no dependence on `grep`/`od` behaviour across hosts.
 */
/** What happened to one path in this session. */
export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';
/** One changed path, relative to the session root. */
export interface StatusEntry {
    path: string;
    status: ChangeStatus;
}
/** What one read asked for and what came back. */
export interface ReadResult {
    /** Decoded text, or null when nothing usable was transferred. */
    text: string | null;
    /** Withheld because of a size cap (single file or the running total). */
    truncated: boolean;
    /** The content contains a NUL byte, so it is not text. */
    binary: boolean;
    /** Not there, or unreadable. */
    absent: boolean;
    /**
     * Modification time in whole seconds (worktree reads only).
     *
     * A large file whose bytes were withheld can still be compared by mtime: two
     * equal mtimes mean the session did not touch it, which is the difference
     * between a clean list and one padded with every big file the checkout
     * happens to carry. Zero when the host could not answer.
     */
    mtime?: number;
    /** Size in bytes, when known (`0` for a missing path). */
    size?: number;
}
/** Exit statuses of the read commands (git's own statuses pass through as-is). */
export declare const READ_EXIT: {
    /** The reported root does not exist on the host (stale alias). */
    readonly noRoot: 90;
    /**
     * No `base64` on the host. Probed up front because without it every read
     * would come back empty and look like "this file has no content", which is a
     * far worse failure than a clear refusal.
     */
    readonly noBase64: 92;
};
/**
 * Tracked paths that changed, HEAD/index vs worktree, staged changes included.
 *
 * `-uno` is what keeps this cheap: untracked detection is the expensive half
 * (11s above) and it is answered by {@link untrackedCommand} instead. `-- .`
 * scopes the walk to the session root, so a session sitting in one package of
 * a monorepo does not pay for the rest.
 *
 * @param root - remote absolute POSIX directory (the session cwd).
 * @returns a `sh` script printing NUL-separated porcelain v1 records.
 */
export declare function trackedStatusCommand(root: string): string;
/**
 * New files git is not tracking yet (the ones a session usually creates).
 *
 * @param root - remote absolute POSIX directory (the session cwd).
 * @returns a `sh` script printing NUL-separated paths.
 */
export declare function untrackedCommand(root: string): string;
/**
 * Parse `git status --porcelain -z -uno` output.
 *
 * Porcelain v1 with `-z` writes `XY <path>\0`, and for a rename or copy the
 * source path follows as its own record: `R  <new>\0<old>\0` (verified against
 * git 2.x: the NEW path comes first). The source record is consumed, not parsed
 * as its own entry, and the reported path is the NEW one — the only path the
 * editor can open.
 *
 * The two status columns mean "index vs HEAD" (X) and "worktree vs index" (Y);
 * one letter is reported, chosen for how the file reads in a session review:
 * conflict > deleted > renamed > copied > added > typechange > modified.
 *
 * @param stdout - raw reply of {@link trackedStatusCommand}.
 */
export declare function parseStatusZ(stdout: string): StatusEntry[];
/**
 * Parse `git ls-files --others --exclude-standard -z` output into untracked
 * entries. Git already filtered ignored files out, and its paths are never
 * quoted in `-z` mode.
 */
export declare function parseUntrackedZ(stdout: string): StatusEntry[];
/**
 * Read several worktree files in one remote run.
 *
 * One `sh` script walks the paths in order and emits a {@link ReadResult} block
 * per path. Sizes come from `wc -c` before anything is transferred, so a 4GB
 * build artifact costs one `stat` instead of 5GB of base64; the running total
 * stops the reply from growing past `totalCapBytes`, after which the remaining
 * paths are reported `big` without being read.
 *
 * A symlink reports its target as content, because that is what git stores for
 * mode 120000 — catting the link's target file would diff the wrong bytes.
 *
 * @param root - remote absolute POSIX directory (the session cwd).
 * @param paths - paths relative to `root`.
 * @param capBytes - per-file cap; larger files are reported `big`.
 * @param totalCapBytes - cap on the sum of transferred content bytes.
 */
export declare function readWorktreeCommand(root: string, paths: readonly string[], capBytes: number, totalCapBytes: number): string;
/**
 * Read several `HEAD:<path>` blobs in one remote run — the "before" side of a
 * file that was already committed and clean when the session started.
 *
 * `git cat-file -s` answers existence *and* size before any bytes move, so the
 * caps are exact, and a path that is not in `HEAD` (a new file, a repository
 * with no commit yet, a submodule gitlink) is reported `absent` rather than
 * failing the whole read. `cat-file blob` is used instead of `show` on purpose:
 * no textconv, no filters, no pager — the bytes git will diff.
 *
 * @param root - remote absolute POSIX directory (the session cwd).
 * @param paths - paths relative to `root`.
 * @param capBytes - per-file cap; larger blobs are reported `big`.
 * @param totalCapBytes - cap on the sum of transferred content bytes.
 */
export declare function readHeadCommand(root: string, paths: readonly string[], capBytes: number, totalCapBytes: number): string;
/**
 * Name every immediate subdirectory that is a git repository.
 *
 * A session working directory is often a CONTAINER for repositories (a root
 * that holds another repository inside it), and
 * `git status` at the container answers 128. This is a one-level `ls`-style
 * probe — bounded work, no `find` — so it can never become the expensive part
 * of a scan.
 *
 * It prints ALL matches on purpose: a workspace with several repositories has no
 * single right answer, and the caller must refuse to guess rather than pick the
 * first one. The SCM panel's explicit repository directory is the real answer.
 *
 * @param root - remote absolute POSIX directory (the session cwd).
 */
export declare function reposBelowCommand(root: string): string;
/**
 * Parse a {@link readWorktreeCommand} / {@link readHeadCommand} reply.
 *
 * Keys are the decoded paths, exactly as requested. A marker without its
 * content line can only mean the reply was cut short (a timeout killing the
 * pipe); such a path is reported truncated rather than as an empty file, so an
 * aborted read never masquerades as "the file is empty".
 *
 * @param stdout - raw reply of either read command.
 */
export declare function parseReads(stdout: string): Map<string, ReadResult>;
