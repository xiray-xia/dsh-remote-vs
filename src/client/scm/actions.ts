/**
 * Remote git action layer: every SCM verb the UI can trigger, expressed as
 * one remote command through the existing exec route.
 *
 * Nothing here needs a host-side change: the command builders live in
 * `src/git-ops.ts` (asserted + single-quoted, so a file name can never escape
 * into shell syntax), the parsers are pure, and errors are translated to the
 * messages a user can act on (missing identity, no upstream, conflicts, ...).
 */
import { REMOTE_API } from '../../protocol.ts'
import type { GitBranch, GitCommitFile, GitRemote, GitStash, GitStatusDetail, RemoteExecResult, RemoteRead } from '../../protocol.ts'
import { assertRef, shQuote } from '../../git-format.ts'
import {
  addRemoteCommand,
  allBranchesCommand,
  applyPatchCommand,
  branchHeaderCommand,
  checkoutCommand,
  cleanUntrackedCommand,
  commitCommand,
  commitFilesCommand,
  createBranchCommand,
  deleteBranchCommand,
  diffCommand,
  fetchCommand,
  fileAtRevCommand,
  gitErrorHint,
  headMessageCommand,
  mergeCommand,
  parseAllBranches,
  parseCommitFiles,
  parseRemotes,
  parseRepoDiscovery,
  parseRepoRoot,
  parseStashList,
  parseStatusDetail,
  pullCommand,
  publishBranchCommand,
  pushCommand,
  remotesCommand,
  removeRemoteCommand,
  renameBranchCommand,
  repoDiscoveryCommand,
  repoProbeCommand,
  restoreWorktreeCommand,
  setRemoteUrlCommand,
  stageCommand,
  stashApplyCommand,
  stashDropCommand,
  stashListCommand,
  stashPopCommand,
  stashSaveCommand,
  statusDetailCommand,
  statusDirCommand,
  statusPathsCommand,
  unstageCommand,
} from '../../git-ops.ts'
import { api, gitTimeoutMs } from '../api.ts'
import { DEFAULT_GIT_TIMEOUT_MS, MAX_TIMEOUT_MS, timeoutSeconds } from '../../timeouts.ts'

/** Error carrying a message already fit for the UI. */
export class GitOpError extends Error {}

/** Join a remote directory with a repo-relative path. */
export function joinRemote(dir: string, rel: string): string {
  const base = dir.replace(/\/+$/, '')
  const clean = rel.replace(/^\/+/, '')
  return clean === '' ? base : `${base}/${clean}`
}

/**
 * Per-command budgets.
 *
 * These were fixed (120 s normal / 300 s network) and were the reason a large
 * remote repository reported "git timed out" while git was still working: the
 * explorer's own client deadline cut in even earlier. Both now follow the
 * configured `gitTimeoutMs` (default 300 s), and the network verbs get double
 * that (capped by the Host route's ceiling), because fetch/pull/push on a big
 * tree legitimately outlast a status read.
 */
const normalTimeoutMs = (): number => gitTimeoutMs()
const longTimeoutMs = (): number => Math.min(MAX_TIMEOUT_MS, Math.max(DEFAULT_GIT_TIMEOUT_MS, gitTimeoutMs() * 2))

/** Run one command, raising a readable error on a non-zero exit. */
async function run(alias: string, command: string, timeoutMs = normalTimeoutMs()): Promise<RemoteExecResult> {
  const result = await api.exec(alias, command, timeoutMs)
  if (result.success) return result
  if (result.timedOut) {
    throw new GitOpError(`git timed out after ${timeoutSeconds(timeoutMs)} — the repository may be large or the host busy; raise gitTimeoutMs in the plugin settings`)
  }
  const hint = gitErrorHint(result.stderr) ?? gitErrorHint(result.stdout)
  const detail = result.stderr.trim() !== '' ? result.stderr.trim() : (result.stdout.trim() !== '' ? result.stdout.trim() : '')
  throw new GitOpError(hint ?? detail ?? result.error ?? `git failed [exit code: ${result.exitCode ?? '?'}]`)
}

/** Run one command tolerating failure (returns '' instead). */
async function tryRun(alias: string, command: string, timeoutMs = normalTimeoutMs()): Promise<string> {
  try {
    const result = await api.exec(alias, command, timeoutMs)
    return result.success ? result.stdout : ''
  } catch {
    return ''
  }
}

