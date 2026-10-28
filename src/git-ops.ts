/**
 * Remote git operations beyond the read-only P2 set: command builders for
 * stage / unstage / discard / commit / stash / branch / remote / sync, plus
 * parsers for porcelain-v1 `-z`, unified diff and name-status output.
 *
 * Everything here runs on the REMOTE host through the existing exec route
 * (client/api.ts) — this module is pure string work: no dependencies, no
 * host-side code, safe to import from the browser bundle.
 *
 * Safety model: every path/ref/name that reaches a command is asserted
 * against a strict charset first and then single-quoted, so a file name can
 * never escape into shell syntax; destructive verbs (clean / push / branch
 * delete / stash drop) are only ever emitted by their own dedicated builder.
 */
import { assertRef, assertRemoteDir, shQuote } from './git-format.ts'
import type {
  GitCommitFile,
  GitPathStatus,
  GitRemote,
  GitStash,
  GitStatusDetail,
  UnifiedDiffFile,
  UnifiedHunk,
} from './protocol.ts'

/** Byte cap on captured output (protects one exec round trip). */
export const GIT_CAP = 2_000_000

/** Env prefix: never block on a prompt, never page, never open an editor. */
const GIT_ENV = 'GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat GIT_EDITOR=true'

/** `git` pinned to a work dir: no pager, no path quoting, no prompts. */
function git(workdir: string): string {
  return `${GIT_ENV} git --no-pager -C ${shQuote(assertRemoteDir(workdir))} -c core.quotepath=false`
}

/**
 * Cap a READ-ONLY command's stdout so one huge repo cannot flood the wire.
 *
 * Never use this for a command whose exit status is the answer: a shell
 * pipeline reports the status of its LAST command, so `git push | head`
 * returns head's 0 and a rejected push reads as a success. Mutating verbs
 * take `statusOk()` instead; the caller reads `result.success` and would
 * otherwise never learn the command failed.
 */
function capped(command: string, bytes: number = GIT_CAP): string {
  return `${command} | head -c ${bytes}`
}

/**
 * Cap a MUTATING command's stdout while keeping the command's own exit
 * status.
 *
 * The status cannot be read with a trailing `$?`: piping through `head`
 * makes git die of SIGPIPE as soon as the cap is hit, so `$?` reports head's
 * 0 (measured, not assumed). `${PIPESTATUS[0]}` would fix that but is
 * bash-only — under dash it is an unset variable, i.e. silently 0 again.
 * So: run git with stdout going straight to a file (no SIGPIPE), keep its
 * status in a variable, then emit the capped bytes and exit with that status.
 *
 * stderr is deliberately left alone: git's own diagnosis (‘! [rejected]’,
 * ‘hook declined’) has to reach the caller, which is the whole point.
 */
function statusOk(command: string, bytes: number = GIT_CAP): string {
  return `d=$(mktemp -d); ${command} > "$d/out" 2>"$d/err"; st=$?; head -c ${bytes} "$d/out"; cat "$d/err" >&2; rm -rf "$d"; exit $st`
}

// ------------------------------------------------------------- assertions

/** Assert a repo-relative path (no `..`, no leading `/`, no control chars). */
export function assertRepoPath(path: string): string {
  if (typeof path !== 'string' || path === '' || path.length > 4096) {
    throw new Error(`invalid repo path: ${String(path)}`)
  }
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
  if (/[\0\n\r]/.test(normalized)) throw new Error('repo path contains control characters')
  if (normalized.startsWith('/')) throw new Error('repo path must be relative to the repository root')
  if (normalized.split('/').some(seg => seg === '..')) throw new Error('repo path must not contain ..')
  return normalized
}

/** Single-quote one or more asserted repo paths for the command line. */
export function relPaths(paths: readonly string[]): string {
  if (paths.length === 0) throw new Error('at least one path is required')
  return paths.map(p => shQuote(assertRepoPath(p))).join(' ')
}

