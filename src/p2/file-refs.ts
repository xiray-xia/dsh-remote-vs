/**
 * Remote `@file` discovery: the far side of TransparentFileReferences.
 * Mirrors the stock local semantics (dsh-file-reference-local) point for
 * point, with two documented adaptations for RPC transport:
 *
 * - Bare fuzzy queries run ONE remote `rg --files` (head-capped, sorted
 *   locally for determinism) instead of a recursive listDir walk (hundreds
 *   of RPCs). Excluded basenames are pushed down as rg --glob filters.
 * - Symlinked files may appear in bare results (stock prunes them via
 *   non-following Dirent; per-entry remote lstat is prohibitive). Symlinked
 *   dirs stay absent (rg does not descend without -L), matching stock.
 *
 * Everything else is exact: path shapes, dotfile rules, exclusion lists,
 * scoring/ranking math, caps (20 results / 50k entries), jail semantics.
 * No ctx reads inside (explicit deps only) so the router owns all service
 * visibility concerns and this module stays unit-testable.
 */
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

/** Mirrored stock defaults (dsh-file-reference-local). */
export const REMOTE_FILE_SEARCH_MAX_RESULTS = 20
export const REMOTE_FILE_SEARCH_MAX_ENTRIES = 50000

/** Mirrored stock exclusion list (order kept for diffability). */
export const REMOTE_FILE_SEARCH_EXCLUDED_DIRECTORIES: readonly string[] = [
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', 'target',
  '.next', '.nuxt', '.turbo', '.venv', '__pycache__', '.pytest_cache',
  '.mypy_cache', '.gradle',
]

/** Byte ceiling for one rg listing transfer (50k lines worst case). */
const RG_OUTPUT_MAX_BYTES = 16 * 1024 * 1024

export interface RemoteFileSearchDeps {
  /** Remote fs view (worlds.fsFor) for scoped live listings. */
  fs: FileSystem
  /** Spawn in the remote world (SshProcRuntime.spawn bound). */
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Remote absolute root (the binding's remotePath). */
  remoteRoot: string
  /** Optional warn sink (router wires ctx.logger). */
  warn?: (message: string) => void
}

export class RemoteFileSearch {
  private readonly excluded: ReadonlySet<string>
  private settled: FileReferenceCandidate[] | undefined
  private pending: Promise<FileReferenceCandidate[]> | undefined
  private pendingAbort: AbortController | undefined
  private disposed = false

  constructor(private readonly deps: RemoteFileSearchDeps) {
    this.excluded = new Set(REMOTE_FILE_SEARCH_EXCLUDED_DIRECTORIES)
  }

  /** Drop the cached index (tool activity); the next bare query rebuilds. */
  invalidate(): void {
    this.settled = undefined
    if (this.pendingAbort !== undefined) {
      try {
        this.pendingAbort.abort(new Error('file search index invalidated'))
      } catch {
        // Ignore.
      }
      this.pending = undefined
      this.pendingAbort = undefined
    }
  }

  dispose(): void {
    this.disposed = true
    this.invalidate()
  }

  /** Ranked candidates for one @ token (mirrors WorkspaceFileSearch.list). */
  async list(rawQuery: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    signal.throwIfAborted()
    if (this.disposed) return []
    const query = rawQuery.replaceAll('\\', '/')
    const slash = query.lastIndexOf('/')
    if (query === '' || slash >= 0) {
      const directory = slash < 0 ? '' : query.slice(0, slash + 1)
      const fragment = slash < 0 ? '' : query.slice(slash + 1)
      return this.listDirectory(directory, fragment, signal)
    }
    const index = await this.indexFor(signal)
    return rankCandidates(
      index.filter(c => visibleForGlobalQuery(c.path, query)),
      query,
      REMOTE_FILE_SEARCH_MAX_RESULTS,
    )
  }

