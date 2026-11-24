/**
 * Pure parsing/formatting for `git blame` (and the shared vocabulary the
 * editor UI uses for a line's provenance). No CodeMirror and no DOM here, so
 * the gate can feed it real porcelain output.
 */

import type { GitCommit } from '../protocol.ts'
import { unquoteGitPath } from '../git-format.ts'

/** One blamed line: 1-based final line number plus the commit that owns it. */
export interface BlameLine {
  line: number
  hash: string
  author: string
  email: string
  /** Author timestamp, seconds since the epoch (git's `author-time`). */
  time: number
  summary: string
}

/** A run of consecutive lines owned by the same commit. */
export interface BlameRun {
  from: number
  to: number
  hash: string
}

/** One `--follow` file-history row, plus the name the file had in that commit. */
export interface FileHistoryCommit extends GitCommit {
  /** Path to show/diff for THIS commit (old name before a rename). */
  path: string
  /** Rename source when this commit renamed the file. */
  origPath?: string
}

const HEADER = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/

/**
 * Parse `git blame --line-porcelain`.
 *
 * `--line-porcelain` repeats the commit header and metadata for every line (no
 * previous-commit grouping), which keeps this parser stateless: a header starts
 * a record, the metadata lines fill it, and the tab-prefixed content line ends
 * it. Lines that do not match the shape are ignored rather than aborting the
 * whole read — a partially understood blame is still useful.
 */
export function parseBlamePorcelain(stdout: string): BlameLine[] {
  const rows: BlameLine[] = []
  let current: {
    hash: string
    line: number
    author?: string
    email?: string
    time?: number
    summary?: string
  } | undefined
  for (const raw of stdout.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const header = HEADER.exec(line)
    if (header !== null) {
      current = { hash: header[1] as string, line: Number(header[2]) }
      continue
    }
    if (current === undefined) continue
    if (line.startsWith('\t')) {
      rows.push({
        line: current.line,
        hash: current.hash,
        author: current.author ?? '',
        email: current.email ?? '',
        time: current.time ?? 0,
        summary: current.summary ?? '',
      })
      current = undefined
      continue
    }
    const space = line.indexOf(' ')
    if (space < 0) continue
    const key = line.slice(0, space)
    const value = line.slice(space + 1)
    if (key === 'author') current.author = value
    else if (key === 'author-mail') current.email = value.replace(/^<|>$/g, '')
    else if (key === 'author-time') current.time = Number(value) || 0
    else if (key === 'summary') current.summary = value
  }
  return rows
}

/** Group consecutive lines of one commit; non-adjacent runs stay separate. */
export function blameRuns(rows: readonly BlameLine[]): BlameRun[] {
  const runs: BlameRun[] = []
  let previous: BlameLine | undefined
  for (const row of rows) {
    if (previous !== undefined && previous.hash === row.hash && previous.line + 1 === row.line) {
      const run = runs[runs.length - 1]
      if (run !== undefined) run.to = row.line
    } else {
      runs.push({ from: row.line, to: row.line, hash: row.hash })
    }
    previous = row
  }
  return runs
}

/** Short author name for the narrow blame gutter. */
export function shortAuthor(author: string): string {
  const name = author.trim()
  if (name === '') return '?'
  return name.length <= 10 ? name : `${name.slice(0, 9)}…`
}

/**
 * Relative age labels, deliberately compact (`now`, `5m`, `3h`, `2d`, `4w`,
 * `3mo`, `2y`) because this text lives in a gutter.
 */
export function relativeBlameTime(timeSeconds: number, nowSeconds: number = Math.floor(Date.now() / 1000)): string {
  if (!Number.isFinite(timeSeconds) || timeSeconds <= 0) return '?'
  const diff = Math.max(0, nowSeconds - timeSeconds)
  if (diff < 60) return 'now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h`
  if (diff < 7 * 86_400) return `${Math.floor(diff / 86_400)}d`
  if (diff < 30 * 86_400) return `${Math.floor(diff / (7 * 86_400))}w`
  if (diff < 365 * 86_400) return `${Math.floor(diff / (30 * 86_400))}mo`
  return `${Math.floor(diff / (365 * 86_400))}y`
}

/** One-line gutter label: author initials/name plus relative age. */
export function blameLabel(row: BlameLine, nowSeconds: number = Math.floor(Date.now() / 1000)): string {
  return `${shortAuthor(row.author)} · ${relativeBlameTime(row.time, nowSeconds)}`
}