/** Assert a `stash@{n}` reference (assertRef rejects braces by design). */
export function assertStashRef(ref: string): string {
  if (!/^stash@\{\d+\}$/.test(ref)) throw new Error(`invalid stash ref: ${ref}`)
  return ref
}

/** Assert a branch name (same charset as a ref, plus the git branch rules we care about). */
export function assertBranchName(name: string): string {
  if (typeof name !== 'string' || name === '' || name.length > 128) throw new Error(`invalid branch: ${name}`)
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes('..') || name.endsWith('/') || name.endsWith('.')) {
    throw new Error(`invalid branch: ${name}`)
  }
  return name
}

/** Assert a remote name (`origin`, `upstream`, ...). */
export function assertRemoteName(name: string): string {
  if (typeof name !== 'string' || name === '' || name.length > 128) throw new Error(`invalid remote: ${name}`)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`invalid remote: ${name}`)
  return name
}

/** Assert a remote URL (anything printable without control characters). */
export function assertRemoteUrl(url: string): string {
  if (typeof url !== 'string' || url === '' || url.length > 2048) throw new Error('invalid remote URL')
  if (/[\0\n\r]/.test(url)) throw new Error('remote URL contains control characters')
  return url
}

// -------------------------------------------------------- read builders

/** Resolve the enclosing repository root (fails outside a work tree). */
export function repoProbeCommand(workdir: string): string {
  return `${git(workdir)} rev-parse --show-toplevel 2>/dev/null`
}

/**
 * Repository probe that keeps the ANSWER (exit code + both streams) on stdout.
 *
 * `repoProbeCommand` throws the exit code and stderr away — everything that is
 * not a root line reads as "nothing". That is fine for the workspace wizard
 * ("nothing to offer") but not for the SCM panel, where "this is not a
 * repository" and "git could not answer" are DIFFERENT states: the first is a
 * fact that may be cached, the second must keep the last known change list and
 * report the reason. So this command always exits 0 and prints
 *
 *     RVS_RC=<git exit code>
 *     <everything git wrote, stderr merged>
 *
 * `LC_ALL=C` pins git's wording (the client matches `not a git repository`; a
 * localized host would otherwise read as a failure), and merging the streams is
 * what makes that message survive — git writes it to stderr, which the plain
 * probe discards.
 */
export function repoProbeDetailCommand(workdir: string): string {
  // `printf` is last in the pipeline, so the exec route sees success and the
  // caller can read the REAL git exit code out of the first line.
  return capped(
    `out=$(LC_ALL=C LANG=C ${git(workdir)} rev-parse --show-toplevel 2>&1); rc=$?; printf 'RVS_RC=%s\\n%s\\n' "$rc" "$out"`,
  )
}

/** Discover repositories under a workspace root (depth-capped). */
export function repoDiscoveryCommand(root: string): string {
  const dir = shQuote(assertRemoteDir(root))
  return capped(`find ${dir} -maxdepth 3 \\( -name .git -type d -o -name .git -type f \\) -prune -print 2>/dev/null`, 64_000)
}

/**
 * Branch + ahead/behind + every entry with its ignored half, NUL separated.
 *
 * `--untracked-files=normal` (not `all`) is deliberate: an untracked DIRECTORY
 * then arrives as a single `dir/` record instead of every file inside it,
 * which is what keeps this call fast on a remote tree that also contains
 * node_modules or a build output directory. `--ignored=matching` reports
 * ignored paths one level deep for the tree's greying, under the same bound.
 */
export function statusDetailCommand(workdir: string): string {
  return capped(`${git(workdir)} status --porcelain=v1 -z --untracked-files=normal --ignored=matching`)
}

/**
 * Pathspec-limited porcelain status: the SAME `-z` record shape as
 * `statusDetailCommand`, restricted to the given paths.
 *
 * This is the cheap half of a stage/unstage. A full `git status` costs the
 * repository's whole index/worktree walk — minutes on the AOSP monorepo the
 * report came from — while a pathspec-limited call only visits the paths it was
 * given, so its cost tracks the touched paths instead of the repository size.
 * That is what makes it usable as an immediate verification of a local
 * (optimistic) stage.
 *
 * `--untracked-files=no` is deliberate: the untracked walk is the expensive
 * part, and it cannot answer the question this call exists for. Verified
 * against real git — an untracked path yields NO record, a path that just
 * entered the index is reported as `A ` (and a staged rename as `R  new\0old`)
 * — so absence means "not in the index", which is all the caller needs.
 */
