/**
 * Remote file-manager verbs the SFTP route does not offer: recursive copy and
 * move, plus the plain "delete a directory tree" the exec route handles faster
 * than a per-entry SFTP walk.
 *
 * Paths are asserted absolute and then single-quoted, so a name can never
 * escape into shell syntax. `mv` and `cp` are used deliberately over a
 * read/write loop: they preserve modes, handle directories and stay server
 * side (no bytes cross the wire).
 */
import { shQuote } from './git-format.ts'

/** Assert an absolute POSIX path (no `..`, no control characters). */
export function assertAbsPath(path: string): string {
  if (typeof path !== 'string' || path === '' || path.length > 4096) throw new Error(`invalid path: ${String(path)}`)
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  if (/[\0\n\r]/.test(normalized)) throw new Error('path contains control characters')
  if (!normalized.startsWith('/')) throw new Error('path must be absolute')
  if (normalized.split('/').some(seg => seg === '..')) throw new Error('path must not contain ..')
  return normalized
}

/** Join an absolute directory with one user-supplied name (no escapes). */
export function joinAbs(dir: string, name: string): string {
  const clean = name.replace(/\\/g, '/').trim().replace(/^\/+/, '')
  if (clean === '' || clean.split('/').some(seg => seg === '' || seg === '.' || seg === '..')) {
    throw new Error(`invalid name: ${name}`)
  }
  return `${assertAbsPath(dir)}/${clean}`
}

/** Copy one path into a directory (`cp -r`; the target keeps its base name). */
export function copyIntoCommand(from: string, intoDir: string, name?: string): string {
  const source = shQuote(assertAbsPath(from))
  const target = name === undefined
    ? `${shQuote(assertAbsPath(intoDir))}/`
    : shQuote(joinAbs(intoDir, name))
  return `cp -r -- ${source} ${target}`
}

/** Move one path into a directory (`mv`), optionally under a new name. */
export function moveToCommand(from: string, intoDir: string, name?: string): string {
  const source = shQuote(assertAbsPath(from))
  const target = name === undefined
    ? `${shQuote(assertAbsPath(intoDir))}/`
    : shQuote(joinAbs(intoDir, name))
  return `mv -- ${source} ${target}`
}

/** Remove a directory tree. */
export function removeTreeCommand(path: string): string {
  return `rm -rf -- ${shQuote(assertAbsPath(path))}`
}

/** Whether a remote path exists (and its type). */
export function statCommand(path: string): string {
  return `if [ -d ${shQuote(assertAbsPath(path))} ]; then echo dir; elif [ -e ${shQuote(assertAbsPath(path))} ]; then echo file; else echo none; fi`
}
