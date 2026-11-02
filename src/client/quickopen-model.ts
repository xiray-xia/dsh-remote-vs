/**
 * Ctrl+P quick open: the remote file index and its fuzzy matcher.
 *
 * Pure logic on purpose (no React, no store, no `api` import): the pixels live
 * in `QuickOpen.tsx`, and everything that has to be provable in Node lives
 * here — scoring, ranking, the index lifecycle, the remote command and its
 * parser. The only I/O this module performs is the injected `exec`, so a gate
 * can drive it with a stub and never touch a real host.
 *
 * The incident-index rules that shape every decision below:
 *
 * - **A failed listing is not an empty listing.** {@link buildFileIndex}
 *   REJECTS a run that did not produce a trustworthy listing: a timed-out or
 *   transport-broken command, a command that never entered the workspace root,
 *   and a listing TOOL that exited non-zero without listing anything. Returning
 *   `[]` there would make "the host failed" look exactly like "this tree has no
 *   files".
 * - **A capped listing is a bounded PREFIX, never a complete index.** THREE
 *   separate caps are enforced on the remote and reported as three separate
 *   facts: entries, bytes, and the walk depth of the no-ripgrep fallback. A
 *   listing that was cut anywhere says so in the result; nothing is silently
 *   dropped and called complete. A tool that listed SOME files and then exited
 *   non-zero is a fourth, separate fact (`toolStatus`) — its prefix is still
 *   useful, so it is kept but marked incomplete instead of being thrown away.
 * - **A late answer must not overwrite a newer screen.** The index records which
 *   workspace it is for; a result (or failure) that lands after the user
 *   switched workspaces is discarded, because its relative paths would be
 *   resolved against the wrong root (see {@link applyIndexResult}).
 *
 * Privacy: the index is memory-only. Nothing here stores file content, and
 * nothing is written to IndexedDB. The single persisted item is the recent-file
 * list — absolute paths only — under a `dsh-remote-vs.` key, the same
 * trade-off the panel-layout prefs already make.
 */

/** Cap on one listing's entries; precedent: `src/p2/file-refs.ts` (same 50k). */
export const QUICKOPEN_MAX_ENTRIES = 50_000

/**
 * Byte ceiling for one listing.
 *
 * Deliberately BELOW the Host's per-stream exec cap (2 MiB, `src/pool.ts`):
 * when the transport truncates it appends its own marker line, which would
 * arrive as a half-written path and be indistinguishable from a real one.
 * Staying under it means every truncation is OURS and is reported as one.
 */
export const QUICKOPEN_MAX_BYTES = 1_200_000

/**
 * One listing command's budget. A cold `find` walk over a very large tree is
 * the slow path (a few seconds with `rg`, minutes without it), and giving up
 * too early turns "slow host" into "broken index".
 */
export const QUICKOPEN_INDEX_TIMEOUT_MS = 120_000

/** Rows rendered in the result list. */
export const QUICKOPEN_RESULT_LIMIT = 50

/** Recent files remembered per host — paths only, never content. */
export const QUICKOPEN_RECENT_LIMIT = 20

/** localStorage key: `{ [alias]: string[] }`. Prefix kept for the panel's own data. */
export const QUICKOPEN_RECENT_KEY = 'dsh-remote-vs.recentFiles'

/**
 * Sentinel the remote listing prints after its last path.
 *
 * It is what makes truncation OBSERVABLE without measuring bytes: the caps sit
 * between the listing and this line, so the sentinel survives only when nothing
 * was cut. Absent sentinel = the prefix ended at a cap (or the transport cut
 * it), never "the tree is just that small".
 */
const LIST_SENTINEL = 'RV-QO-END'

/**
 * Depth-cap marker, printed by the `find` fallback only.
 *
 * `find` needs a depth bound on a huge tree, and a depth bound silently hides
 * deep files — the exact "capped but reported complete" failure this feature
 * exists to avoid. An uncapped `find` is not an option (it never finishes on a
 * multi-million-file tree), so the cap is declared in-band instead: this line
 * makes the normal depth bound a REPORTED fact rather than a lie of omission.
 * It is deliberately conservative — it is printed even when the tree happens to
 * be shallower than the bound, because proving "nothing is deeper" costs a
 * second full walk.
 */