export function statusPathsCommand(workdir: string, paths: readonly string[]): string {
  return capped(`${git(workdir)} status --porcelain=v1 -z --untracked-files=no -- ${relPaths(paths)}`)
}

/**
 * Pathspec-limited status INCLUDING untracked files, for ONE directory row.
 *
 * `-u normal` (the panel's performance mode) collapses an untracked directory
 * into a single `dir/` row, so the files inside it are invisible. This is the
 * command that opens it up: `-uall` lists those files individually (measured —
 * files in nested folders arrive as their own paths, never as `sub/` rows),
 * while the pathspec keeps the cost bounded by that directory instead of the
 * repository.
 *
 * The trailing slash is deliberate: it makes the pathspec name the directory
 * itself, so the call cannot match a sibling FILE that happens to share the
 * name.
 */
export function statusDirCommand(workdir: string, dir: string): string {
  const clean = assertRepoPath(dir).replace(/\/+$/, '')
  if (clean === '') throw new Error('a directory path is required')
  return capped(`${git(workdir)} status --porcelain=v1 -z --untracked-files=all -- ${shQuote(`${clean}/`)}`)
}

/** Branch header only (`## branch...upstream [ahead N, behind M]`), NUL safe. */
export function branchHeaderCommand(workdir: string): string {
  return capped(`${git(workdir)} status --porcelain=v1 -b -z --untracked-files=no`, 64_000)
}

/** Full message of the current HEAD commit. */
export function headMessageCommand(workdir: string): string {
  return capped(`${git(workdir)} log -1 --pretty=%B`, 64_000)
}

export interface DiffRequest {
  /** Diff the index against HEAD instead of the worktree against the index. */
  staged?: boolean
  /** Diff this revision instead of HEAD/index. */
  ref?: string
  /** Restrict to one repo-relative path. */
  path?: string
  /** Context lines (default git's 3). */
  context?: number
  /** `--stat` instead of a patch. */
  stat?: boolean
}

/** Unified diff (or a diffstat) for one side of the working tree. */
export function diffCommand(workdir: string, request: DiffRequest = {}): string {
  const parts = [`${git(workdir)} diff --no-color --no-ext-diff`]
  if (request.stat === true) parts.push('--stat')
  if (request.context !== undefined) parts.push(`-U${Math.max(0, Math.min(200, Math.floor(request.context)))}`)
  if (request.staged === true) parts.push('--cached')
  if (request.ref !== undefined) parts.push(assertRef(request.ref))
  if (request.path !== undefined) parts.push('--', shQuote(assertRepoPath(request.path)))
  return capped(parts.join(' '))
}

/** Files touched by one commit (`--name-status`, no patch body). */
export function commitFilesCommand(workdir: string, ref: string): string {
  return capped(`${git(workdir)} show --no-color --format= --name-status ${assertRef(ref)} --`)
}

/**
 * Whole patch of one commit, with the commit header stripped (`--format=`), so
 * the output starts at the first `diff --git` line and parses as a plain
 * unified diff. Capped like every read-only builder: a commit that rewrites a
 * generated file would otherwise ship megabytes for one sidebar pane.
 */
export function commitPatchCommand(workdir: string, ref: string): string {
  return capped(`${git(workdir)} show --no-color --no-ext-diff --format= --patch ${assertRef(ref)} --`)
}

/** One file's content at a revision (`rev` may also be `:0` for the index). */
export function fileAtRevCommand(workdir: string, rev: string, path: string): string {
  const spec = rev === ':0' ? `:${assertRepoPath(path)}` : `${assertRef(rev)}:${assertRepoPath(path)}`
  return capped(`${git(workdir)} show ${shQuote(spec)}`)
}

