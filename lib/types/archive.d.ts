/**
 * Remote directory archiving for the download route.
 *
 * The archive is produced ON the remote host (`tar -czf -`) and streamed
 * straight into the HTTP response, so the Host never builds it in memory or
 * writes it to its own disk. Pure string builders (no fs, no exec) so the
 * download gate can pin the exact command shape.
 */
/** Download file name for one archived directory. */
export declare function directoryArchiveName(dir: string): string;
/**
 * One POSIX shell command that writes the directory's gzip tar to stdout.
 *
 * The member name is prefixed with `./` so a directory whose name starts with
 * `-` cannot be read as a tar option; `-C` names the parent instead of relying
 * on a shell `cd`, and both paths are single-quoted (`shQuote`) so spaces,
 * quotes and `$()` in a real path cannot escape into the command.
 */
export declare function directoryArchiveCommand(dir: string): string;