const DEPTH_CAP_PREFIX = 'RV-QO-CAP '

/**
 * Tool-status marker, printed to STDERR (so the stdout caps cannot eat it).
 *
 * The stdout pipeline's exit status is the last `head`'s, which means a listing
 * tool that failed would otherwise be invisible: the index would look complete
 * (or, worse, an empty index would look like an empty tree). The group captures
 * the tool's own status and reports it out-of-band; {@link buildFileIndex} then
 * decides between "reject" (nothing listed) and "keep, but incomplete".
 */
const TOOL_STATUS_PREFIX = 'RV-QO-STATUS tool='

/** The Host's own exec-cap marker; should never appear, but never trust that. */
const HOST_CAP_MARKER = '[... truncated: output exceeded'

/**
 * Directories a quick-open index never walks.
 *
 * The same evidence-based set the name search prunes (`src/client/scm/actions.ts`):
 * build output and dependency caches are noise in a filename jump list and, on a
 * large tree, most of the walk. Merged with the stock `@file` exclusions so both
 * index surfaces agree on what a "file" is.
 */
const EXCLUDED_DIRECTORIES: readonly string[] = [
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', 'target',
  '.next', '.nuxt', '.turbo', '.venv', '__pycache__', '.pytest_cache',
  '.mypy_cache', '.gradle',
]

/**
 * How deep the `find` fallback walks. `rg --files` has no depth limit and is
 * the preferred path; this only bounds the no-ripgrep case, where an uncapped
 * walk on a multi-million-file tree never finishes. 40 is far past any sane
 * source layout (the name search needed 12 to see a deep file, and its cap was
 * raised for exactly that reason).
 *
 * The bound is DECLARED in the listing stream ({@link DEPTH_CAP_PREFIX}), so an
 * index built without ripgrep is never presented as complete.
 */
export const QUICKOPEN_FALLBACK_MAX_DEPTH = 40

/** Characters that start a new "word" in a path, for the boundary bonus. */
const BOUNDARY_CHARACTERS = '/_-. '

const SCORE_PER_CHARACTER = 1
/**
 * A consecutive run must outweigh the word-boundary bonus of the same
 * characters spread over `a_b_c`: "the letters are adjacent" is by far the
 * strongest signal that this is the name the user remembers. (Measured: with a
 * lower value, `x/a_b_c.ts` outscored `x/abc.ts`.)
 */
const SCORE_CONSECUTIVE = 12
const SCORE_BOUNDARY = 10
const SCORE_BASENAME = 6
/** Leading matched characters cost a little, capped so a deep hit is not doomed. */
const SCORE_LEADING_PENALTY_CAP = 10

/**
 * Score one path against one query, or `undefined` when it does not match.
 *
 * Greedy left-to-right subsequence matching (not optimal alignment): it is what
 * every editor's quick open does, it is O(path length), and — most importantly
 * here — it is DETERMINISTIC, so equal scores can be tie-broken by path and the
 * list never reshuffles between identical inputs.
 *
 * Weighting, in the order it matters for a filename jump list:
 * - each matched character scores 1;
 * - a run of consecutive characters beats the same characters spread out;
 * - a match inside the LAST path segment (the file name) scores higher than one
 *   inside directories — the query is almost always "the name I remember";
 * - a match at a word boundary (`/`, `_`, `-`, `.`, camel hump) beats one in the
 *   middle of a word.
 *
 * Case-insensitive in both directions; an empty query scores 0 (it matches
 * everything, which is how "recent files" reuses this path).
 */
