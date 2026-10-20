/**
 * Remote command builders and reply parsers for the session change ledger.
 *
 * Why this module exists: `@deepseek-ai/dsh-workspace-changes` (and the first
 * cut of this plugin) answer "what did this session change?" by staging the
 * whole worktree (`git add --all`) and diffing two trees. On a monorepo the
 * staging step alone ran past 40s without finishing, so the panel never left
 * "正在统计". Measured on a real AOSP checkout with a warm cache, same repo:
 *
 * | command                                      | time   |
 * | -------------------------------------------- | ------ |
 * | `git diff-files --name-status -z`            | 1.40s  |
 * | `git status --porcelain -z -uno`             | 1.67s  |
 * | `git ls-files --others --exclude-standard -z`| 11.25s |
 * | `git add --all` (the old baseline)           | >40s   |
 *
 * So the cheap path is: ask git *which* paths changed (status), read only those
 * paths' bytes, and diff locally. Cost becomes proportional to what the session
 * touched instead of to the size of the repository.
 *
 * Everything here is pure string in / string out — no pool, no fs, no DSH
 * import — so the recorder owns all the IO and this half stays testable.
 *
 * ## Paths, quoting, exit codes
 *
 * Every path is a POSIX absolute path on the host and every shell word is
 * single-quoted ({@link shq}); a path that reaches a shell unquoted is a bug.
 * A command exits `0` when it produced a reply, `90` when its root directory
 * does not exist (a stale alias), `92` when the host has no `base64`, and
 * otherwise with git's own exit status. The per-file problems of the read
 * commands (missing, unreadable, too big) are *not* failures: they are flags
 * inside a successful reply.
 *
 * ## Read reply wire format
 *
 * One block per requested path, in request order:
 *
 * ```
 * @@RVS-FILE <base64(path)> ok@@
 * <base64(content)>
 * @@RVS-FILE <base64(path)> big@@
 * @@RVS-FILE <base64(path)> absent@@
 * ```
 *
 * - Paths travel base64-encoded in the marker so spaces, quotes, CJK and even
 *   newlines cannot break the framing; content travels base64-encoded on the
 *   single line after the marker so NUL bytes and `\r\n` survive a text-only
 *   transport (one line, no wrapping — the shell strips base64's newlines).
 * - `ok` is followed by exactly one content line. An empty file is an empty
 *   content line (a bare `\n` after the marker line).
 * - `big` means "not transferred": the file alone is over `capBytes`, or the
 *   running total would pass `totalCapBytes`.
 * - `absent` means the path is not there *or* could not be read (permissions,
 *   a directory, a dangling blob); the recorder treats both as "no content".
 *
 * Binary detection is deliberately done in {@link parseReads} (any NUL byte in
 * the decoded content) rather than in the shell: one definition of "binary" for
 * every caller, and no dependence on `grep`/`od` behaviour across hosts.
 */

/** What happened to one path in this session. */
export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?'

/** One changed path, relative to the session root. */
export interface StatusEntry {
  path: string
  status: ChangeStatus
}

/** What one read asked for and what came back. */
export interface ReadResult {
  /** Decoded text, or null when nothing usable was transferred. */
  text: string | null
  /** Withheld because of a size cap (single file or the running total). */
  truncated: boolean
  /** The content contains a NUL byte, so it is not text. */
  binary: boolean
  /** Not there, or unreadable. */
  absent: boolean
}

/** Exit statuses of the read commands (git's own statuses pass through as-is). */
export const READ_EXIT = {
  /** The reported root does not exist on the host (stale alias). */
  noRoot: 90,
  /**
   * No `base64` on the host. Probed up front because without it every read
   * would come back empty and look like "this file has no content", which is a
   * far worse failure than a clear refusal.
   */
  noBase64: 92,
} as const

/** Marker that starts one file block in a read reply. */
const FILE_MARKER = '@@RVS-FILE '

