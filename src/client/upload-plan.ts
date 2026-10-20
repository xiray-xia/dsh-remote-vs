/**
 * Upload planning: what a drop (or a picked file list) turns into on the remote
 * side. Pure, so the security-relevant part — path normalization — is testable
 * without a browser.
 *
 * Why this exists as its own module
 * --------------------------------
 * A drop hands over paths the browser chose (a folder drop can hand over a whole
 * subtree). Writing "targetDir + name" without normalizing is how a traversal
 * (`..\\..\\secret`) or an absolute name escapes the folder the user dropped
 * onto. Every entry therefore goes through {@link normalizeRelative}, and the
 * resulting plan is ordered so directories exist before the files inside them.
 */

/** Largest single-file upload the host accepts (2 GiB). */
export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024

/** One file the user dropped or picked. */
export interface DroppedFile {
  /** Path RELATIVE to the drop target, slash-separated (may contain dirs). */
  rel: string
  /** Byte size, when the browser reported one. */
  size: number
}

/** Why an entry was left out of the plan. */
export type UploadSkipReason = 'empty' | 'absolute' | 'escape' | 'too-large'

/** One directory to create, relative to the drop target ('' = the target). */
export type UploadDir = string

/** The ordered work one batch of dropped files implies. */
export interface UploadPlan {
  /** Directories to create, parents before children, deduplicated. */
  dirs: UploadDir[]
  /** Files to upload, in the input order after deduplication. */
  files: DroppedFile[]
  /** Entries deliberately left out, with the reason. */
  skipped: Array<{ rel: string; reason: UploadSkipReason }>
}

/** Outcome of normalizing one path: either a usable relative path or a reason. */
export type NormalizedPath =
  | { ok: true; path: string }
  | { ok: false; reason: UploadSkipReason }

/**
 * Normalize one dropped relative path.
 *
 * Returns a discriminated result rather than `string | reason`: the first cut
 * returned the bare reason string, and since every reason IS a string the
 * caller's `typeof !== 'string'` check never fired — a `../secret` entry was
 * then happily uploaded as a file literally named "escape". The gate caught it;
 * keeping a real discriminant stops it from coming back.
 *
 * @param rel - raw path from the browser (either separator flavor).
 * @returns `{ ok: true, path }` or `{ ok: false, reason }`.
 */
export function normalizeRelative(rel: string): NormalizedPath {
  const slashed = rel.replace(/\\/g, '/')
  if (slashed.trim() === '') return { ok: false, reason: 'empty' }
  // A drive-qualified or rooted path names something outside the target.
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) return { ok: false, reason: 'absolute' }
  const parts: string[] = []
  for (const part of slashed.split('/')) {
    if (part === '' || part === '.') continue
    // `..` would climb out of the directory the user dropped onto. Refusing is
    // the only honest answer: silently clamping it to the target would upload
    // the file somewhere the user did not ask for.
    if (part === '..') return { ok: false, reason: 'escape' }
    if (part.includes('\0')) return { ok: false, reason: 'escape' }
    parts.push(part)
  }
  if (parts.length === 0) return { ok: false, reason: 'empty' }
  return { ok: true, path: parts.join('/') }
}

/** Ancestor directories of one relative path, shallowest first (excludes ''). */
export function ancestorsOf(rel: string): string[] {
  const parts = rel.split('/')
  parts.pop()
  const out: string[] = []
  let current = ''
  for (const part of parts) {
    current = current === '' ? part : `${current}/${part}`
    out.push(current)
  }
  return out
}

/**
 * Build the ordered plan for one batch.
 *
 * @param entries - dropped/picked files with paths relative to the target.
 * @param maxBytes - per-file ceiling (asserted again by the host).
 * @returns the plan; `dirs` is empty when nothing survives.
 */
export function planUpload(entries: readonly DroppedFile[], maxBytes = UPLOAD_MAX_BYTES): UploadPlan {
  const files: DroppedFile[] = []
  const skipped: UploadPlan['skipped'] = []
  const seen = new Set<string>()
  const dirs = new Set<string>()

  for (const entry of entries) {
    const normalized = normalizeRelative(entry.rel)
    if (!normalized.ok) {
      skipped.push({ rel: entry.rel, reason: normalized.reason })
      continue
    }
    const rel = normalized.path
    if (seen.has(rel)) continue
    if (entry.size > maxBytes) {
      skipped.push({ rel, reason: 'too-large' })
      continue
    }
    seen.add(rel)
    files.push({ rel, size: entry.size })
    for (const dir of ancestorsOf(rel)) dirs.add(dir)
  }

  return {
    dirs: [...dirs].sort((left, right) => {
      const depth = left.split('/').length - right.split('/').length
      return depth !== 0 ? depth : left.localeCompare(right)
    }),
    files,
    skipped,
  }
}

/**
 * Merge the extra directories a drop reported (an empty folder carries no
 * files, so the plan alone would never create it).
 *
 * @param plan - the file-driven plan.
 * @param extraDirs - relative directories the source walked, possibly empty.
 * @returns the plan with those directories added, parents first.
 */
export function withDroppedDirs(plan: UploadPlan, extraDirs: readonly string[]): UploadPlan {
  const dirs = new Set(plan.dirs)
  for (const raw of extraDirs) {
    const normalized = normalizeRelative(raw)
    if (!normalized.ok) continue
    for (const dir of [...ancestorsOf(normalized.path), normalized.path]) dirs.add(dir)
  }
  return {
    ...plan,
    dirs: [...dirs].sort((left, right) => {
      const depth = left.split('/').length - right.split('/').length
      return depth !== 0 ? depth : left.localeCompare(right)
    }),
  }
}