export function fuzzyScore(query: string, path: string): number | undefined {
  const needle = query.toLowerCase()
  if (needle === '') return 0
  if (needle.length > path.length) return undefined
  const haystack = path.toLowerCase()
  const lastSeparator = path.lastIndexOf('/')
  let score = 0
  let matched = 0
  let previous = -2
  let firstMatch = -1
  for (let index = 0; index < haystack.length && matched < needle.length; index += 1) {
    if (haystack[index] !== needle[matched]) continue
    if (firstMatch < 0) firstMatch = index
    score += SCORE_PER_CHARACTER
    if (index === previous + 1) score += SCORE_CONSECUTIVE
    if (index > lastSeparator) score += SCORE_BASENAME
    if (isBoundaryAt(path, index)) score += SCORE_BOUNDARY
    previous = index
    matched += 1
  }
  if (matched < needle.length) return undefined
  return score - Math.min(firstMatch, SCORE_LEADING_PENALTY_CAP)
}

/** Does a word start at `index` in `path`? */
function isBoundaryAt(path: string, index: number): boolean {
  if (index === 0) return true
  const previous = path[index - 1]
  // Indices come from the lowercased copy, and a lowercase mapping can change
  // the length for a handful of Unicode characters; never index past the end.
  if (previous === undefined) return false
  if (BOUNDARY_CHARACTERS.includes(previous)) return true
  const current = path[index]
  if (current === undefined) return false
  // camelCase hump: "fooBar" lets "fb" match at the hump too.
  return previous === previous.toLowerCase() && current !== current.toLowerCase()
}

/**
 * Rank `paths` for one query.
 *
 * - Empty query: the caller's ORDER is the answer (that is what makes "recent
 *   files first" work without a second code path); the list is merely capped.
 * - Otherwise: score descending, then path ascending. The path tie-break is not
 *   cosmetic — without it, equal-scoring matches would come out in whatever
 *   order the (remote-driven) input happened to have, and the list would jump
 *   around between two identical keystrokes.
 *
 * `truncated` here means "more matches than fit", which is a different fact
 * from the index being truncated ({@link FileIndex.truncated}) — both are
 * reported, and neither is swallowed.
 */
export function rankFiles(
  query: string,
  paths: readonly string[],
  limit: number,
): { hits: string[]; truncated: boolean } {
  const cap = Math.max(0, Math.floor(limit))
  const needle = query.trim()
  if (needle === '') {
    return { hits: paths.slice(0, cap), truncated: paths.length > cap }
  }
  const scored: { path: string; score: number }[] = []
  for (const path of paths) {
    const score = fuzzyScore(needle, path)
    if (score !== undefined) scored.push({ path, score })
  }
  scored.sort((left, right) => (right.score - left.score) || comparePaths(left.path, right.path))
  return { hits: scored.slice(0, cap).map(item => item.path), truncated: scored.length > cap }
}

/** Byte-ish, locale-independent path order (stable across machines). */
function comparePaths(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Character offsets matched by `query` inside `text`, for highlighting.
 *
 * Only a match that fits ENTIRELY inside the file name produces offsets: a hit
 * whose characters are split between a directory and the name would otherwise
 * highlight a misleading subset of the name. Returns `[]` when the query does
 * not fully match, so the caller can render the name plain.
 */
export function matchPositions(query: string, text: string): number[] {
  const needle = query.trim().toLowerCase()
  const haystack = text.toLowerCase()
  const positions: number[] = []
  if (needle === '') return positions
  // Offsets index the ORIGINAL text, so a case mapping that changes the string
  // length would misplace every highlight. Refusing to highlight is the honest
  // degradation (the row still renders; it just has no marks).
  if (haystack.length !== text.length) return positions
  let at = 0
  for (let index = 0; index < haystack.length && at < needle.length; index += 1) {
    if (haystack[index] !== needle[at]) continue
    positions.push(index)
    at += 1
  }
  return at < needle.length ? [] : positions
}

/** Split a relative path into its directory part (trailing slash kept) and name. */
export function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? { dir: '', name: path } : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) }
}