/** Local + remote-tracking branches with their upstream and tip. */
export function allBranchesCommand(workdir: string): string {
  return capped(`${git(workdir)} for-each-ref --format='%(refname:short)%x1f%(objectname:short)%x1f%(upstream:short)%x1f%(HEAD)%x1f%(refname)' refs/heads refs/remotes`)
}

/** Every configured remote with its URLs. */
export function remotesCommand(workdir: string): string {
  return capped(`${git(workdir)} remote -v`)
}

/** Stash stack, newest first. */
export function stashListCommand(workdir: string): string {
  return capped(`${git(workdir)} stash list --pretty=format:'%gd%x1f%gs%x1f%ct%x1e'`)
}

// ------------------------------------------------------- write builders

/** Stage paths (additions, modifications, deletions and renames). */
export function stageCommand(workdir: string, paths: readonly string[]): string {
  return `${git(workdir)} add -A -- ${relPaths(paths)}`
}

/** Unstage paths (index back to HEAD, worktree untouched). */
export function unstageCommand(workdir: string, paths: readonly string[]): string {
  return `${git(workdir)} restore --staged -- ${relPaths(paths)}`
}

/** Discard worktree edits for tracked paths (irreversible). */
export function restoreWorktreeCommand(workdir: string, paths: readonly string[]): string {
  return `${git(workdir)} restore --worktree -- ${relPaths(paths)}`
}

/** Delete untracked paths from disk (irreversible; the UI confirms first). */
export function cleanUntrackedCommand(workdir: string, paths: readonly string[]): string {
  return `${git(workdir)} clean -f -d -- ${relPaths(paths)}`
}

export interface CommitRequest {
  /** Commit message (multi-line through a single -m is fine). */
  message: string
  /** Amend the previous commit instead of adding one. */
  amend?: boolean
  /** Skip hooks (the UI never uses this; kept for parity). */
  noVerify?: boolean
}

/** Create a commit with the given message. */
export function commitCommand(workdir: string, request: CommitRequest): string {
  const message = request.message.replace(/\r\n/g, '\n').trimEnd()
  if (message.trim() === '') throw new Error('commit message is empty')
  const parts = [`${git(workdir)} commit --no-edit -m ${shQuote(message)}`]
  if (request.amend === true) parts.push('--amend')
  if (request.noVerify === true) parts.push('--no-verify')
  return statusOk(parts.join(' '))
}

/** Check out an existing ref (branch, tag or hash). */
export function checkoutCommand(workdir: string, ref: string): string {
  return statusOk(`${git(workdir)} checkout ${shQuote(assertRef(ref))}`)
}

/** Create (and check out) a branch, optionally from a start point. */
export function createBranchCommand(workdir: string, name: string, from?: string): string {
  const start = from !== undefined && from !== '' ? ` ${shQuote(assertRef(from))}` : ''
  return statusOk(`${git(workdir)} checkout -b ${shQuote(assertBranchName(name))}${start}`)
}

/** Delete a branch (`force` maps to -D). */
export function deleteBranchCommand(workdir: string, name: string, force: boolean): string {
  return statusOk(`${git(workdir)} branch ${force ? '-D' : '-d'} ${shQuote(assertBranchName(name))}`)
}

/** Rename a branch. */
export function renameBranchCommand(workdir: string, from: string, to: string): string {
  return statusOk(`${git(workdir)} branch -m ${shQuote(assertBranchName(from))} ${shQuote(assertBranchName(to))}`)
}

/** Merge a ref into the current branch (no editor prompt). */
export function mergeCommand(workdir: string, ref: string): string {
  return statusOk(`${git(workdir)} merge --no-edit ${shQuote(assertRef(ref))}`)
}

/** Publish a branch to a remote and set its upstream. */
export function publishBranchCommand(workdir: string, branch: string, remote: string): string {
  return statusOk(`${git(workdir)} push --set-upstream ${shQuote(assertRemoteName(remote))} ${shQuote(assertBranchName(branch))}`)
}

