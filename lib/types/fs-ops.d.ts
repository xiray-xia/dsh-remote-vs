/** Assert an absolute POSIX path (no `..`, no control characters). */
export declare function assertAbsPath(path: string): string;
/** Join an absolute directory with one user-supplied name (no escapes). */
export declare function joinAbs(dir: string, name: string): string;
/** Copy one path into a directory (`cp -r`; the target keeps its base name). */
export declare function copyIntoCommand(from: string, intoDir: string, name?: string): string;
/** Move one path into a directory (`mv`), optionally under a new name. */
export declare function moveToCommand(from: string, intoDir: string, name?: string): string;
/**
 * Validate one removal target: absolute, no `..`, no control characters, and
 * never the filesystem root.
 *
 * `assertAbsPath` legitimately accepts `/` (one character away from `rm -rf -- /`)
 * and rewrites `\` to `/` for Windows-shaped input. A remote POSIX name may
 * legitimately contain a literal backslash, and rewriting it would delete a
 * DIFFERENT path, so removal validation keeps every character as-is and only
 * rejects what cannot be deleted safely.
 */
export declare function assertRemovablePath(path: string): string;
/**
 * Build the POSIX sh script that removes `paths`, in order.
 *
 * Each entry prints an indexed marker before and after its own `rm`, so the
 * client can show which path is on the wire, count settled entries and retry
 * exactly the ones that failed. The script ends with `exit 0` on purpose: one
 * failed path is not a failed batch — the markers own the per-path truth (see
 * `parseDeleteMarker`), and the caller falls back to the per-entry route for
 * whatever they report as FAIL.
 */
export declare function batchRemoveScript(paths: string[]): string;
/**
 * Split one multi-selection into bounded batches, dropping duplicate paths.
 *
 * Order is preserved (markers are index-based within a batch); the inputs are
 * validated here, before anything touches the remote, so an unquotable path
 * rejects the whole delete instead of starting a half-executed batch.
 */
export declare function splitBatchRemovePaths(paths: string[]): string[][];
/**
 * Parse one marker line printed by `batchRemoveScript`.
 *
 * Strict on purpose: remote `rm` diagnostics ("rm: cannot remove …") and a
 * mangled marker must never be mistaken for a settled entry. The index is a
 * plain non-negative integer (no sign, no decimal) because it indexes the
 * batch's path list.
 */
export declare function parseDeleteMarker(line: string): {
    kind: 'item' | 'ok' | 'fail';
    index: number;
} | undefined;