// ------------------------------------------------------------- read paths

/** The repository that encloses a workspace directory (undefined when none). */
export async function resolveRepoRoot(alias: string, workspaceRoot: string): Promise<string | undefined> {
  const out = await tryRun(alias, repoProbeCommand(workspaceRoot), 60_000)
  return parseRepoRoot(out)
}

/** Repositories under a workspace root (the workspace itself sorts first). */
export async function findRepos(alias: string, workspaceRoot: string): Promise<string[]> {
  const direct = await resolveRepoRoot(alias, workspaceRoot)
  if (direct !== undefined) return [direct]
  const out = await tryRun(alias, repoDiscoveryCommand(workspaceRoot), 90_000)
  return parseRepoDiscovery(out)
}

/** Every changed path plus the ignored half. */
export async function loadStatusDetail(alias: string, root: string): Promise<GitStatusDetail> {
  const out = await run(alias, statusDetailCommand(root))
  return parseStatusDetail(out.stdout)
}

/**
 * Pathspec-limited status probe: the raw `-z` stdout for JUST these paths.
 *
 * The verification half of a stage/unstage. It deliberately does not go through
 * `loadStatusDetail`: that command walks the whole repository (minutes on a
 * large one), while this one is bounded by the paths handed to it — which is
 * what lets the panel confirm an optimistic stage immediately.
 *
 * The budget is the read-path one (60 s), not the git budget: a probe that
 * hangs must not hold the panel for the full git timeout.
 *
 * @param alias - host alias.
 * @param root - absolute remote repository root (git runs here).
 * @param paths - repo-relative paths that were just staged/unstaged.
 * @returns the raw `-z` porcelain stdout ('' when nothing was asked).
 */
export async function probeStatusPaths(alias: string, root: string, paths: readonly string[]): Promise<string> {
  if (paths.length === 0) return ''
  const out = await run(alias, statusPathsCommand(root, paths), 60_000)
  return out.stdout
}

/**
 * Expand ONE untracked directory row: the raw `-z` stdout for what is inside.
 *
 * `-uall` is what makes the contents visible at all (the panel's own status call
 * uses `-u normal`, which collapses a directory into one row), and the pathspec
 * keeps the cost bounded by that directory — this must never become a
 * repository-wide walk.
 */
export async function probeStatusDir(alias: string, root: string, dir: string): Promise<string> {
  const out = await run(alias, statusDirCommand(root, dir), 60_000)
  return out.stdout
}

