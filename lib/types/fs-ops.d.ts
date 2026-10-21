/** Assert an absolute POSIX path (no `..`, no control characters). */
export declare function assertAbsPath(path: string): string;
/** Join an absolute directory with one user-supplied name (no escapes). */
export declare function joinAbs(dir: string, name: string): string;
/** Copy one path into a directory (`cp -r`; the target keeps its base name). */
export declare function copyIntoCommand(from: string, intoDir: string, name?: string): string;
/** Move one path into a directory (`mv`), optionally under a new name. */
export declare function moveToCommand(from: string, intoDir: string, name?: string): string;
