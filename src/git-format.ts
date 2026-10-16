/**
 * Shared git helpers: shell-safe command builders + output parsers. Pure
 * functions, zero dependencies — imported by the browser half (git over the
 * existing exec route) and reusable by any host-side caller.
 */
import type { GitBranch, GitCommit, GitShow, GitStatus } from './protocol.ts'

/** Maximum commits per log call. */
export const GIT_LOG_MAX = 200

/** Cap on status file rows (each side). */
const STATUS_ROW_CAP = 200

/** Wrap a value for POSIX sh single-quote context. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Assert an absolute POSIX path (no shell escapes possible after shQuote). */
export function assertRemoteDir(path: string): string {
  if (typeof path !== 'string' || path === '' || path.includes('\0')) throw new Error('path must be a non-empty string')
  const normalized = path.replace(/\\/g, '/')
  if (!normalized.startsWith('/') || normalized.split('/').some(seg => seg === '..')) {
    throw new Error('remote path must be absolute and free of ..')
  }
  return normalized
}

/**
 * A bare ref name plus an optional revision suffix: `^`, `^2`, `^^`, `~`,
 * `~3`, `^2~1`. The suffix is restricted to `^`/`~`/digits, so no shell
 * metacharacter and no `{` can ride in — `@{...}` (reflog, an injection
 * surface) is rejected separately below.
 */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/@-]*(?:\^(?:\d+)?|~\d*)*$/

/** Assert a safe git ref/branch/hash (strict charset, no shell metachars). */
export function assertRef(ref: string): string {
  if (typeof ref !== 'string' || ref === '' || ref.length > 128) throw new Error(`invalid ref: ${ref}`)
  if (ref === 'HEAD') return ref
  if (!REF_RE.test(ref) || ref.includes('..') || ref.includes('@{')) {
    throw new Error(`invalid ref: ${ref}`)
  }
  return ref
}

function gitBase(workdir: string): string {
  return `git -C ${shQuote(assertRemoteDir(workdir))} -c core.quotepath=false`
}

/**
 * Byte cap on one read-only builder's stdout (the same value as `git-ops.ts`'s
 * GIT_CAP — duplicated rather than imported, because git-ops.ts already imports
 * this module).
 *
 * The host's exec route caps what it ACCUMULATES (`pool.appendCapped`,
 * `OUTPUT_CAP`), but that only stops the string growing on this side: without a
 * cap in the command the remote `git` still produces the whole output and ships
 * every byte. `head -c` closes the pipe, so a huge status / diffstat kills the
 * remote git with SIGPIPE instead — which `appendCapped` cannot do.
 *
 * Read-only builders only. A shell pipeline reports its LAST command's status,
 * so a capped command reports `head`'s 0 with an empty stdout instead of its own
 * failure (a missing `git` stops looking like an error to `result.success`).
 * Where the exit code IS the answer, `git-ops.ts` has `statusOk()`: it captures
 * git's status, then emits the same capped bytes and exits with that status.
 */
const GIT_CAP = 2_000_000

function capped(command: string): string {
  return `${command} | head -c ${GIT_CAP}`
}

/** Branch + porcelain status in one call. */
export function statusCommand(workdir: string): string {
  return capped(`${gitBase(workdir)} status --porcelain=v1 -b --untracked-files=normal`)
}

/** Structured log for the graph renderer. */
export function logCommand(workdir: string, max: number, branch?: string): string {
  const count = Math.min(Math.max(Math.floor(max), 20), 500)
  const ref = branch !== undefined && branch !== '' ? ` ${assertRef(branch)}` : ''
  return `${gitBase(workdir)} log --topo-order --pretty=format:'%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e' -n ${count}${ref} --`
}

/** Local branch list. */
export function branchesCommand(workdir: string): string {
  return capped(`${gitBase(workdir)} for-each-ref --format='%(refname:short)%x1f%(objectname:short)%x1f%(upstream:short)%x1f%(HEAD)' refs/heads`)
}

/** Full message of one commit. */
export function messageCommand(workdir: string, ref: string): string {
  return capped(`${gitBase(workdir)} log -1 --pretty=%B ${assertRef(ref)} --`)
}

/** Diffstat of one commit. */
export function statCommand(workdir: string, ref: string): string {
  return capped(`${gitBase(workdir)} show --color=never --stat --oneline ${assertRef(ref)} --`)
}