/** Fetch every remote, pruning deleted tracking refs. */
export function fetchCommand(workdir: string): string {
  return statusOk(`${git(workdir)} fetch --all --prune`)
}

/** Pull the current branch (merge, no editor prompt). */
export function pullCommand(workdir: string): string {
  return statusOk(`${git(workdir)} pull --no-edit`)
}

/** Push the current branch. */
export function pushCommand(workdir: string): string {
  return statusOk(`${git(workdir)} push`)
}

/** Stash the working tree (optionally including untracked files). */
export function stashSaveCommand(workdir: string, message: string, includeUntracked: boolean): string {
  const text = message.trim() === '' ? 'dsh-remote-vs stash' : message.trim()
  return statusOk(`${git(workdir)} stash push ${includeUntracked ? '-u ' : ''}-m ${shQuote(text)}`)
}

/** Apply (and keep) a stash entry. */
export function stashApplyCommand(workdir: string, ref: string): string {
  return statusOk(`${git(workdir)} stash apply ${shQuote(assertStashRef(ref))}`)
}

/** Apply and drop a stash entry. */
export function stashPopCommand(workdir: string, ref: string): string {
  return statusOk(`${git(workdir)} stash pop ${shQuote(assertStashRef(ref))}`)
}

/** Drop a stash entry (irreversible). */
export function stashDropCommand(workdir: string, ref: string): string {
  return statusOk(`${git(workdir)} stash drop ${shQuote(assertStashRef(ref))}`)
}

/** Register a remote. */
export function addRemoteCommand(workdir: string, name: string, url: string): string {
  return statusOk(`${git(workdir)} remote add ${shQuote(assertRemoteName(name))} ${shQuote(assertRemoteUrl(url))}`)
}

/** Remove a remote. */
export function removeRemoteCommand(workdir: string, name: string): string {
  return statusOk(`${git(workdir)} remote remove ${shQuote(assertRemoteName(name))}`)
}

/** Point an existing remote at a new URL. */
export function setRemoteUrlCommand(workdir: string, name: string, url: string): string {
  return statusOk(`${git(workdir)} remote set-url ${shQuote(assertRemoteName(name))} ${shQuote(assertRemoteUrl(url))}`)
}

/** Initialize a repository in place. */
export function initCommand(workdir: string): string {
  return statusOk(`${git(workdir)} init`)
}

/**
 * Apply a patch file (staged into the index, or reversed out of the worktree).
 * The caller writes the patch through SFTP first — no stdin channel exists on
 * the exec route, and a temp file also keeps the patch out of shell quoting.
 */
/** `git apply` argument set per hunk action (a map, not a nested ternary). */
const APPLY_ARGS: Record<'stage' | 'unstage' | 'revert', string> = {
  stage: '--cached --whitespace=nowarn',
  unstage: '--cached --reverse --whitespace=nowarn',
  revert: '--reverse --whitespace=nowarn',
}

export function applyPatchCommand(workdir: string, patchPath: string, mode: 'stage' | 'unstage' | 'revert'): string {
  const file = shQuote(assertRemoteDir(patchPath))
  const args = APPLY_ARGS[mode]
  // `git apply` is the whole point of this call, so its exit status is the
  // result: a plain `; rm -f` would hand back rm's 0 and report a rejected
  // hunk as staged. The status is latched into a variable before the cleanup
  // runs, because any command in between would overwrite `$?`.
  return statusOk(`${git(workdir)} apply ${args} ${file}; st=$?; rm -f ${file}; exit $st`)
}

// ------------------------------------------------------------- parsers

/** Enclosing repository root from `rev-parse --show-toplevel`. */
export function parseRepoRoot(stdout: string): string | undefined {
  const line = stdout.split('\n')[0]?.trim() ?? ''
  return line.startsWith('/') ? line : undefined
}

/** One strict probe's answer (see `repoProbeDetailCommand`). */
export type RepoProbeAnswer =
  | { kind: 'repo'; root: string }
  | { kind: 'none' }
  | { kind: 'failed'; error: string }

