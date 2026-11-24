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

/**
 * One batch holds at most this many paths.
 *
 * The client streams one exec per batch and paints per-path progress from its
 * markers; a bounded batch keeps one failure/cancel from swallowing a whole
 * thousand-path selection.
 */
const BATCH_REMOVE_MAX_PATHS = 200

/**
 * Upper bound on one batch's script, in UTF-8 bytes.
 *
 * The script is sent as a JSON string over the exec route, so it is kept well
 * under any sane command-line budget; a selection of maximum-length paths is
 * split further by this cap, not just by count.
 */
const BATCH_REMOVE_MAX_BYTES = 48 * 1024

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
export function assertRemovablePath(path: string): string {
  if (typeof path !== 'string' || path === '') throw new Error('invalid path: empty')
  if (path.length > 4096) throw new Error('invalid path: too long')
  if (!path.startsWith('/')) throw new Error('invalid path: must be absolute')
  // C0 + DEL + C1: none can be embedded in a shell line safely, and every
  // well-known remote filesystem lets `rm` reach names without them.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(path)) throw new Error('invalid path: control characters')
  // Collapse duplicate and trailing separators (same target), but keep `\` —
  // it is an ordinary character in a POSIX name.
  const normalized = path.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/'
  if (normalized === '/') throw new Error('invalid path: refusing to remove /')
  if (normalized.split('/').some(segment => segment === '..' || segment === '.')) {
    throw new Error('invalid path: must not contain . or ..')
  }
  return normalized
}

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
export function batchRemoveScript(paths: string[]): string {
  const lines: string[] = []
  for (let index = 0; index < paths.length; index += 1) {
    const target = shQuote(assertRemovablePath(paths[index]))
    lines.push(`echo 'RV_DEL_ITEM ${index}'`)
    lines.push(`if rm -rf -- ${target}; then echo 'RV_DEL_OK ${index}'; else echo 'RV_DEL_FAIL ${index}'; fi`)
  }
  lines.push('exit 0')
  return lines.join('\n')
}

/**
 * Split one multi-selection into bounded batches, dropping duplicate paths.
 *
 * Order is preserved (markers are index-based within a batch); the inputs are
 * validated here, before anything touches the remote, so an unquotable path
 * rejects the whole delete instead of starting a half-executed batch.
 */
export function splitBatchRemovePaths(paths: string[]): string[][] {
  const unique: string[] = []
  const seen = new Set<string>()
  for (const path of paths) {
    const normalized = assertRemovablePath(path)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    unique.push(normalized)
  }
  const batches: string[][] = []
  let batch: string[] = []
  for (const path of unique) {
    if (batch.length > 0) {
      const candidate = [...batch, path]
      const bytes = new TextEncoder().encode(batchRemoveScript(candidate)).length
      if (candidate.length > BATCH_REMOVE_MAX_PATHS || bytes > BATCH_REMOVE_MAX_BYTES) {
        batches.push(batch)
        batch = [path]
        continue
      }
      batch = candidate
      continue
    }
    batch = [path]
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

/**
 * Parse one marker line printed by `batchRemoveScript`.
 *
 * Strict on purpose: remote `rm` diagnostics ("rm: cannot remove …") and a
 * mangled marker must never be mistaken for a settled entry. The index is a
 * plain non-negative integer (no sign, no decimal) because it indexes the
 * batch's path list.
 */
export function parseDeleteMarker(line: string): { kind: 'item' | 'ok' | 'fail'; index: number } | undefined {
  const match = /^RV_DEL_(ITEM|OK|FAIL) (\d+)$/.exec(line.trim())
  if (match === null) return undefined
  const index = Number(match[2])
  if (!Number.isSafeInteger(index)) return undefined
  const kind = match[1] === 'ITEM' ? 'item' : match[1] === 'OK' ? 'ok' : 'fail'
  return { kind, index }
}

// Two builders were removed from this file because nothing imported them:
// `removeTreeCommand` (`rm -rf -- <path>`) and `statCommand`. Both had live,
// tested counterparts elsewhere — removal went through the SFTP route
// (`sftp.ts` `removeTree`, which re-reads each child's attributes, refuses a
// symlink, and rejects `/`), and stat through `git-format.ts` `statCommand`.
// `batchRemoveScript` above is the deliberate re-add: it only ever builds a
// bounded, marker-instrumented batch, and `assertRemovablePath` refuses `/` —
// the old single-path builder had neither guard, which is why it was deleted
// rather than left one call away from `rm -rf -- /`.