  /** Live single-level listing (one RPC; mirrors listDirectory exactly). */
  private async listDirectory(displayDirectory: string, fragment: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    if (displayDirectory.split('/').some(segment => this.excluded.has(segment))) return []
    const absolute = joinRemote(this.deps.remoteRoot, displayDirectory)
    if (absolute === undefined) return []
    let entries: { name: string; type: string }[]
    try {
      const target = await this.deps.fs.resolve(absolute, {})
      entries = await this.deps.fs.listDir(target, signal)
    } catch {
      return []
    }
    const candidates: FileReferenceCandidate[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.') && !fragment.startsWith('.')) continue
      if (entry.type === 'directory') {
        if (this.excluded.has(entry.name)) continue
        candidates.push({ path: `${displayDirectory}${entry.name}`, kind: 'directory' })
      } else if (entry.type === 'file') {
        candidates.push({ path: `${displayDirectory}${entry.name}`, kind: 'file' })
      }
      // 'other' skipped (stock skips non-file non-dir Dirents).
    }
    return rankCandidates(candidates, fragment, REMOTE_FILE_SEARCH_MAX_RESULTS)
  }

  /** Cached full listing; concurrent callers share one in-flight build. */
  private async indexFor(signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    if (this.settled !== undefined) return this.settled
    if (this.pending === undefined) {
      const controller = new AbortController()
      this.pendingAbort = controller
      this.pending = this.buildIndex(controller.signal).then(
        (entries) => {
          if (this.pendingAbort === controller) {
            this.pending = undefined
            this.pendingAbort = undefined
          }
          if (!this.disposed) this.settled = entries
          return entries
        },
        (error: unknown) => {
          if (this.pendingAbort === controller) {
            this.pending = undefined
            this.pendingAbort = undefined
          }
          throw error
        },
      )
    }
    // This caller may bail without killing the shared build.
    signal.throwIfAborted()
    return new Promise<FileReferenceCandidate[]>((resolve, reject) => {
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort)
        reject(signal.reason instanceof Error ? signal.reason : new Error('file search aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void (this.pending as Promise<FileReferenceCandidate[]>).then(
        (entries) => {
          signal.removeEventListener('abort', onAbort)
          resolve(entries)
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  /** One remote `rg --files` run, head-capped, sorted for determinism. */
  private async buildIndex(signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    const globs: string[] = []
    for (const name of this.excluded) {
      globs.push(`--glob=!**/${name}`, `--glob=!**/${name}/**`)
    }
    const argv = ['rg', '--no-config', '--files', '--no-ignore', '--hidden', ...globs, '--', '.']
    let handle: SubprocessHandle
    try {
      handle = this.deps.spawn({
        argv,
        cwd: this.deps.remoteRoot,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 4096 } },
        graceMs: 3000,
        signal,
      })
    } catch (error) {
      this.warn(`remote file index spawn failed: ${messageOf(error)}`)
      return []
    }
    const lines: string[] = []
    let bytes = 0
    let truncated = false
    try {
      const stdout = handle.stdout
      if (stdout === undefined) {
        handle.terminate()
      } else {
        let carry = ''
        const onAbort = (): void => {
          try {
            handle.terminate()
          } catch {
            // Ignore teardown races.
          }
        }
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          for await (const chunk of stdout) {
            const text = carry + (typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))
            const parts = text.split('\n')
            carry = parts.pop() ?? ''
            for (const line of parts) {
              const clean = line.endsWith('\r') ? line.slice(0, -1) : line
              if (clean === '') continue
              bytes += Buffer.byteLength(clean, 'utf8') + 1
              if (lines.length >= REMOTE_FILE_SEARCH_MAX_ENTRIES || bytes > RG_OUTPUT_MAX_BYTES) {
                truncated = true
                break
              }
              lines.push(clean)
            }
            if (truncated) break
          }
          if (!truncated && carry !== '') {
            if (lines.length < REMOTE_FILE_SEARCH_MAX_ENTRIES && bytes <= RG_OUTPUT_MAX_BYTES) {
              lines.push(carry.endsWith('\r') ? carry.slice(0, -1) : carry)
            }
          }
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
        signal.throwIfAborted()
        handle.terminate()
      }
      const outcome = await handle.done.catch(() => undefined)
      if (outcome !== undefined && outcome.exitCode !== 0 && outcome.exitCode !== 1) {
        this.warn(`remote file index rg exited ${outcome.exitCode ?? outcome.signal}`)
        return []
      }
    } catch (error) {
      try {
        handle.terminate()
      } catch {
        // Ignore.
      }
      if (signal.aborted) throw error
      this.warn(`remote file index failed: ${messageOf(error)}`)
      return []
    }
    // Normalize to stock index shape: strip ./, drop excluded segments
    // (covers the root-inside-excluded glob edge), sort, derive dirs.
    const files = new Set<string>()
    for (let line of lines) {
      if (line.startsWith('./')) line = line.slice(2)
      if (line === '' || line === '.' || line.startsWith('/')) continue
      if (line.split('/').some(segment => segment === '' || segment === '.' || segment === '..' || this.excluded.has(segment))) continue
      files.add(line)
    }
    const dirs = new Set<string>()
    for (const file of files) {
      const segments = file.split('/')
      for (let depth = 1; depth < segments.length; depth += 1) {
        const prefix = segments.slice(0, depth).join('/')
        const base = segments[depth - 1] as string
        if (!this.excluded.has(base)) dirs.add(prefix)
      }
    }
    const indexed: FileReferenceCandidate[] = [
      ...[...dirs].map(path => ({ path, kind: 'directory' as const })),
      ...[...files].map(path => ({ path, kind: 'file' as const })),
    ]
    indexed.sort((a, b) => compareText(a.path, b.path))
    return indexed
  }

  private warn(message: string): void {
    try {
      this.deps.warn?.(`[remote-refs] ${message}`)
    } catch {
      // Logging must never break completion.
    }
  }
}

/** Join a display dir under the remote root; undefined on jail escape. */
function joinRemote(root: string, display: string): string | undefined {
  const out: string[] = []
  for (const segment of display.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (out.length === 0) return undefined
      out.pop()
      continue
    }
    // Absolute display paths can never be under the root.
    if (out.length === 0 && /^[A-Za-z]:/.test(segment)) return undefined
    out.push(segment)
  }
  const base = root.endsWith('/') && root !== '/' ? root.slice(0, -1) : root
  return out.length === 0 ? base : `${base}/${out.join('/')}`
}

/** Ported scoring (dsh-file-reference-local rankCandidates family, exact). */
function rankCandidates(
  candidates: FileReferenceCandidate[],
  query: string,
  limit: number,
): FileReferenceCandidate[] {
  const ranked: { candidate: FileReferenceCandidate; score: number }[] = []
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, query)
    if (score !== undefined) ranked.push({ candidate, score })
  }
  ranked.sort((left, right) =>
    right.score - left.score
    || kindRank(left.candidate.kind) - kindRank(right.candidate.kind)
    || (query === '' ? 0 : left.candidate.path.length - right.candidate.path.length)
    || compareText(left.candidate.path, right.candidate.path),
  )
  return ranked.slice(0, limit).map(entry => entry.candidate)
}