/**
 * Parse `repoProbeDetailCommand`'s output into the three states the panel needs.
 *
 * "not a git repository" is matched on git's own message rather than on the exit
 * code: `rev-parse` exits 128 for that AND for a directory it cannot enter, so
 * the code alone cannot separate the two. The message is guaranteed English by
 * the command's `LC_ALL=C`.
 */
export function parseRepoProbe(stdout: string): RepoProbeAnswer {
  const marker = /^RVS_RC=(\d+)\n?/.exec(stdout)
  if (marker === null) return { kind: 'failed', error: 'the repository probe returned no status line' }
  const code = Number(marker[1])
  const detail = stdout.slice(marker[0].length).trim()
  if (code === 0) {
    // Scan for the root line instead of trusting the first one: a warning
    // ("ignoring broken ref") may precede it.
    const root = detail.split('\n').map(line => line.trim()).find(line => line.startsWith('/'))
    return root === undefined
      ? { kind: 'failed', error: `git rev-parse printed no repository root: ${detail}` }
      : { kind: 'repo', root }
  }
  if (/not a git repository/i.test(detail)) return { kind: 'none' }
  return {
    kind: 'failed',
    error: detail !== '' ? detail : `git rev-parse --show-toplevel failed [exit code: ${code}]`,
  }
}

/** Repository dirs found under a workspace root. */
export function parseRepoDiscovery(stdout: string): string[] {
  const seen = new Set<string>()
  for (const raw of stdout.split('\n')) {
    const line = raw.trim().replace(/\/\.git$/, '')
    if (line.startsWith('/') && !seen.has(line)) seen.add(line)
  }
  // A root that is itself a repo sorts first, then shallowest first.
  return [...seen].sort((a, b) => (a.split('/').length - b.split('/').length) || a.localeCompare(b))
}

/**
 * Normalize a workspace-relative repository directory. `''` means "the workspace
 * root itself", which is what a workspace whose root IS the repository uses.
 *
 * Pure and host-free so the client can persist exactly what the host will later
 * resolve: leading/trailing separators drop, `.` segments drop, and a `..`
 * segment pops its parent — so a picker can never address anything above the
 * workspace root (a leading `..` pops nothing).
 */
export function normalizeRepoSubdir(input: string): string {
  const stack: string[] = []
  for (const segment of input.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') stack.pop()
    else stack.push(segment)
  }
  return stack.join('/')
}

/** The absolute directory git commands run in for one workspace + subdir. */
export function repoWorkdir(workspaceRoot: string, subdir: string): string {
  const base = workspaceRoot.replace(/\/+$/, '')
  const clean = normalizeRepoSubdir(subdir)
  return clean === '' ? base : `${base}/${clean}`
}

/**
 * A directory expressed relative to a workspace root, or undefined when it sits
 * outside it. Turns a probed repository root back into the stored subdir, so
 * choosing a directory INSIDE a repository settles on that repository's root.
 */
export function repoSubdirOf(workspaceRoot: string, dir: string): string | undefined {
  const base = workspaceRoot.replace(/\/+$/, '')
  if (dir === base) return ''
  return dir.startsWith(`${base}/`) ? normalizeRepoSubdir(dir.slice(base.length + 1)) : undefined
}

/**
 * Porcelain v1 in `-z` form: `XY PATH\0` records, rename/copy records carry
 * `XY NEW\0OLD\0` (the field order is reversed versus the arrow form), and
 * ignored entries arrive as `!! PATH`.
 */