/** Absolute remote path for a workspace-relative one. */
export function absoluteFromRoot(root: string, relative: string): string {
  const base = root.replace(/\/+$/, '')
  const clean = relative.replace(/^\.\//, '').replace(/^\/+/, '')
  return clean === '' ? base : `${base}/${clean}`
}

/**
 * Workspace-relative form of an absolute path, or `undefined` when it is not
 * inside this workspace.
 *
 * Used for the recent list: an entry from ANOTHER workspace must not be shown
 * as if it were reachable here — opening it would act on a path whose binding
 * the user is no longer looking at (the "opened in the wrong host" class of
 * incident).
 */
export function relativeToRoot(root: string, absolute: string): string | undefined {
  const base = root.replace(/\/+$/, '')
  if (base === '') return undefined
  if (absolute === base) return undefined
  if (!absolute.startsWith(`${base}/`)) return undefined
  return absolute.slice(base.length + 1)
}

/** Render one thrown value as a readable reason. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ------------------------------------------------------------------ recents

interface RecentTable {
  [alias: string]: string[]
}

function readRecentTable(): RecentTable {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(QUICKOPEN_RECENT_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as RecentTable
  } catch {
    // Private mode / quota / corrupted value: an empty history is a valid state,
    // and it must never break opening the panel.
    return {}
  }
}

/** Recently opened absolute paths for one host, newest first. */
export function loadRecentFiles(alias: string): string[] {
  if (alias === '') return []
  const list = readRecentTable()[alias]
  if (!Array.isArray(list)) return []
  return list
    .filter((item): item is string => typeof item === 'string' && item.startsWith('/'))
    .slice(0, QUICKOPEN_RECENT_LIMIT)
}

/**
 * Record one opened file and return the new list.
 *
 * Paths only — this is the one thing quick open persists, so the promise in the
 * README ("remote source never lands on this device") stays literally true:
 * what is stored is a location, not content.
 */
export function rememberRecentFile(alias: string, absolutePath: string): string[] {
  if (alias === '' || !absolutePath.startsWith('/')) return []
  const table = readRecentTable()
  const current = Array.isArray(table[alias]) ? table[alias].filter(item => typeof item === 'string') : []
  const next = [absolutePath, ...current.filter(item => item !== absolutePath)].slice(0, QUICKOPEN_RECENT_LIMIT)
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(QUICKOPEN_RECENT_KEY, JSON.stringify({ ...table, [alias]: next }))
    }
  } catch {
    // Best-effort: losing the history costs one extra search, not a failure.
  }
  return next
}

// ------------------------------------------------------------ index lifecycle

export type IndexPhase = 'idle' | 'loading' | 'ready' | 'error'

/** One built listing. Immutable; replaced wholesale, never mutated in place. */
export interface FileIndex {
  alias: string
  root: string
  /** Remote-write counter observed when the listing was requested. */
  writeSeq: number
  /** Workspace-relative paths, sorted (deterministic order for equal scores). */
  paths: readonly string[]
  /** This is a bounded PREFIX in the entry/byte dimension: more files exist. */
  truncated: boolean
  /**
   * The no-ripgrep fallback only walked this deep, so deeper files may be
   * missing. `undefined` means the listing had no depth bound (ripgrep).
   */
  depthCapped: number | undefined
  /**
   * Exit status of the listing tool when it complained. The prefix is kept (a
   * partial list is still useful) but it is NOT a complete index.
   */
  toolStatus: number | undefined
  /** Human-readable reasons the index is incomplete (tool status, stderr). */
  warning: string | undefined
}

/** Which workspace an index state is about. */
export interface IndexTarget {
  alias: string
  root: string
}

export interface IndexState {
  phase: IndexPhase
  /**
   * The workspace this state belongs to — for `loading`, the build in flight.
   *
   * Carried explicitly because "loading" alone was a lie: a build for workspace
   * A that was still in flight when the user switched to B made
   * `indexNeedsRebuild` answer "nothing to do" for B, and A's listing then
   * landed as if it were B's — Enter would join B's root with A's relative
   * paths (a file that is not there, or, worse, a same-named one that is not
   * what the list showed).
   */
  target: IndexTarget | undefined
  index: FileIndex | undefined
  error: string | undefined
}

export function createIndexState(): IndexState {
  return { phase: 'idle', target: undefined, index: undefined, error: undefined }
}

