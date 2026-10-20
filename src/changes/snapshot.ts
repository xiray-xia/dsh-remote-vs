/**
 * Remote git snapshot primitives for the session change ledger.
 *
 * The whole design rests on one fact proven on a live host: a snapshot of the
 * worktree can be produced by a SINGLE remote `sh` run that never touches the
 * repository's real index or object store — a private index file, a private
 * object directory, and the repository's own objects attached read-only as an
 * alternate. Two such snapshots give tree ids, and `git diff <tree> <tree>`
 * gives exactly "what changed between these two moments".
 *
 * Why this exists at all: DSH's own `workspace-changes` recorder cannot serve a
 * remote session. It parses `git rev-parse` output with host path semantics (a
 * POSIX reply becomes `C:\home\…`) and stages its scratch index with `node:fs`
 * on the host, so the very first baseline snapshot fails and the recorder
 * returns before appending any event. Everything here is the same algorithm
 * translated into "remote shell + POSIX paths".
 *
 * Pure string/parse work on purpose: no pool, no fs, so it is unit-testable and
 * can be imported by either half.
 */

/** POSIX single-quote one word (the only quoting that survives sh). */
export function shq(word: string): string {
  if (word.includes('\0')) throw new Error('NUL byte in shell word')
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/** Exit code meanings the recorder reports back to the UI. */
export const SNAPSHOT_EXIT = {
  /** The reported root does not exist on the host (stale alias). */
  noRoot: 90,
  /** The private scratch directory could not be created. */
  noScratch: 91,
  /** `git add` failed — most often the exec timeout killed it. */
  addFailed: 92,
  /** The root is not inside a git repository (or git is missing). */
  noRepo: 93,
  /** `git write-tree` failed on a populated index. */
  noTree: 94,
} as const

/**
 * Shared prologue for every command that touches snapshot objects.
 *
 * `$o` (the repository's real object store) is resolved FIRST because it is the
 * alternate that makes committed blobs readable; `$t` is this session's private
 * scratch. Resolving `$o` also doubles as the "is this a repository" probe.
 *
 * @param root - remote absolute POSIX directory (the session cwd).
 * @param scratch - remote absolute scratch directory for this session.
 */
function scratchPrologue(root: string, scratch: string): string[] {
  return [
    'set -u',
    `cd ${shq(root)} || exit ${SNAPSHOT_EXIT.noRoot}`,
    `o=$(git rev-parse --git-path objects 2>/dev/null) || exit ${SNAPSHOT_EXIT.noRepo}`,
    'case "$o" in /*) ;; *) o="$PWD/$o" ;; esac',
    `t=${shq(scratch)}`,
  ]
}

/**
 * The environment that makes a snapshot's objects visible again.
 *
 * Load-bearing for the DIFF commands too, not just the snapshot: the tree ids
 * `git write-tree` prints are written into the private object directory, so a
 * later `git diff <treeA> <treeB>` without these variables fails with
 * `fatal: bad object` — measured on Git for Windows before this was factored
 * out, and the same holds on the remote.
 */
function scratchEnv(): string[] {
  return [
    'export GIT_OBJECT_DIRECTORY="$t/objects"',
    'export GIT_ALTERNATE_OBJECT_DIRECTORIES="$o"',
  ]
}

/**
 * Build the one remote run that snapshots the worktree that `$PWD` names.
 *
 * Scope is `-- .` on purpose: the session root is usually a subdirectory of a
 * big repository, and snapshotting the whole tree of such a repository is what
 * makes `git add --all` take 40s. Limiting to the current directory keeps the
 * cost proportional to the code the session can actually see.
 *
 * @param root - remote absolute POSIX directory to snapshot (the session cwd).
 * @param scratch - remote absolute directory holding this session's private
 *   index and objects; reused across snapshots so later runs start warm.
 * @returns a `sh` script printing the tree id as its last stdout line.
 */
export function snapshotCommand(root: string, scratch: string): string {
  return [
    ...scratchPrologue(root, scratch),
    `mkdir -p "$t/objects" || exit ${SNAPSHOT_EXIT.noScratch}`,
    'export GIT_INDEX_FILE="$t/index"',
    ...scratchEnv(),
    // --ignore-errors keeps a single unreadable path (permission, dangling
    // symlink) from sinking the whole snapshot; --all also stages deletions.
    `git add --all --ignore-errors -- . >/dev/null 2>&1 || exit ${SNAPSHOT_EXIT.addFailed}`,
    'git write-tree || exit ' + SNAPSHOT_EXIT.noTree,
  ].join('\n')
}

/** Tree id of `HEAD`, for the degraded baseline of a repository with no snapshot yet. */
export function headTreeCommand(root: string): string {
  return `cd ${shq(root)} || exit ${SNAPSHOT_EXIT.noRoot}\ngit rev-parse --verify HEAD^{tree} 2>/dev/null || exit ${SNAPSHOT_EXIT.noRepo}`
}

/** The tree id a snapshot script printed, or undefined when the output is not one. */
export function parseTreeId(stdout: string): string | undefined {
  const lines = stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
  const last = lines[lines.length - 1]
  return last !== undefined && /^[0-9a-f]{40,64}$/.test(last) ? last : undefined
}

/**
 * Build the one remote run that lists what changed between two snapshots.
 *
 * Two git verbs ride one exec because the panel needs both at the same instant
 * (counts and status); splitting them would double the round trips and let the
 * worktree move in between.
 *
 * @param root - session root on the host (diff paths come back relative to it).
 * @param scratch - the session's scratch directory holding the snapshot objects.
 * @param from - baseline tree id.
 * @param to - current tree id.
 */
export function treeDiffCommand(root: string, scratch: string, from: string, to: string): string {
  // `--relative` makes the paths relative to $PWD (the session root) and drops
  // anything outside it, which is what the panel's display and the editor's
  // pixel work both need. Every option must sit BEFORE `-- .`: after the
  // separator git reads the rest as pathspecs (a `--numstat` there is a file
  // name, and the listing silently comes back empty).
  const common = `--no-color -M --relative ${shq(from)} ${shq(to)}`
  return [
    ...scratchPrologue(root, scratch),
    `mkdir -p "$t/objects" || exit ${SNAPSHOT_EXIT.noScratch}`,
    ...scratchEnv(),
    `git --no-pager diff ${common} --numstat -- . || exit ${SNAPSHOT_EXIT.addFailed}`,
    'printf "\\n@@@rvs-name-status@@@\\n"',
    `git --no-pager diff ${common} --name-status -- . || exit ${SNAPSHOT_EXIT.addFailed}`,
  ].join('\n')
}

/** One `--numstat` row. */
export interface NumstatRow {
  path: string
  added: number
  deleted: number
  binary: boolean
}

/**
 * Escape a path for use after `-- ` in a git command line.
 *
 * `git diff -- <path>` treats a long list of pathspec magic characters
 * specially; prefixing with `:(literal)` is the documented way to say "this is
 * a path, not a pattern".
 */
export function pathLiteral(path: string): string {
  return `:(literal)${path}`
}

/** One file's comparison, limited to that path. */
export function fileDiffCommand(root: string, scratch: string, from: string, to: string, path: string): string {
  return [
    ...scratchPrologue(root, scratch),
    `mkdir -p "$t/objects" || exit ${SNAPSHOT_EXIT.noScratch}`,
    ...scratchEnv(),
    `git --no-pager diff --no-color -M --relative -U3 ${shq(from)} ${shq(to)} -- ${shq(pathLiteral(path))} || exit ${SNAPSHOT_EXIT.addFailed}`,
  ].join('\n')
}

/** The marker separating the two sections of {@link treeDiffCommand}. */
export const DIFF_SECTION_MARKER = '@@@rvs-name-status@@@'

/** Split a {@link treeDiffCommand} reply into its numstat and name-status halves. */
export function splitDiffSections(stdout: string): { numstat: string; nameStatus: string } {
  const at = stdout.indexOf(DIFF_SECTION_MARKER)
  if (at < 0) return { numstat: stdout, nameStatus: '' }
  return {
    numstat: stdout.slice(0, at),
    nameStatus: stdout.slice(at + DIFF_SECTION_MARKER.length).replace(/^\n+/, ''),
  }
}

/**
 * Resolve the destination path of a `--numstat`/`--name-status` row.
 *
 * Rename detection prints one of two shapes: a plain `old => new`, or a
 * brace-joined `dir/{old => new}/tail`. Both collapse to the NEW path, which is
 * what the editor can open.
 */
export function destinationPath(raw: string): string {
  const value = raw.trim()
  if (value === '') return value
  const braced = value.replace(/\{([^{}]*) => ([^{}]*)\}/g, '$2')
  if (braced !== value) return braced
  const arrow = value.lastIndexOf(' => ')
  return arrow < 0 ? value : value.slice(arrow + 4).trim()
}

/** Parse `--numstat` output (binary rows report `-` for both counts). */
export function parseNumstat(text: string): NumstatRow[] {
  const rows: NumstatRow[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const first = line.indexOf('\t')
    const second = first < 0 ? -1 : line.indexOf('\t', first + 1)
    if (first < 0 || second < 0) continue
    const addedRaw = line.slice(0, first).trim()
    const deletedRaw = line.slice(first + 1, second).trim()
    const path = destinationPath(line.slice(second + 1))
    if (path === '') continue
    const binary = addedRaw === '-' || deletedRaw === '-'
    rows.push({
      path,
      added: binary ? 0 : Number.parseInt(addedRaw, 10) || 0,
      deleted: binary ? 0 : Number.parseInt(deletedRaw, 10) || 0,
      binary,
    })
  }
  return rows
}

/** Git status letters the panel understands. */
export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U'

/** Parse `--name-status` output into destination path → status. */
export function parseNameStatus(text: string): Map<string, ChangeStatus> {
  const table = new Map<string, ChangeStatus>()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split('\t')
    const raw = parts[0].trim()
    if (raw === '') continue
    const letter = raw[0]
    if (letter !== 'A' && letter !== 'M' && letter !== 'D' && letter !== 'R' && letter !== 'C' && letter !== 'T' && letter !== 'U') continue
    // R###/C### carry the source path first; the destination is last.
    const target = parts.length > 2 ? parts[parts.length - 1] : parts.length > 1 ? parts[1] : parts[0]
    const path = destinationPath(target ?? '')
    if (path !== '') table.set(path, letter)
  }
  return table
}
