/**
 * Remote directory archiving for the download route.
 *
 * The archive is produced ON the remote host (`tar -czf -`) and streamed
 * straight into the HTTP response, so the Host never builds it in memory or
 * writes it to its own disk. Pure string builders (no fs, no exec) so the
 * download gate can pin the exact command shape.
 */

import { posix } from 'node:path'
import { shQuote } from './git-format.ts'
import { MAX_SELECTION_DOWNLOAD } from './protocol.ts'

/** Download file name for one archived directory. */
export function directoryArchiveName(dir: string): string {
  const trimmed = String(dir).replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const base = at < 0 ? trimmed : trimmed.slice(at + 1)
  return `${base === '' ? 'root' : base}.tar.gz`
}

/**
 * One POSIX shell command that writes the directory's gzip tar to stdout.
 *
 * The member name is prefixed with `./` so a directory whose name starts with
 * `-` cannot be read as a tar option; `-C` names the parent instead of relying
 * on a shell `cd`, and both paths are single-quoted (`shQuote`) so spaces,
 * quotes and `$()` in a real path cannot escape into the command.
 */
export function directoryArchiveCommand(dir: string): string {
  const path = String(dir).replace(/\\/g, '/').replace(/\/+$/, '')
  if (path === '' || path === '/') throw new Error('refusing to archive the remote root')
  if (!path.startsWith('/')) throw new Error('remote path must be absolute')
  const parent = posix.dirname(path)
  const name = posix.basename(path)
  return `tar -czf - -C ${shQuote(parent)} ${shQuote(`./${name}`)}`
}

/**
 * One POSIX shell command archiving several selected paths to stdout.
 *
 * GNU tar accepts one `-C` before each member, so every entry is stored as its
 * own bare `./name` while keeping its real parent on the remote side; that is
 * what lets a selection span several directories (mixed files and directories
 * are fine — tar recurses into directories). Two entries with the same basename
 * from different directories collide inside the archive by design: the
 * alternative would be a synthetic directory tree the remote never had.
 */
export function selectionArchiveCommand(paths: readonly string[]): string {
  if (paths.length === 0) throw new Error('refusing to archive an empty selection')
  if (paths.length > MAX_SELECTION_DOWNLOAD) throw new Error(`too many entries: ${paths.length} (max ${MAX_SELECTION_DOWNLOAD})`)
  let command = 'tar -czf -'
  for (const raw of paths) {
    const path = String(raw).replace(/\\/g, '/').replace(/\/+$/, '')
    if (path === '' || path === '/') throw new Error('refusing to archive the remote root')
    if (!path.startsWith('/')) throw new Error('remote path must be absolute')
    command += ` -C ${shQuote(posix.dirname(path))} ${shQuote(`./${posix.basename(path)}`)}`
  }
  return command
}
