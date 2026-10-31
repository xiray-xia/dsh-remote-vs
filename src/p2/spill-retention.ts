/**
 * Remote spill retention: the policy constant and the pure command builders.
 *
 * Why this module exists: the spill backend writes model-facing artifacts into
 * the remote `$HOME` under a per-session directory (`router-spill.ts`), and the
 * spill service definition owns NO retention policy ({@link SpillStore} only
 * declares `saveText`). Nothing removed those files, so a long-lived host grew
 * one artifact per oversized tool result forever — including the content of
 * command output, which is exactly the material that should not live on a build
 * machine indefinitely.
 *
 * The policy is deliberately lazy: a TTL sweep per host (one `find` on the first
 * spill), plus a per-session directory check when a session is disposed. Two
 * rules shape the commands below:
 *
 * 1. **Deletion must never block a write.** Everything is best-effort (see
 *    {@link runBestEffort}); a failed cleanup is logged and forgotten.
 * 2. **Deletion must be impossible to aim at anything else.** Every path is an
 *    absolute POSIX path under `<home>/.dsh-helpers/spills`, every shell word is
 *    single-quoted, the sweep is capped at depth 1 and to `session-*`, and the
 *    session-directory check only matches the directory itself (`-maxdepth 0`).
 *
 * Kept free of cordis/pool on purpose, so `scripts/check-spill-retention.mjs`
 * drives the real builders without a host.
 */

/** Subdirectory of the remote `$HOME` that holds every spilled artifact. */
export const SPILLS_SUBDIR = '.dsh-helpers/spills'

/** Default lifetime of a remote spill directory, in whole days. */
export const SPILL_TTL_DAYS_DEFAULT = 14

/** TTL bounds: below a day a sweep would race live sessions; above a quarter a "temporary" artifact is not. */
const TTL_MIN_DAYS = 1
const TTL_MAX_DAYS = 90

/** The TTL in days: `DSH_REMOTE_VS_SPILL_TTL_DAYS` when sane, else the default. */
export function spillTtlDays(): number {
  const raw = Number(process.env.DSH_REMOTE_VS_SPILL_TTL_DAYS)
  if (!Number.isFinite(raw) || raw < TTL_MIN_DAYS) return SPILL_TTL_DAYS_DEFAULT
  return Math.min(Math.floor(raw), TTL_MAX_DAYS)
}

/** A TTL clamped to the supported range (also used by direct callers/tests). */
export function clampTtlDays(value: number): number {
  if (!Number.isFinite(value)) return SPILL_TTL_DAYS_DEFAULT
  return Math.min(Math.max(Math.floor(value), TTL_MIN_DAYS), TTL_MAX_DAYS)
}

/** POSIX single-quote one shell word. Throws on NUL, which no shell can carry. */
export function shq(word: string): string {
  if (word.includes('\0')) throw new Error('NUL byte in shell word')
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/** Refuse a path that is not remote-absolute: retention must never guess a directory. */
function remoteAbsolute(path: string): string {
  if (!path.startsWith('/')) throw new Error(`refusing non-absolute remote path: ${path}`)
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

/** The spills root inside one remote home. */
export function spillRoot(home: string): string {
  return `${remoteAbsolute(home)}/${SPILLS_SUBDIR}`
}

/**
 * The per-session spill directory.
 *
 * Mirrors `router-spill.ts`'s previous inline spelling so existing sessions keep
 * finding their files, and rejects anything that could escape the root: a session
 * id comes from the Host, but a directory name derived from it still has to be
 * one safe path segment.
 */
export function sessionSpillDir(home: string, sessionId: string | number): string {
  const id = String(sessionId)
  if (id === '' || !/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') {
    throw new Error(`unsafe spill session id: ${id}`)
  }
  return `${spillRoot(home)}/session-${id}`
}

/**
 * One sweep command for a whole host: every `session-*` directory under the
 * spills root older than `ttlDays`.
 *
 * `-mindepth 1 -maxdepth 1` keeps the walk inside the root's own children (no
 * recursion, so a stray directory elsewhere can never match), `-name 'session-*'`
 * pins the namespace, and `|| true` makes "the root does not exist yet" (the
 * normal first-run case) a success: retention is not allowed to look like
 * failure to its caller.
 */
export function spillSweepCommand(home: string, ttlDays: number): string {
  const ttl = clampTtlDays(ttlDays)
  return `find ${shq(spillRoot(home))} -mindepth 1 -maxdepth 1 -type d -name 'session-*' -mtime +${ttl} -exec rm -rf -- {} + 2>/dev/null || true`
}

/**
 * One command for a single session's spill directory: remove it only when the
 * directory itself is older than the TTL.
 *
 * The mtime gate is what makes this safe for forked sessions: `dsh-spill` states
 * that a fork inherits the parent's locators without copying them, so a young
 * directory may still be referenced by a live child. `-maxdepth 0` matches the
 * directory alone — never its contents.
 */
export function spillDirSweepCommand(dir: string, ttlDays: number): string {
  const ttl = clampTtlDays(ttlDays)
  return `find ${shq(remoteAbsolute(dir))} -maxdepth 0 -type d -mtime +${ttl} -exec rm -rf -- {} + 2>/dev/null || true`
}

/**
 * Run one retention step without ever failing the caller.
 *
 * A write path that waits on a cleanup is a write path that can be broken by a
 * cleanup; the caller only gets a warning sink. Returns whether the step ran.
 */
export async function runBestEffort(
  what: string,
  run: () => Promise<void>,
  warn?: (message: string) => void,
): Promise<boolean> {
  try {
    await run()
    return true
  } catch (error) {
    try {
      warn?.(`spill retention (${what}) failed: ${error instanceof Error ? error.message : String(error)}`)
    } catch {
      // Logging must never break the write either.
    }
    return false
  }
}