/** Cache identity: an index is only valid for the alias + root it came from. */
export function indexTargetKey(alias: string, root: string): string {
  return `${alias}\u0000${root.replace(/\/+$/, '')}`
}

/** Is `left` the same workspace as `right`? A trailing slash is not another tree. */
export function isSameIndexTarget(left: IndexTarget | undefined, right: IndexTarget): boolean {
  if (left === undefined) return false
  return indexTargetKey(left.alias, left.root) === indexTargetKey(right.alias, right.root)
}

/**
 * Does the cached state still answer for this target?
 *
 * Three independent invalidations, all cheap:
 * - this state is about a DIFFERENT workspace — including a build still in
 *   flight for one. Switching is a rebuild, and the foreign answer is dropped
 *   when it arrives (see {@link applyIndexResult});
 * - no index yet, or the last attempt FAILED (a transient failure deserves a
 *   retry on the next open, and an error state must never be reused as if it
 *   were a complete answer);
 * - a remote WRITE happened since the build (see `api.ts`), which is exactly
 *   when the path set can change.
 */
export function indexNeedsRebuild(state: IndexState, alias: string, root: string, writeSeq: number): boolean {
  if (!isSameIndexTarget(state.target, { alias, root })) return true
  if (state.phase === 'loading') return false
  if (state.phase === 'error') return true
  const index = state.index
  if (index === undefined) return true
  return index.writeSeq !== writeSeq
}

/**
 * Enter the loading phase for `alias` + `root`.
 *
 * An index for the SAME target is kept while it is being replaced, so the list
 * keeps answering (from a snapshot that may be one write old) instead of
 * blanking on every reopen. A different target's index is dropped: its paths
 * are wrong for the new workspace.
 */
export function beginIndexBuild(state: IndexState, alias: string, root: string): IndexState {
  const target = { alias, root }
  const keep = isSameIndexTarget(state.target, target) ? state.index : undefined
  return { phase: 'loading', target, index: keep, error: undefined }
}

/**
 * Publish one finished build — but only for the workspace that is current NOW.
 *
 * A build can outlive its workspace: 50k paths over a thin link takes seconds,
 * and switching while it runs is normal use. Publishing that answer would put
 * workspace A's relative paths in front of workspace B, so a foreign result is
 * DISCARDED: whatever state is current stays exactly as it is (the current
 * workspace's own build, or its error).
 */
export function applyIndexResult(state: IndexState, index: FileIndex): IndexState {
  if (!isSameIndexTarget(state.target, index)) return state
  return { phase: 'ready', target: { alias: index.alias, root: index.root }, index, error: undefined }
}

/**
 * Record a FAILED build for `target`, with the same foreign-result guard.
 *
 * `phase` stays `error` — never `ready` with zero paths. That distinction is the
 * whole point: the modal prints the reason and does not claim "no matching
 * file". Any previously built index for the same target is preserved so the
 * list keeps showing something usable while the reason sits in the footer.
 */
export function applyIndexFailure(state: IndexState, reason: string, target: IndexTarget): IndexState {
  if (!isSameIndexTarget(state.target, target)) return state
  return { phase: 'error', target, index: state.index, error: reason }
}

/**
 * An immediately-known LOCAL failure (nothing remote ran, so there is no target
 * to guard and no build to drop): e.g. no workspace is selected.
 */
export function failIndexNow(reason: string): IndexState {
  return { phase: 'error', target: undefined, index: undefined, error: reason }
}

/**
 * The single in-memory index cache.
 *
 * ONE slot: an index is only valid for the exact alias + root it was built for,
 * so there is nowhere for a foreign path list to hide (a switch invalidates by
 * construction). Memory only — nothing here exists after a page reload, which
 * is the published privacy trade-off.
 *
 * The modal subscribes to it (`useSyncExternalStore`) instead of keeping its own
 * copy: a build outlives the modal that started it, so a copy would show
 * "building…" forever when the user closes and reopens before the listing
 * lands — the cache updates, the unmounted component's copy never does.
 */
let cachedIndex: IndexState = createIndexState()
const indexListeners = new Set<() => void>()