export function parseStatusDetail(stdout: string): GitStatusDetail {
  const fields = stdout.split('\0')
  const entries: GitPathStatus[] = []
  const ignored: string[] = []
  let truncated = false
  let i = 0
  while (i < fields.length) {
    const field = fields[i] as string
    i += 1
    if (field === '') continue
    if (field.startsWith('##')) continue
    if (field.length < 4 || field[2] !== ' ') {
      // A malformed record means the byte cap cut the stream mid-record; stop
      // here. (`fields[i - 1 + 1]` used to test the CURRENT field's `##`
      // prefix, which is unreachable anyway because `statusDetailCommand` does
      // not pass `-b` — the branch header is never present.)
      truncated = true
      break
    }
    const x = field[0] as string
    const y = field[1] as string
    const path = field.slice(3)
    const renamed = x === 'R' || x === 'C' || y === 'R' || y === 'C'
    let origPath: string | undefined
    if (renamed) {
      origPath = fields[i]
      i += 1
    }
    if (x === '!' && y === '!') {
      if (ignored.length < 4000) ignored.push(path)
      else truncated = true
      continue
    }
    if (entries.length >= 4000) {
      truncated = true
      continue
    }
    entries.push(origPath === undefined ? { path, x, y } : { path, x, y, origPath })
  }
  return { entries, ignored, truncated }
}

/** Split one unified diff into per-file blocks. */
export function parseUnifiedDiff(text: string): UnifiedDiffFile[] {
  const lines = text.split('\n')
  const files: UnifiedDiffFile[] = []
  let current: UnifiedDiffFile | undefined
  let header: string[] = []
  let hunk: { header: string; lines: string[] } | undefined

  const flushHunk = (): void => {
    if (current === undefined || hunk === undefined) return
    const parsed = parseHunkHeader(hunk.header)
    if (parsed === undefined) { hunk = undefined; return }
    current.hunks.push({ ...parsed, lines: hunk.lines, patch: [...header, hunk.header, ...hunk.lines].join('\n') + '\n' })
    hunk = undefined
  }
  const flushFile = (): void => {
    flushHunk()
    if (current !== undefined) files.push(current)
    current = undefined
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushFile()
      const paths = parseDiffHeaderPaths(line)
      header = [line]
      current = { path: paths.newPath, oldPath: paths.oldPath, status: paths.oldPath === paths.newPath ? 'M' : 'R', binary: false, hunks: [] }
      continue
    }
    if (current === undefined) continue
    if (hunk !== undefined && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line.startsWith('\\'))) {
      hunk.lines.push(line)
      continue
    }
    if (line.startsWith('@@')) {
      flushHunk()
      hunk = { header: line, lines: [] }
      continue
    }
    // Header-ish line: belongs to the file block (also closes a hunk run).
    if (hunk === undefined) {
      header.push(line)
      if (line.startsWith('new file mode')) current.status = 'A'
      else if (line.startsWith('deleted file mode')) current.status = 'D'
      else if (line.startsWith('rename from') || line.startsWith('rename to')) current.status = 'R'
      else if (line.startsWith('copy from') || line.startsWith('copy to')) current.status = 'C'
      else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) current.binary = true
    } else {
      flushHunk()
      header.push(line)
    }
  }
  flushFile()
  return files
}

/** `diff --git a/x b/y` → both sides (paths may be quoted when exotic). */
function parseDiffHeaderPaths(line: string): { oldPath: string; newPath: string } {
  const rest = line.slice('diff --git '.length)
  const quoted = /^"((?:\\.|[^"\\])*)" "((?:\\.|[^"\\])*)"$/.exec(rest)
  if (quoted !== null) {
    return { oldPath: unquote(quoted[1] as string), newPath: unquote(quoted[2] as string) }
  }
  // Unquoted paths may contain spaces: split from the middle on ` b/`.
  const split = rest.indexOf(' b/')
  if (split > 0) return { oldPath: rest.slice(0, split).replace(/^a\//, ''), newPath: rest.slice(split + 1).replace(/^b\//, '') }
  return { oldPath: rest, newPath: rest }
}

function unquote(value: string): string {
  return value.replace(/\\(.)/g, (_, ch: string) => {
    switch (ch) {
      case 'n': return '\n'
      case 't': return '\t'
      case 'r': return '\r'
      case '"': return '"'
      case '\\': return '\\'
      default: return ch
    }
  })
}

/** `@@ -a,b +c,d @@ heading` → structured hunk numbers. */
function parseHunkHeader(line: string): Omit<UnifiedHunk, 'lines' | 'patch'> | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line)
  if (match === null) return undefined
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
    heading: (match[5] ?? '').trim(),
  }
}

/** `git show --name-status` body → per-file rows (status letters + paths). */
export function parseCommitFiles(stdout: string): GitCommitFile[] {
  const files: GitCommitFile[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd()
    if (line === '') continue
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const status = line.slice(0, tab).trim()
    const rest = line.slice(tab + 1)
    if (!/^[A-Z]\d*$/.test(status)) continue
    const renamed = status.startsWith('R') || status.startsWith('C')
    if (renamed) {
      const parts = rest.split('\t')
      const from = parts[0] ?? ''
      const to = parts[1] ?? from
      files.push({ status: status[0] as string, path: to, origPath: from })
    } else {
      files.push({ status: status[0] as string, path: rest })
    }
  }
  return files
}

/** `git remote -v` → one row per URL (fetch/push). */
export function parseRemotes(stdout: string): GitRemote[] {
  const remotes: GitRemote[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line)
    if (match === null) continue
    remotes.push({ name: match[1] as string, url: match[2] as string, kind: match[3] as 'fetch' | 'push' })
  }
  return remotes
}