function scoreCandidate(candidate: FileReferenceCandidate, query: string): number | undefined {
  if (query === '') return 0
  const path = candidate.path.toLowerCase()
  const name = path.slice(path.lastIndexOf('/') + 1)
  const needle = query.toLowerCase()
  const directoryBonus = candidate.kind === 'directory' ? 25 : 0
  if (name === needle) return 1000 + directoryBonus
  if (name.startsWith(needle)) return 900 + directoryBonus
  if (name.includes(needle)) return 700 + directoryBonus
  if (path.includes(needle)) return 500 + directoryBonus
  const subsequence = subsequenceScore(path, needle)
  return subsequence === undefined ? undefined : 300 + subsequence + directoryBonus
}

function subsequenceScore(target: string, query: string): number | undefined {
  let targetIndex = 0
  let gap = 0
  for (const character of query) {
    const found = target.indexOf(character, targetIndex)
    if (found < 0) return undefined
    gap += found - targetIndex
    targetIndex = found + 1
  }
  return Math.max(0, 100 - gap)
}

function kindRank(kind: string): number {
  return kind === 'directory' ? 0 : 1
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function visibleForGlobalQuery(path: string, query: string): boolean {
  if (query.startsWith('.') || query.includes('/.')) return true
  return !path.split('/').some(segment => segment.startsWith('.'))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