/** True when stderr reports a non-repository / missing git. */
export function gitFailed(stderr: string): string | undefined {
  if (stderr.includes('not a git repository')) return 'not a git repository'
  if (/git: (command )?not found|cannot run git/i.test(stderr)) return 'git is not installed on the remote host'
  return undefined
}

// ------------------------------------------------------------- parsers

/** Parse `status --porcelain=v1 -b` into branch + file rows. */
export function parseStatus(stdout: string): GitStatus {
  const lines = stdout.split('\n')
  const head = lines[0] ?? ''
  let branch = ''
  let detached = false
  let ahead = 0
  let behind = 0
  const branchMatch = /^## ([^\s.]+(?:\.\.\.[^\s[]+)?)(?: \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?/.exec(head)
  if (branchMatch !== null) {
    const name = branchMatch[1] as string
    if (name === 'HEAD' || name.startsWith('HEAD ')) {
      detached = true
      branch = 'HEAD (detached)'
    } else {
      branch = name.includes('...') ? (name.split('...')[0] as string) : name
    }
    ahead = branchMatch[2] !== undefined ? Number(branchMatch[2]) : 0
    behind = branchMatch[3] !== undefined ? Number(branchMatch[3]) : 0
  } else if (head.startsWith('## HEAD (no branch')) {
    detached = true
    branch = 'HEAD (detached)'
  }
  const staged: GitStatus['staged'] = []
  const unstaged: GitStatus['unstaged'] = []
  const untracked: string[] = []
  let truncated = false
  let kept = 0
  for (const line of lines.slice(1)) {
    if (line.length < 4) continue
    const x = line[0] as string
    const y = line[1] as string
    let path = line.slice(3)
    const arrow = path.indexOf(' -> ')
    if (arrow >= 0) path = path.slice(arrow + 4)
    if (x === '?' && y === '?') {
      if (untracked.length < STATUS_ROW_CAP) untracked.push(path)
      else truncated = true
      continue
    }
    if (kept >= STATUS_ROW_CAP * 2) {
      truncated = true
      continue
    }
    kept += 1
    const row = { path, staged: x, unstaged: y }
    if (x !== ' ' && x !== '?') staged.push(row)
    if (y !== ' ' && y !== '?') unstaged.push(row)
  }
  return { branch, detached, ahead, behind, staged, unstaged, untracked, truncated }
}

/** Parse the \x1f/\x1e log format into commits. */
export function parseLog(stdout: string): GitCommit[] {
  const commits: GitCommit[] = []
  for (const record of stdout.split('\x1e')) {
    const text = record.startsWith('\n') ? record.slice(1) : record
    if (text.trim() === '') continue
    const fields = text.split('\x1f')
    if (fields.length < 7) continue
    const [hash, parents, author, email, date, refs, subject] = fields as [string, string, string, string, string, string, string]
    if (!/^[0-9a-f]{4,40}$/.test(hash.trim())) continue
    commits.push({
      hash: hash.trim(),
      parents: parents.trim() === '' ? [] : parents.trim().split(' '),
      author: author.trim(),
      email: email.trim(),
      date: Number(date.trim()) || 0,
      refs: refs.split(',').map(r => r.trim()).filter(r => r !== ''),
      subject: subject.trim(),
    })
  }
  return commits
}

/** Parse for-each-ref branch lines. */
export function parseBranches(stdout: string, current: string): GitBranch[] {
  const branches: GitBranch[] = []
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    const fields = line.split('\x1f')
    if (fields.length < 4) continue
    const [name, short, upstream, head] = fields as [string, string, string, string]
    branches.push({ name: name.trim(), short: short.trim(), upstream: upstream.trim(), head: head.trim() === '*' || name.trim() === current })
  }
  branches.sort((a, b) => (a.head === b.head ? a.name.localeCompare(b.name) : a.head ? -1 : 1))
  return branches
}

/** Assemble commit detail from message + stat outputs. */
export function parseShow(hash: string, message: string, stat: string): GitShow {
  const lines = message.split('\n')
  const subject = (lines[0] ?? '').trim()
  const body = lines.slice(1).join('\n').trim()
  return { hash, subject, body, stat: stat.trim() }
}