/** POSIX single-quote one shell word. Throws on NUL, which no shell can carry. */
function shq(word: string): string {
  if (word.includes('\0')) throw new Error('NUL byte in shell word')
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/** `base64` of a UTF-8 string, for the marker's path field. */
function pathToken(path: string): string {
  return Buffer.from(path, 'utf8').toString('base64')
}

/** `cd` into the root, or exit with {@link READ_EXIT.noRoot}. */
function cdLine(root: string): string {
  return `cd ${shq(root)} || exit ${READ_EXIT.noRoot}`
}

/** A cap is a byte count: non-negative, integral, and never NaN. */
function capOf(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

/**
 * Tracked paths that changed, HEAD/index vs worktree, staged changes included.
 *
 * `-uno` is what keeps this cheap: untracked detection is the expensive half
 * (11s above) and it is answered by {@link untrackedCommand} instead. `-- .`
 * scopes the walk to the session root, so a session sitting in one package of
 * a monorepo does not pay for the rest.
 *
 * @param root - remote absolute POSIX directory (the session cwd).
 * @returns a `sh` script printing NUL-separated porcelain v1 records.
 */
export function trackedStatusCommand(root: string): string {
  return [cdLine(root), 'git --no-pager status --porcelain -z -uno -- .'].join('\n')
}

/**
 * New files git is not tracking yet (the ones a session usually creates).
 *
 * @param root - remote absolute POSIX directory (the session cwd).
 * @returns a `sh` script printing NUL-separated paths.
 */
export function untrackedCommand(root: string): string {
  return [cdLine(root), 'git ls-files --others --exclude-standard -z -- .'].join('\n')
}

/**
 * Parse `git status --porcelain -z -uno` output.
 *
 * Porcelain v1 with `-z` writes `XY <path>\0`, and for a rename or copy the
 * source path follows as its own record: `R  <new>\0<old>\0` (verified against
 * git 2.x: the NEW path comes first). The source record is consumed, not parsed
 * as its own entry, and the reported path is the NEW one — the only path the
 * editor can open.
 *
 * The two status columns mean "index vs HEAD" (X) and "worktree vs index" (Y);
 * one letter is reported, chosen for how the file reads in a session review:
 * conflict > deleted > renamed > copied > added > typechange > modified.
 *
 * @param stdout - raw reply of {@link trackedStatusCommand}.
 */
export function parseStatusZ(stdout: string): StatusEntry[] {
  const entries: StatusEntry[] = []
  const records = stdout.split('\0')
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    // Shortest legal record is "XY p": two status columns, a space, one byte.
    if (record === undefined || record.length < 4) continue
    const x = record.charAt(0)
    const y = record.charAt(1)
    if (record.charAt(2) !== ' ') continue
    const path = record.slice(3)
    if (path === '') continue
    if (x === 'R' || y === 'R' || x === 'C' || y === 'C') {
      // The next record is the source half of the rename/copy.
      index += 1
    }
    entries.push({ path, status: statusOf(x, y) })
  }
  return entries
}

/** Collapse porcelain's two columns into the one letter a review panel shows. */
function statusOf(x: string, y: string): ChangeStatus {
  const both = `${x}${y}`
  // Untracked: only reachable if a caller stops using `-uno`.
  if (x === '?' || y === '?') return '?'
  // Unmerged: 'U' on either side, or the both-added / both-deleted shapes.
  if (x === 'U' || y === 'U' || both === 'AA' || both === 'DD') return 'U'
  // Deleted beats everything else: the file is gone, and that is what the panel
  // must say (a rename-then-delete or add-then-delete still leaves nothing).
  if (x === 'D' || y === 'D') return 'D'
  if (x === 'R' || y === 'R') return 'R'
  if (x === 'C' || y === 'C') return 'C'
  if (x === 'A' || y === 'A') return 'A'
  if (x === 'T' || y === 'T') return 'T'
  return 'M'
}

/**
 * Parse `git ls-files --others --exclude-standard -z` output into untracked
 * entries. Git already filtered ignored files out, and its paths are never
 * quoted in `-z` mode.
 */
export function parseUntrackedZ(stdout: string): StatusEntry[] {
  const entries: StatusEntry[] = []
  for (const record of stdout.split('\0')) {
    if (record === '') continue
    entries.push({ path: record, status: '?' })
  }
  return entries
}

/**
 * Read several worktree files in one remote run.
 *
 * One `sh` script walks the paths in order and emits a {@link ReadResult} block
 * per path. Sizes come from `wc -c` before anything is transferred, so a 4GB
 * build artifact costs one `stat` instead of 5GB of base64; the running total
 * stops the reply from growing past `totalCapBytes`, after which the remaining
 * paths are reported `big` without being read.
 *
 * A symlink reports its target as content, because that is what git stores for
 * mode 120000 — catting the link's target file would diff the wrong bytes.
 *
 * @param root - remote absolute POSIX directory (the session cwd).
 * @param paths - paths relative to `root`.
 * @param capBytes - per-file cap; larger files are reported `big`.
 * @param totalCapBytes - cap on the sum of transferred content bytes.
 */
export function readWorktreeCommand(
  root: string,
  paths: readonly string[],
  capBytes: number,
  totalCapBytes: number,
): string {
  const script = [
    'set -u',
    `command -v base64 >/dev/null 2>&1 || exit ${READ_EXIT.noBase64}`,
    cdLine(root),
    `rvs_cap=${capOf(capBytes)}`,
    `rvs_ttl=${capOf(totalCapBytes)}`,
    'rvs_total=0',
    '# rvs_one <base64(path)> <path>: emit one @@RVS-FILE block.',
    'rvs_one() {',
    '  rvs_b=$1',
    '  rvs_p=$2',
    '  rvs_src=missing',
    '  rvs_n=0',
    '  if [ -L "$rvs_p" ]; then',
    '    if rvs_v=$(readlink -- "$rvs_p" 2>/dev/null); then',
    '      rvs_src=symlink',
    '      # Bytes, not characters: the caps below are byte budgets.',
    '      rvs_n=$(printf "%s" "$rvs_v" | wc -c | tr -d " ")',
    '    fi',
    '  elif [ -f "$rvs_p" ] && [ -r "$rvs_p" ]; then',
    '    rvs_n=$(wc -c < "$rvs_p" 2>/dev/null | tr -d " ")',
    '    case $rvs_n in',
    '      ""|*[!0-9]*) rvs_n=0 ;;',
    '      *) rvs_src=file ;;',
    '    esac',
    '  fi',
    '  if [ "$rvs_src" = missing ]; then',
    '    printf \'@@RVS-FILE %s absent@@\\n\' "$rvs_b"',
    '    return 0',
    '  fi',
    '  if [ "$rvs_n" -gt "$rvs_cap" ] || [ "$((rvs_total + rvs_n))" -gt "$rvs_ttl" ]; then',
    '    printf \'@@RVS-FILE %s big@@\\n\' "$rvs_b"',
    '    return 0',
    '  fi',
    '  if [ "$rvs_src" = symlink ]; then',
    '    rvs_e=$(printf "%s" "$rvs_v" | base64 | tr -d "\\n")',
    '  else',
    '    rvs_e=$(base64 < "$rvs_p" 2>/dev/null | tr -d "\\n")',
    '    # A non-empty file that produced no bytes vanished under us.',
    '    if [ -z "$rvs_e" ] && [ "$rvs_n" -gt 0 ]; then',
    '      printf \'@@RVS-FILE %s absent@@\\n\' "$rvs_b"',
    '      return 0',
    '    fi',
    '  fi',
    '  printf \'@@RVS-FILE %s ok@@\\n%s\\n\' "$rvs_b" "$rvs_e"',
    '  rvs_total=$((rvs_total + rvs_n))',
    '  return 0',
    '}',
    ...paths.map(path => `rvs_one ${shq(pathToken(path))} ${shq(path)}`),
  ]
  return script.join('\n')
}

/**
 * Read several `HEAD:<path>` blobs in one remote run — the "before" side of a
 * file that was already committed and clean when the session started.
 *
 * `git cat-file -s` answers existence *and* size before any bytes move, so the
 * caps are exact, and a path that is not in `HEAD` (a new file, a repository
 * with no commit yet, a submodule gitlink) is reported `absent` rather than
 * failing the whole read. `cat-file blob` is used instead of `show` on purpose:
 * no textconv, no filters, no pager — the bytes git will diff.
 *
 * @param root - remote absolute POSIX directory (the session cwd).
 * @param paths - paths relative to `root`.
 * @param capBytes - per-file cap; larger blobs are reported `big`.
 * @param totalCapBytes - cap on the sum of transferred content bytes.
 */
export function readHeadCommand(
  root: string,
  paths: readonly string[],
  capBytes: number,
  totalCapBytes: number,
): string {
  const script = [
    'set -u',
    `command -v base64 >/dev/null 2>&1 || exit ${READ_EXIT.noBase64}`,
    cdLine(root),
    `rvs_cap=${capOf(capBytes)}`,
    `rvs_ttl=${capOf(totalCapBytes)}`,
    'rvs_total=0',
    '# rvs_one <base64(path)> <path>: emit one @@RVS-FILE block.',
    'rvs_one() {',
    '  rvs_b=$1',
    '  rvs_p=$2',
    '  rvs_n=',
    '  if ! rvs_n=$(git cat-file -s "HEAD:$rvs_p" 2>/dev/null); then',
    '    printf \'@@RVS-FILE %s absent@@\\n\' "$rvs_b"',
    '    return 0',
    '  fi',
    '  rvs_n=$(printf "%s" "$rvs_n" | tr -d " ")',
    '  case $rvs_n in',
    '    ""|*[!0-9]*)',
    '      printf \'@@RVS-FILE %s absent@@\\n\' "$rvs_b"',
    '      return 0',
    '      ;;',
    '  esac',
    '  if [ "$rvs_n" -gt "$rvs_cap" ] || [ "$((rvs_total + rvs_n))" -gt "$rvs_ttl" ]; then',
    '    printf \'@@RVS-FILE %s big@@\\n\' "$rvs_b"',
    '    return 0',
    '  fi',
    '  rvs_e=$(git cat-file blob "HEAD:$rvs_p" 2>/dev/null | base64 | tr -d "\\n")',
    '  # Non-empty blob but no bytes decoded: not a blob (a tree or a gitlink).',
    '  if [ -z "$rvs_e" ] && [ "$rvs_n" -gt 0 ]; then',
    '    printf \'@@RVS-FILE %s absent@@\\n\' "$rvs_b"',
    '    return 0',
    '  fi',
    '  printf \'@@RVS-FILE %s ok@@\\n%s\\n\' "$rvs_b" "$rvs_e"',
    '  rvs_total=$((rvs_total + rvs_n))',
    '  return 0',
    '}',
    ...paths.map(path => `rvs_one ${shq(pathToken(path))} ${shq(path)}`),
  ]
  return script.join('\n')
}

/**
 * Parse a {@link readWorktreeCommand} / {@link readHeadCommand} reply.
 *
 * Keys are the decoded paths, exactly as requested. A marker without its
 * content line can only mean the reply was cut short (a timeout killing the
 * pipe); such a path is reported truncated rather than as an empty file, so an
 * aborted read never masquerades as "the file is empty".
 *
 * @param stdout - raw reply of either read command.
 */
export function parseReads(stdout: string): Map<string, ReadResult> {
  const results = new Map<string, ReadResult>()
  const lines = stdout.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined || !line.startsWith(FILE_MARKER)) continue
    const fields = line.slice(FILE_MARKER.length)
    if (!fields.endsWith('@@')) continue
    const parts = fields.slice(0, -2).split(' ')
    if (parts.length !== 2) continue
    const token = parts[0] ?? ''
    const flags = parts[1] ?? ''
    const path = Buffer.from(token, 'base64').toString('utf8')
    if (path === '') continue
    if (flags !== 'ok') {
      results.set(path, flags === 'big'
        ? { text: null, truncated: true, binary: false, absent: false }
        : { text: null, truncated: false, binary: false, absent: true })
      continue
    }
    const encoded = lines[index + 1]
    // A well-formed block always ends with the content line plus its newline, so
    // a block whose content line is the very last element was cut short: an
    // aborted read must never masquerade as an empty file.
    if (encoded === undefined || index + 1 === lines.length - 1) {
      results.set(path, { text: null, truncated: true, binary: false, absent: false })
      break
    }
    index += 1
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.includes(0)) {
      results.set(path, { text: null, truncated: false, binary: true, absent: false })
      continue
    }
    results.set(path, { text: bytes.toString('utf8'), truncated: false, binary: false, absent: false })
  }
  return results
}