export function quickOpenIndexState(): IndexState {
  return cachedIndex
}

/** Subscribe to cache changes (the modal's view of the index). */
export function subscribeQuickOpenIndex(listener: () => void): () => void {
  indexListeners.add(listener)
  return () => { indexListeners.delete(listener) }
}

/** Replace the cached state and notify every subscriber. */
export function replaceQuickOpenIndexState(next: IndexState): void {
  cachedIndex = next
  for (const listener of [...indexListeners]) listener()
}

// -------------------------------------------------------- remote listing I/O

/** The slice of one remote command result this feature needs. */
export interface IndexExecResult {
  success: boolean
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  error?: string | undefined
}

/** Injected I/O, so a gate can drive the whole build without a host. */
export interface FileIndexDeps {
  exec: (alias: string, command: string, timeoutMs: number) => Promise<IndexExecResult>
  /** Monotonic remote-write counter (see `api.ts` `remoteWriteSequence`). */
  writeSequence: () => number
}

/** One POSIX shell word, quoted. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The remote listing command.
 *
 * Shape decisions, and what each one prevents:
 * - `cd` instead of passing the root to the tools: both paths are printed
 *   relative to the working directory, which is what the index wants.
 * - a failed `cd` exits 3 WITH a message on stderr. Listing nothing would turn
 *   "the workspace root is gone" into "this tree has no files".
 * - `rg` when the host has it, `find` otherwise, decided ON THE HOST in one
 *   command: no probe round trip and no per-alias cache to invalidate.
 * - `--no-ignore --hidden` keeps ignored and dotted files searchable (what the
 *   name search does); the exclusion globs only prune noise directories.
 * - both caps are applied remotely (`head -n cap+1`, then `head -c bytes`), so a
 *   million-line tree never crosses the wire just to be cut on this side.
 * - the sentinel after the listing is what makes a capped prefix observable
 *   (see {@link parseFileIndexOutput}).
 * - `LC_ALL=C`: byte-wise ordering from the tools, so the parser sees one
 *   canonical form no matter the host locale.
 */
