/**
 * Remote CONTENT search: command builder + output parser for a recursive
 * `grep` over the workspace (the file-NAME search lives in
 * `client/scm/actions.ts`).
 *
 * Pure string work — the command runs through the existing exec route, so no
 * host change is needed. The query never reaches the shell unquoted, output is
 * bounded twice (per line, and per result count), and binary files are skipped
 * so a kernel tree full of `.ko` files cannot flood the wire.
 */
import { assertRemoteDir, shQuote } from './git-format.ts'

/** Directory names always pruned from a recursive search. */
const PRUNE_DIRS = [
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.idea',
  '.gradle',
]

export interface ContentSearchOptions {
  /** Regex (ERE) instead of a literal substring. */
  regex: boolean
  /** Case-sensitive match (grep defaults to sensitive; the UI defaults to off). */
  caseSensitive: boolean
  /** Match whole words only. */
  wholeWord: boolean
  /** Maximum result lines returned (a `head` cap, plus a truncation marker). */
  maxResults: number
  /** Per-line character cap: a minified file must not carry megabytes of one line. */
  maxLineChars: number
  /** Extra directory names to prune. */
  prune?: readonly string[]
}

export const DEFAULT_CONTENT_OPTIONS: ContentSearchOptions = {
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  maxResults: 400,
  maxLineChars: 500,
}

/** Assert a search query (printable, bounded, no NUL/newline). */
export function assertQuery(query: string): string {
  if (typeof query !== 'string') throw new Error('invalid query')
  if (/[\0\n\r]/.test(query)) throw new Error('query contains control characters')
  const trimmed = query.trim()
  if (trimmed === '') throw new Error('empty query')
  if (trimmed.length > 256) throw new Error('query too long')
  return trimmed
}

/**
 * Recursive content search under one absolute remote directory.
 *
 * `--null` puts a NUL between the path and the `line:text` half so a path
 * containing `:` still parses; `cut` bounds each line and `head` bounds the
 * result count (asked for one more than the cap so "truncated" is detectable).
 */
export function contentSearchCommand(dir: string, query: string, options: ContentSearchOptions = DEFAULT_CONTENT_OPTIONS): string {
  const pattern = assertQuery(query)
  const max = Math.min(Math.max(Math.floor(options.maxResults), 1), 2000)
  const lineChars = Math.min(Math.max(Math.floor(options.maxLineChars), 80), 4000)
  const prune = [...PRUNE_DIRS, ...(options.prune ?? [])]
  const parts = [
    'grep -rIn --null --binary-files=without-match',
    ...prune.map(name => `--exclude-dir=${shQuote(name)}`),
    options.caseSensitive ? '' : '-i',
    options.wholeWord ? '-w' : '',
    options.regex ? '-E' : '-F',
    `-e ${shQuote(pattern)}`,
    '--',
    shQuote(assertRemoteDir(dir)),
  ].filter(part => part !== '')
  return `${parts.join(' ')} 2>/dev/null | cut -c1-${lineChars} | head -n ${max + 1}`
}

/** One content-search hit. */
export interface ContentHit {
  /** Absolute remote path. */
  path: string
  /** 1-based line number. */
  line: number
  /** The matching line (possibly truncated by the per-line cap). */
  text: string
}

export interface ContentSearchResult {
  hits: ContentHit[]
  /** True when the result cap cut the listing short. */
  truncated: boolean
  /** True when the per-line cap truncated at least one line. */
  linesClipped: boolean
}

/**
 * Parse the NUL-separated grep output (tolerating a fallback colon format).
 *
 * `maxLineChars` must be the cap the COMMAND was built with, not the default:
 * the parser cannot otherwise know where the `cut` happened, and comparing
 * against the default reports "line clipped" on lines of the wrong length.
 */
export function parseContentHits(
  stdout: string,
  maxResults = DEFAULT_CONTENT_OPTIONS.maxResults,
  maxLineChars = DEFAULT_CONTENT_OPTIONS.maxLineChars,
): ContentSearchResult {
  const hits: ContentHit[] = []
  const max = Math.max(1, Math.floor(maxResults))
  const charCap = Math.max(1, Math.floor(maxLineChars))
  let truncated = false
  let linesClipped = false
  for (const raw of stdout.split('\n')) {
    if (raw === '') continue
    if (raw.length > 4000) break
    let path = ''
    let rest = ''
    const nul = raw.indexOf('\0')
    if (nul >= 0) {
      path = raw.slice(0, nul)
      rest = raw.slice(nul + 1)
    } else {
      // Fallback (a grep without --null): split on the first `:<digits>:`.
      const match = /^(.*?):(\d+):(.*)$/.exec(raw)
      if (match === null) continue
      path = match[1] as string
      rest = `${match[2]}:${match[3]}`
    }
    const colon = rest.indexOf(':')
    if (colon <= 0) continue
    const line = Number(rest.slice(0, colon))
    if (!Number.isFinite(line) || line <= 0) continue
    const text = rest.slice(colon + 1)
    // Compare against the cap the command used. `cut -c1-N` keeps N characters,
    // so a line of exactly N is only "possibly clipped" when it is the LAST
    // field (there is nothing after it to prove otherwise); flag at N-1 to stay
    // conservative, but against the CALLER's N.
    if (text.length >= charCap - 1) linesClipped = true
    if (hits.length >= max) {
      truncated = true
      break
    }
    hits.push({ path, line, text })
  }
  return { hits, truncated, linesClipped }
}

/** Group hits by file for display (keeps hit order). */
export function groupHits(hits: readonly ContentHit[]): { path: string; hits: ContentHit[] }[] {
  const groups: { path: string; hits: ContentHit[] }[] = []
  const index = new Map<string, number>()
  for (const hit of hits) {
    const at = index.get(hit.path)
    if (at === undefined) {
      index.set(hit.path, groups.length)
      groups.push({ path: hit.path, hits: [hit] })
    } else {
      (groups[at] as { path: string; hits: ContentHit[] }).hits.push(hit)
    }
  }
  return groups
}

/**
 * Split a line around every match of the query, for highlighting.
 * A regex that does not compile degrades to a literal match.
 */
export function splitMatches(text: string, query: string, regex: boolean, caseSensitive: boolean): { text: string; hit: boolean }[] {
  const trimmed = query
  if (trimmed === '') return [{ text, hit: false }]
  let pattern: RegExp
  try {
    pattern = regex
      ? new RegExp(trimmed, caseSensitive ? 'g' : 'gi')
      : new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi')
  } catch {
    pattern = new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi')
  }
  const out: { text: string; hit: boolean }[] = []
  let last = 0
  let guard = 0
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match[0] === '') {
      pattern.lastIndex += 1
      continue
    }
    if (guard++ > 200) break
    if (match.index > last) out.push({ text: text.slice(last, match.index), hit: false })
    out.push({ text: match[0], hit: true })
    last = match.index + match[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false })
  return out.length === 0 ? [{ text, hit: false }] : out
}