/** `stash list --pretty=format:'%gd%x1f%gs%x1f%ct%x1e'` → entries. */
export function parseStashList(stdout: string): GitStash[] {
  const list: GitStash[] = []
  for (const record of stdout.split('\x1e')) {
    const text = record.replace(/^\n/, '')
    if (text.trim() === '') continue
    const fields = text.split('\x1f')
    if (fields.length < 3) continue
    const [ref, message, date] = fields as [string, string, string]
    if (!/^stash@\{\d+\}$/.test(ref.trim())) continue
    list.push({
      ref: ref.trim(),
      message: message.replace(/^WIP on [^:]*:\s*/, '').trim(),
      date: Number(date.trim()) || 0,
    })
  }
  return list
}

/** `for-each-ref refs/heads refs/remotes` → branches (remote ones flagged). */
export function parseAllBranches(stdout: string, current: string): import('./protocol.ts').GitBranch[] {
  const branches: import('./protocol.ts').GitBranch[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const fields = line.split('\x1f')
    if (fields.length < 5) continue
    const [name, short, upstream, head, full] = fields as [string, string, string, string, string]
    const trimmed = name.trim()
    if (trimmed === '' || trimmed.endsWith('/HEAD')) continue
    branches.push({
      name: trimmed,
      short: short.trim(),
      upstream: upstream.trim(),
      head: head.trim() === '*' || trimmed === current,
      remote: full.trim().startsWith('refs/remotes/'),
    })
  }
  branches.sort((a, b) => {
    if (a.head !== b.head) return a.head ? -1 : 1
    if (a.remote !== b.remote) return a.remote ? 1 : -1
    return a.name.localeCompare(b.name)
  })
  return branches
}

/** Friendly text for the git failures the UI can explain better than git does. */
export function gitErrorHint(stderr: string): string | undefined {
  const text = stderr.trim()
  if (text === '') return undefined
  if (/not a git repository/i.test(text)) return 'not a git repository'
  if (/git: (command )?not found|cannot run git/i.test(text)) return 'git is not installed on the remote host'
  if (/Please tell me who you are|unable to auto-detect email address/i.test(text)) {
    return 'git identity is not configured on the remote host (git config user.name / user.email)'
  }
  if (/could not read Username|Authentication failed|Permission denied \(publickey\)/i.test(text)) {
    return 'remote authentication failed — no credentials available on the remote host'
  }
  if (/CONFLICT|Automatic merge failed/i.test(text)) return 'merge conflict — resolve the marked files, then commit'
  if (/Your local changes.*would be overwritten/i.test(text)) return 'local changes would be overwritten — commit or stash them first'
  if (/\[rejected\]|non-fast-forward/i.test(text)) return 'push rejected (non-fast-forward) — pull or force is required'
  if (/no upstream branch/i.test(text)) return 'the branch has no upstream — publish it first'
  if (/nothing to commit/i.test(text)) return 'nothing to commit'
  return undefined
}