export function fileIndexCommand(
  root: string,
  caps: { entries?: number; bytes?: number } = {},
): string {
  const maxEntries = Math.max(1, Math.floor(caps.entries ?? QUICKOPEN_MAX_ENTRIES))
  const maxBytes = Math.max(1024, Math.floor(caps.bytes ?? QUICKOPEN_MAX_BYTES))
  const directories = shellQuote(root)
  const rgGlobs = EXCLUDED_DIRECTORIES
    .map(name => `--glob ${shellQuote(`!**/${name}`)} --glob ${shellQuote(`!**/${name}/**`)}`)
    .join(' ')
  const findPrune = EXCLUDED_DIRECTORIES.map(name => `-name ${shellQuote(name)}`).join(' -o ')
  return [
    `cd ${directories} || { echo ${shellQuote('quick-open: cannot enter the remote workspace root')} >&2; exit 3; }`,
    'export LC_ALL=C',
    // The braces matter for two reasons: the caps must apply to the WHOLE
    // either/or listing, and the sentinel must go THROUGH the caps — that is
    // what makes "the stream ended at a cap" observable. Printing it after the
    // pipeline instead would put it on every listing and the parser could no
    // longer tell a truncated index from a complete one.
    '{',
    'rv_status=0',
    'if command -v rg >/dev/null 2>&1; then',
    // `|| rv_status=$?` is what stops the pipeline's own status (the last
    // `head`'s, always 0) from hiding a tool that failed.
    `  rg --no-config --files --no-ignore --hidden ${rgGlobs} -- . || rv_status=$?`,
    // rg exits 1 for "no file matched" — an empty listing, not a failure.
    '  [ "$rv_status" -eq 1 ] && rv_status=0',
    'else',
    `  find . -maxdepth ${QUICKOPEN_FALLBACK_MAX_DEPTH} \\( ${findPrune} \\) -prune -o -type f -print || rv_status=$?`,
    // The depth bound is DECLARED, not silent (see DEPTH_CAP_PREFIX).
    `  printf '%s\\n' ${shellQuote(`${DEPTH_CAP_PREFIX}depth=${QUICKOPEN_FALLBACK_MAX_DEPTH}`)}`,
    'fi',
    // Our own caps make the tool die of SIGPIPE (>=128) once `head` has enough;
    // that is the truncation doing its job, not a tool failure.
    'if [ "$rv_status" -ge 128 ]; then rv_status=0; fi',
    `printf '%s\\n' ${shellQuote(LIST_SENTINEL)}`,
    // Out-of-band, on stderr: the stdout caps cannot eat it, so a failing tool
    // is still visible on a truncated listing.
    'if [ "$rv_status" -ne 0 ]; then printf "RV-QO-STATUS tool=%s\\n" "$rv_status" >&2; fi',
    `} | head -n ${maxEntries + 1} | head -c ${maxBytes}`,
  ].join('\n')
}

export interface FileIndexListing {
  paths: string[]
  truncated: boolean
  /** The find fallback declared a depth bound (deeper files may be missing). */
  depthCapped: number | undefined
}

/**
 * Turn one listing's stdout into sorted workspace-relative paths.
 *
 * Truncation is DERIVED, never assumed:
 * - the sentinel is missing → the prefix ended at a cap (or the transport cut
 *   it) → `truncated: true`, and the final line is dropped because it may be a
 *   half-written path;
 * - more than `maxEntries` lines survived → `truncated: true`, keep the prefix;
 * - the find fallback's depth marker survived → `depthCapped` (a THIRD, separate
 *   bound: more levels exist than were walked).
 *
 * The caller-visible promise is that a bounded listing NEVER looks complete:
 * every cap is its own reported fact.
 */
export function parseFileIndexOutput(
  stdout: string,
  options: { root: string; maxEntries?: number } = { root: '' },
): FileIndexListing {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? QUICKOPEN_MAX_ENTRIES))
  let text = stdout
  let truncated = false
  let depthCapped: number | undefined
  const hostCut = text.indexOf(HOST_CAP_MARKER)
  if (hostCut >= 0) {
    // Our own byte cap should have prevented this; if the transport cut it
    // anyway, the tail after the marker is not a path.
    truncated = true
    text = text.slice(0, hostCut)
  }
  const lines = text.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
  /** Whether the stream ended on a line boundary (so its last line is complete). */
  const closedLine = text.endsWith('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length > 0 && lines[lines.length - 1] === LIST_SENTINEL) {
    lines.pop()
  } else {
    truncated = true
    // A stream that did NOT end on a line boundary was cut mid-path: that last
    // fragment is not a file name and must not become one.
    if (!closedLine && lines.length > 0) lines.pop()
  }
  const base = options.root.replace(/\/+$/, '')
  const absolutePrefix = base === '' ? undefined : `${base}/`
  const seen = new Set<string>()
  for (const raw of lines) {
    // Deliberately NOT `trim()`: a file name may legally end with a space, and
    // trimming it would index (and open) a different path than the one listed.
    // Only the line terminator is stripped, above.
    if (raw === '') continue
    if (raw === LIST_SENTINEL) continue
    if (raw.startsWith(DEPTH_CAP_PREFIX)) {
      const depth = Number.parseInt(raw.slice(DEPTH_CAP_PREFIX.length).replace(/^depth=/, ''), 10)
      if (Number.isFinite(depth) && depth > 0) depthCapped = depth
      continue
    }
    let path = raw
    if (path.startsWith('./')) path = path.slice(2)
    if (absolutePrefix !== undefined && path.startsWith(absolutePrefix)) path = path.slice(absolutePrefix.length)
    path = path.replace(/^\/+/, '')
    if (path === '') continue
    seen.add(path)
  }
  const paths = Array.from(seen).sort(comparePaths)
  if (paths.length > maxEntries) {
    return { paths: paths.slice(0, maxEntries), truncated: true, depthCapped }
  }
  return { paths, truncated, depthCapped }
}