/**
 * Hover text: full attribution. The browser renders `title` as plain text, so
 * no markup is needed (and no translator dependency leaks into the model).
 */
export function blameTitle(row: BlameLine): string {
  const when = row.time > 0 ? new Date(row.time * 1000).toLocaleString() : 'unknown date'
  const email = row.email === '' ? '' : `\n${row.email}`
  return `${row.author || 'unknown author'}${email}\n${when}\n${row.hash}\n${row.summary}`.trim()
}

/** False for git's all-zero "not committed yet" pseudo-commit. */
export function isCommittedBlame(hash: string): boolean {
  return !/^0{40,64}$/.test(hash)
}

/**
 * The next `-L` window to request, or undefined when the viewport is covered.
 *
 * Pure and exported so the gate can prove the "3000-line file only asks for
 * the visible window" requirement without a browser. `overscan` keeps a small
 * buffer above/below so a normal scroll does not immediately need a new call.
 */
export function planBlameWindow(
  first: number,
  last: number,
  total: number,
  covered: ReadonlySet<number>,
  overscan = 40,
): { from: number; to: number } | undefined {
  if (!Number.isFinite(first) || !Number.isFinite(last) || !Number.isFinite(total) || total < 1) return undefined
  const from = Math.max(1, Math.min(first, total) - Math.max(0, Math.floor(overscan)))
  const to = Math.min(total, Math.max(last, first) + Math.max(0, Math.floor(overscan)))
  if (to < from) return undefined
  for (let line = from; line <= to; line += 1) {
    if (!covered.has(line)) return { from, to }
  }
  return undefined
}

interface NameStatusRow {
  path: string
  origPath?: string
}

/** Parse one `--name-status` row; C/R rows carry an old path as well. */
function parseNameStatusRow(raw: string): NameStatusRow | undefined {
  const fields = raw.split('\t')
  if (fields.length < 2) return undefined
  const status = fields[0] as string
  const first = fields[1] as string
  const second = fields[2] as string | undefined
  const path = unquoteGitPath(second ?? first)
  if (path === '') return undefined
  const origPath = second === undefined ? undefined : unquoteGitPath(first)
  return status.startsWith('R') || status.startsWith('C')
    ? { path, ...(origPath === undefined ? {} : { origPath }) }
    : { path }
}

/**
 * Parse `git log --follow --name-status -M` output into per-commit rows.
 *
 * `--follow` reports the file under its name AT THAT COMMIT. Starting from the
 * current name and walking newest→oldest, each rename row supplies the next
 * (older) name, so a click on an old history row opens the right path instead
 * of an empty diff for the current name.
 */
export function parseFileHistory(stdout: string, currentPath: string): FileHistoryCommit[] {
  const commits: FileHistoryCommit[] = []
  let wanted = currentPath
  for (const block of stdout.split('\0')) {
    const lines = block.replace(/^\r?\n/, '').split(/\r?\n/).filter(line => line.trim() !== '')
    if (lines.length === 0) continue
    const [hash, parents, author, email, date, refs, subject] = (lines[0] as string).split('\x1f') as [
      string, string, string, string, string, string, string,
    ]
    if (!/^[0-9a-f]{4,64}$/.test((hash ?? '').trim())) continue
    const statuses = lines.slice(1).flatMap(line => {
      const row = parseNameStatusRow(line)
      return row === undefined ? [] : [row]
    })
    let path = wanted
    let origPath: string | undefined
    const rename = statuses.find(row => row.path === wanted && row.origPath !== undefined)
    if (rename !== undefined) {
      path = wanted
      origPath = rename.origPath
      wanted = rename.origPath as string
    } else if (statuses.some(row => row.path === wanted)) {
      path = wanted
    } else if (statuses.length === 1) {
      // A path-limited log normally has one status row; trust it when the
      // rename chain did not line up (e.g. a merge or an unusual rename).
      path = (statuses[0] as NameStatusRow).path
      origPath = (statuses[0] as NameStatusRow).origPath
    }
    commits.push({
      hash: (hash as string).trim(),
      parents: (parents ?? '').trim() === '' ? [] : (parents as string).trim().split(' '),
      author: (author ?? '').trim(),
      email: (email ?? '').trim(),
      date: Number(date) || 0,
      refs: (refs ?? '').split(',').map(item => item.trim()).filter(item => item !== ''),
      subject: (subject ?? '').trim(),
      path,
      ...(origPath === undefined ? {} : { origPath }),
    })
  }
  return commits
}