/** Current branch with its ahead/behind counters (detached HEAD tolerated). */
export async function loadHead(alias: string, root: string): Promise<{ branch: string; detached: boolean; ahead: number; behind: number }> {
  const out = await tryRun(alias, branchHeaderCommand(root), 60_000)
  const first = (out.split('\0')[0] ?? out.split('\n')[0] ?? '').replace(/^## /, '').trim()
  if (first === '' || first.startsWith('HEAD (no branch')) return { branch: 'HEAD', detached: true, ahead: 0, behind: 0 }
  const match = /^([^\s.]+(?:\.\.\.[^\s[]+)?)(?: \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?/.exec(first)
  if (match === null) return { branch: first, detached: false, ahead: 0, behind: 0 }
  const name = match[1] as string
  const detached = name === 'HEAD' || name.startsWith('HEAD ')
  return {
    branch: detached ? 'HEAD (detached)' : (name.includes('...') ? (name.split('...')[0] as string) : name),
    detached,
    ahead: match[2] === undefined ? 0 : Number(match[2]),
    behind: match[3] === undefined ? 0 : Number(match[3]),
  }
}

/** Both sides of a diff plus the diff itself. */
export interface DiffPayload {
  diff: string
  oldText: string
  newText: string
  /** True when either side is binary (the view refuses to render it). */
  unsupported: boolean
}

/** Load a file's diff with both full revisions. */
export async function loadDiff(alias: string, root: string, path: string, staged: boolean, untracked = false): Promise<DiffPayload> {
  if (untracked) {
    const read = await api.fileOp.read(alias, joinRemote(root, path))
    if (read.binary) return { diff: '', oldText: '', newText: '', unsupported: true }
    return { diff: '', oldText: '', newText: read.text ?? '', unsupported: false }
  }
  const diffOut = await run(alias, diffCommand(root, { staged, path }))
  const diff = diffOut.stdout
  if (/^Binary files .* differ$/m.test(diff) || diff.includes('GIT binary patch')) {
    return { diff, oldText: '', newText: '', unsupported: true }
  }
  const oldRev = staged ? 'HEAD' : ':0'
  const oldText = await tryRun(alias, fileAtRevCommand(root, oldRev, path))
  let newText = ''
  if (staged) {
    newText = await tryRun(alias, fileAtRevCommand(root, ':0', path))
  } else {
    try {
      const read = await api.fileOp.read(alias, joinRemote(root, path))
      if (read.binary) return { diff, oldText, newText: '', unsupported: true }
      newText = read.text ?? ''
    } catch {
      // Deleted on the worktree: the right side is empty by definition.
      newText = ''
    }
  }
  // `git show` appends nothing; a missing blob means "new file" ('').
  return { diff, oldText: stripTrailingNewline(oldText), newText: stripTrailingNewline(newText), unsupported: false }
}

/** `git show` output keeps the trailing newline the file content does not need. */
function stripTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

/** Files touched by one commit. */
export async function loadCommitFiles(alias: string, root: string, hash: string): Promise<GitCommitFile[]> {
  const out = await run(alias, commitFilesCommand(root, hash), 60_000)
  return parseCommitFiles(out.stdout)
}

/** Diff of one path inside a commit (used by the history file drill-down). */
export async function loadCommitFileDiff(alias: string, root: string, hash: string, path: string): Promise<DiffPayload> {
  const out = await run(alias, diffCommand(root, { ref: `${hash}^`, path }), 90_000)
  const oldText = await tryRun(alias, fileAtRevCommand(root, `${hash}^`, path))
  const newText = await tryRun(alias, fileAtRevCommand(root, hash, path))
  return {
    diff: out.stdout,
    oldText: stripTrailingNewline(oldText),
    newText: stripTrailingNewline(newText),
    unsupported: /^Binary files .* differ$/m.test(out.stdout),
  }
}

/** Local + remote-tracking branches. */
export async function loadBranches(alias: string, root: string, current: string): Promise<GitBranch[]> {
  const out = await run(alias, allBranchesCommand(root), 60_000)
  return parseAllBranches(out.stdout, current.replace(/ \(detached\)$/, ''))
}

/** Configured remotes. */
export async function loadRemotes(alias: string, root: string): Promise<GitRemote[]> {
  const out = await run(alias, remotesCommand(root), 60_000)
  return parseRemotes(out.stdout)
}

/** The stash stack. */
export async function loadStashes(alias: string, root: string): Promise<GitStash[]> {
  const out = await run(alias, stashListCommand(root), 60_000)
  return parseStashList(out.stdout)
}

// ------------------------------------------------------------ write paths

/** Stage paths (additions, edits, deletions, renames). */
export async function stagePaths(alias: string, root: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return
  await run(alias, stageCommand(root, paths))
}

/** Unstage paths without touching the worktree. */
export async function unstagePaths(alias: string, root: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return
  await run(alias, unstageCommand(root, paths))
}

/**
 * Discard worktree edits. Untracked paths are DELETED (the caller confirms
 * first); tracked paths are restored from the index.
 */
export async function discardPaths(
  alias: string,
  root: string,
  tracked: readonly string[],
  untracked: readonly string[],
): Promise<void> {
  if (tracked.length > 0) await run(alias, restoreWorktreeCommand(root, tracked))
  if (untracked.length > 0) await run(alias, cleanUntrackedCommand(root, untracked))
}

/**
 * Apply one hunk: into the index (`stage`), out of the index (`unstage`), or
 * out of the worktree (`revert`). The patch travels as a temp file because
 * the exec route has no stdin channel — which also keeps the patch text away
 * from shell quoting entirely.
 */
export async function applyHunk(
  alias: string,
  root: string,
  patch: string,
  mode: 'stage' | 'unstage' | 'revert',
): Promise<void> {
  if (patch.trim() === '') throw new GitOpError('empty patch')
  const remotePath = `/tmp/dsh-rvs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.patch`
  await api.fileOp.write(alias, remotePath, patch)
  try {
    await run(alias, applyPatchCommand(root, remotePath, mode), 60_000)
  } catch (error) {
    // The `rm -f` rides the same command line, so a failure still cleans up.
    throw error instanceof GitOpError ? error : new GitOpError(String(error))
  }
}

/** Create a commit. */
export async function commitAll(alias: string, root: string, message: string, amend = false): Promise<string> {
  const out = await run(alias, commitCommand(root, { message, amend }))
  return out.stdout
}

/** Last commit message (drives the amend flow). */
export async function lastCommitMessage(alias: string, root: string): Promise<string> {
  return (await tryRun(alias, headMessageCommand(root), 30_000)).trim()
}

/** fetch / pull / push / sync. */
export async function syncRepo(alias: string, root: string, kind: 'fetch' | 'pull' | 'push' | 'sync'): Promise<string> {
  if (kind === 'fetch') return (await run(alias, fetchCommand(root), longTimeoutMs())).stdout
  if (kind === 'pull') return (await run(alias, pullCommand(root), longTimeoutMs())).stdout
  if (kind === 'push') return (await run(alias, pushCommand(root), longTimeoutMs())).stdout
  const pulled = (await run(alias, pullCommand(root), longTimeoutMs())).stdout
  const pushed = (await run(alias, pushCommand(root), longTimeoutMs())).stdout
  return `${pulled}\n${pushed}`.trim()
}

/** Branch verbs. */
export async function branchOp(
  alias: string,
  root: string,
  op: { kind: 'checkout'; ref: string }
    | { kind: 'create'; name: string; from?: string }
    | { kind: 'delete'; name: string; force: boolean }
    | { kind: 'rename'; from: string; to: string }
    | { kind: 'merge'; ref: string }
    | { kind: 'publish'; name: string; remote: string },
): Promise<string> {
  switch (op.kind) {
    case 'checkout': return (await run(alias, checkoutCommand(root, op.ref), longTimeoutMs())).stdout
    case 'create': return (await run(alias, createBranchCommand(root, op.name, op.from), longTimeoutMs())).stdout
    case 'delete': return (await run(alias, deleteBranchCommand(root, op.name, op.force), 60_000)).stdout
    case 'rename': return (await run(alias, renameBranchCommand(root, op.from, op.to), 60_000)).stdout
    case 'merge': return (await run(alias, mergeCommand(root, op.ref), longTimeoutMs())).stdout
    case 'publish': return (await run(alias, publishBranchCommand(root, op.name, op.remote), longTimeoutMs())).stdout
    default: return ''
  }
}

/** Remote verbs. */
export async function remoteOp(
  alias: string,
  root: string,
  op: { kind: 'add'; name: string; url: string }
    | { kind: 'remove'; name: string }
    | { kind: 'setUrl'; name: string; url: string },
): Promise<string> {
  switch (op.kind) {
    case 'add': return (await run(alias, addRemoteCommand(root, op.name, op.url), 60_000)).stdout
    case 'remove': return (await run(alias, removeRemoteCommand(root, op.name), 60_000)).stdout
    case 'setUrl': return (await run(alias, setRemoteUrlCommand(root, op.name, op.url), 60_000)).stdout
    default: return ''
  }
}

/** Stash verbs. */
export async function stashOp(
  alias: string,
  root: string,
  op: { kind: 'save'; message: string; includeUntracked: boolean }
    | { kind: 'apply'; ref: string }
    | { kind: 'pop'; ref: string }
    | { kind: 'drop'; ref: string },
): Promise<string> {
  switch (op.kind) {
    case 'save': return (await run(alias, stashSaveCommand(root, op.message, op.includeUntracked), 60_000)).stdout
    case 'apply': return (await run(alias, stashApplyCommand(root, op.ref), 60_000)).stdout
    case 'pop': return (await run(alias, stashPopCommand(root, op.ref), 60_000)).stdout
    case 'drop': return (await run(alias, stashDropCommand(root, op.ref), 60_000)).stdout
    default: return ''
  }
}

/** Check out one commit (detached HEAD; the UI warns first). */
export async function checkoutCommit(alias: string, root: string, hash: string): Promise<string> {
  return (await run(alias, checkoutCommand(root, assertRef(hash)), longTimeoutMs())).stdout
}

// ------------------------------------------------------------------ search

/** One file-name search hit. */
export interface SearchHit {
  path: string
  name: string
  dir: string
  isDir: boolean
}

/** Sanitize a name fragment for the remote `find` pattern. */
function assertQuery(query: string): string {
  const clean = query.replace(/['"\\\0\r\n]/g, '').trim()
  if (clean === '') throw new GitOpError('empty query')
  if (clean.length > 128) throw new GitOpError('query too long')
  return clean
}

/**
 * Directory names a NAME search never walks.
 *
 * The old `find` prune list plus one addition: `out` is build output (the
 * content search already prunes it), and on an AOSP tree with a populated `out/`
 * walking it would cost far more than the depth cap it replaces ever did.
 */
const NAME_PRUNE_DIRS = ['.git', 'node_modules', '.venv', 'dist', 'build', 'out']

/**
 * Name search under a remote directory: `rg` when the host has it, `find` when
 * it does not — decided BY THE HOST inside one command, so there is no probe
 * round trip and no per-alias cache to invalidate.
 *
 * Why the fallback exists at all: the previous implementation was `find` with a
 * hard `-maxdepth 6`, and that cap silently hid real files. Measured on the repo-a
 * monorepo (~4M files), `b0/vendor/oem/usdk/services/src/com/android/server/
 * KeySystemService.java` sits 10 levels down: `find -maxdepth 6` returns 0
 * hits (2.0 s), `find -maxdepth 12` returns it but costs 13.5 s, and an uncapped
 * `find` over that tree does not finish at all. `rg --files --iglob` answers the
 * same query in ~4 s with no depth limit, because it walks the tree once with a
 * prefiltered glob instead of stat-ing every entry.
 *
 * Coverage: `--no-ignore --hidden` keeps what `find` did — it never consulted
 * .gitignore — so a generated or ignored file is still findable by name. The
 * fallback keeps a cap (raised from 6 to 12) because an uncapped walk is not
 * viable on a tree that size.
 *
 * The query is a GLOB fragment (as it always was): `*.java` still works as a
 * pattern, and `--iglob` matches case-insensitively like `find -iname`.
 */
export async function searchFiles(
  alias: string,
  root: string,
  query: string,
  limit = 120,
  depth = 12,
): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  const clean = assertQuery(query)
  const cap = Math.min(Math.max(Math.floor(limit), 1), 400)
  const pattern = `*${clean}*`
  const prunes = NAME_PRUNE_DIRS.map(name => `-g ${shQuote(`!**/${name}/**`)}`).join(' ')
  const rg = `rg --files --no-ignore --hidden --iglob ${shQuote(pattern)} ${prunes} ${shQuote(root)} 2>/dev/null`
  // `-printf '%p\t%y'` carries the entry type, because `find -print` never emits
  // a trailing slash for directories — the old `line.endsWith('/')` test could
  // therefore never be true and every hit was reported as a file (so a directory
  // hit was routed into openFile). GNU/BusyBox find support -printf; the
  // content-search builder already depends on GNU grep flags. rg's `--files`
  // prints bare paths (files only), which the parser below already tolerates.
  const find = `find ${shQuote(root)} -maxdepth ${depth} `
    + `\\( ${NAME_PRUNE_DIRS.map(name => `-name ${shQuote(name)}`).join(' -o ')} \\) -prune -o `
    + `\\( -type f -o -type d \\) -iname ${shQuote(pattern)} -printf '%p\\t%y\\n' 2>/dev/null`
  const command = `if command -v rg >/dev/null 2>&1; then ${rg}; else ${find}; fi | head -n ${cap + 1}`
  const out = await tryRun(alias, command, 90_000)
  const lines = out.split('\n').map(line => line.trim()).filter(line => line !== '')
  const truncated = lines.length > cap
  const base = root.replace(/\/+$/, '')
  const hits: SearchHit[] = []
  for (const raw of lines.slice(0, cap)) {
    const isDir = raw.endsWith('\td')
    const line = isDir || raw.endsWith('\tf') ? raw.slice(0, -2) : raw
    const rel = line.startsWith(`${base}/`) ? line.slice(base.length + 1) : line
    const cut = rel.lastIndexOf('/')
    hits.push({
      path: rel,
      name: cut < 0 ? rel : rel.slice(cut + 1),
      dir: cut < 0 ? '' : rel.slice(0, cut),
      isDir,
    })
  }
  return { hits, truncated }
}

/** Read a remote file as text/base64 (used by the previews). */
export async function readRemoteFile(alias: string, fullPath: string): Promise<RemoteRead> {
  return api.fileOp.read(alias, fullPath)
}

/** The terminal API base (kept here so both halves agree on the route table). */
export { REMOTE_API }