/** Exit status the listing tool reported, from its stderr marker (if any). */
function toolStatusOf(stderr: string): number | undefined {
  for (const line of stderr.split('\n')) {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line
    if (!clean.startsWith(TOOL_STATUS_PREFIX)) continue
    const status = Number.parseInt(clean.slice(TOOL_STATUS_PREFIX.length), 10)
    // 128+ means killed by a signal — our own caps cause SIGPIPE, so a
    // signal status is the truncation working, not the tool failing.
    if (!Number.isFinite(status) || status <= 0 || status >= 128) continue
    return status
  }
  return undefined
}

/**
 * First non-marker line of remote stderr: the human detail behind "incomplete".
 *
 * The tool-status marker is stripped (it is protocol, not prose) and the result
 * is capped so a wall of warnings cannot displace the list.
 */
function warningOf(stderr: string, toolStatus: number | undefined): string | undefined {
  const detail = stderr
    .split('\n')
    .map(item => (item.endsWith('\r') ? item.slice(0, -1) : item))
    .map(item => item.trim())
    .find(item => item !== '' && !item.startsWith(TOOL_STATUS_PREFIX))
  const trimmed = detail === undefined
    ? undefined
    : (detail.length > 160 ? `${detail.slice(0, 157)}…` : detail)
  if (toolStatus === undefined) return trimmed
  // The exit code alone is the important part: it says the tool gave up, so the
  // listing is not complete even when it looks complete.
  const head = `listing tool exited ${toolStatus}`
  return trimmed === undefined ? head : `${head}: ${trimmed}`
}

/**
 * Fetch and parse one listing.
 *
 * Rejects — loudly — whenever the run did not produce a trustworthy listing:
 * timed out, transport-broken, never entered the workspace root (exit 3), or the
 * listing tool failed AND listed nothing. A successful run with zero paths is a
 * legitimate empty index (a brand new repository) and resolves with `paths: []`;
 * a run whose tool listed some files and then reported errors resolves with the
 * usable prefix plus `toolStatus`/`warning` saying it is incomplete.
 *
 * The write counter is read BEFORE the command starts: a write that lands while
 * the listing is in flight must leave the index stale (its `writeSeq` is older),
 * otherwise the modal could show — and open — a path that no longer exists.
 */
export async function buildFileIndex(
  deps: FileIndexDeps,
  target: { alias: string; root: string },
  options: { entries?: number; bytes?: number; timeoutMs?: number } = {},
): Promise<FileIndex> {
  const alias = target.alias
  const root = target.root.replace(/\/+$/, '')
  const entries = options.entries ?? QUICKOPEN_MAX_ENTRIES
  const bytes = options.bytes ?? QUICKOPEN_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? QUICKOPEN_INDEX_TIMEOUT_MS
  const writeSeq = deps.writeSequence()
  const command = fileIndexCommand(root, { entries, bytes })
  const result = await deps.exec(alias, command, timeoutMs)
  if (result.timedOut) {
    throw new Error(`the remote listing did not finish within ${timeoutMs} ms`)
  }
  if (result.error !== undefined && result.error !== '') {
    throw new Error(result.error)
  }
  const toolStatus = toolStatusOf(result.stderr)
  if (!result.success) {
    const detail = warningOf(result.stderr, undefined)
    const exit = result.exitCode === null ? 'no exit status' : `exit ${result.exitCode}`
    throw new Error(detail === undefined ? `the remote listing failed (${exit})` : `${detail} (${exit})`)
  }
  const listing = parseFileIndexOutput(result.stdout, { root, maxEntries: entries })
  if (toolStatus !== undefined && listing.paths.length === 0 && !listing.truncated) {
    // The tool failed and produced nothing: an empty answer from a broken tool is
    // not evidence of an empty tree. Reject, exactly like a transport failure.
    const detail = warningOf(result.stderr, toolStatus)
    throw new Error(detail ?? `the remote listing failed (tool exit ${toolStatus})`)
  }
  return {
    alias,
    root,
    writeSeq,
    paths: listing.paths,
    truncated: listing.truncated,
    depthCapped: listing.depthCapped,
    toolStatus,
    warning: warningOf(result.stderr, toolStatus),
  }
}
