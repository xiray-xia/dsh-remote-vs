/**
 * Terminal path links: find path-like tokens in a terminal line and turn them
 * into absolute remote paths (pure, no xterm/DOM).
 *
 * The terminal prints paths constantly (compiler errors, `ls`, `grep`, logs) and
 * the tree already knows how to reveal a folder over SFTP, so the missing piece
 * is only "which text is a path, and what absolute path does it mean". Both
 * questions are decided here; the xterm link provider and the store action are
 * thin wiring on top.
 *
 * Scope decisions (kept deliberately conservative — a wrong jump is worse than a
 * missing one):
 *  - absolute (`/opt/src/a.c`), home-relative (`~/build.log`) and relative
 *    tokens that contain a `/` (`v_sys/system/core.c`) are offered;
 *  - a `:line` / `:line:col` suffix is stripped (`src/a.ts:12:5` → `src/a.ts`);
 *  - URLs, flags (`--opt/x`) and pure numbers are not links;
 *  - resolution never guesses silently: it returns a CANDIDATE list, and the
 *    caller validates each candidate against the host before acting.
 */

/** One path-looking range inside a terminal line. */
export interface TerminalPathToken {
  /** 0-based index of the first character. */
  start: number
  /** 0-based index of the LAST character (inclusive). */
  end: number
  /** The path itself, with any `:line(:col)` suffix removed. */
  path: string
}

/** Everything {@link resolutionCandidates} may use to anchor a relative token. */
export interface PathResolutionContext {
  /** Remote home directory, when knowable (derived from the SSH user). */
  home?: string
  /** Shell working directory, when the shell reports it (OSC 7). */
  cwd?: string
  /** Remote workspace roots on this host, most specific first. */
  roots?: readonly string[]
}

/**
 * A run that may be a path: either an explicitly rooted form (`/`, `~/`, `./`,
 * `../`) or a relative one that contains a `/` with a non-empty first segment.
 */
const PATH_RUN = /(?:~\/|\/|\.{1,2}\/|[A-Za-z0-9_.@%+-]+\/)[A-Za-z0-9_.%+/@~-]*/g

/** Characters that end a path when they are the LAST character (sentence/quote noise). */
const TRAILING_NOISE = new Set(['.', ',', ':', ';', '!', '?', ')', ']', '}', '>', '"', "'", '`'])

/** `file.ts:12` / `file.ts:12:5` — the part editors and compilers append. */
const LOCATION_SUFFIX = /^(.*?):(\d+)(?::(\d+))?$/

/** Lower-case file extension-ish tail that a sentence dot must not eat. */
function stripLocationSuffix(raw: string): string {
  const match = LOCATION_SUFFIX.exec(raw)
  if (match === null) return raw
  const base = match[1] ?? ''
  // `10:30` is a time, not a path: a location suffix needs a path-shaped base
  // (absolute or with a directory separator).
  if (base === '' || !base.includes('/')) return raw
  return base
}

/** Collapse `//`, resolve `.`/`..` and drop a trailing slash (POSIX semantics). */
export function normalizeRemotePath(path: string): string {
  const absolute = path.startsWith('/')
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
      else if (!absolute) parts.push('..')
      continue
    }
    parts.push(part)
  }
  const joined = parts.join('/')
  if (absolute) return parts.length === 0 ? '/' : `/${joined}`
  return joined === '' ? '.' : joined
}

/** Join a base directory and a relative token (POSIX, no trailing slash). */
export function joinRemotePath(base: string, token: string): string {
  return normalizeRemotePath(`${base.replace(/\/+$/, '')}/${token}`)
}

/** The parent directory of an absolute path (`/a/b/c` → `/a/b`; `/a` → `/`). */
export function parentDirectoryOf(path: string): string {
  const normalized = normalizeRemotePath(path)
  if (normalized === '/') return '/'
  const cut = normalized.lastIndexOf('/')
  return cut <= 0 ? '/' : normalized.slice(0, cut)
}

/** Whether `path` is `root` itself or lives under it. */
export function isWithinRoot(path: string, root: string): boolean {
  const normalizedPath = normalizeRemotePath(path)
  const normalizedRoot = normalizeRemotePath(root)
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot.replace(/\/+$/, '')}/`)
}

/**
 * Every path-looking token of one terminal line, in order.
 *
 * Trailing sentence punctuation is trimmed rather than excluded beforehand, so
 * `see /opt/src/a.c.` links `a.c`; a location suffix is removed before that trim
 * so `a.c:12` links `a.c` (not `a.c:12`).
 */
export function findTerminalPathTokens(text: string): TerminalPathToken[] {
  const tokens: TerminalPathToken[] = []
  if (text === '') return tokens
  PATH_RUN.lastIndex = 0
  for (let match = PATH_RUN.exec(text); match !== null; match = PATH_RUN.exec(text)) {
    const matchStart = match.index
    // A match inside a URL (`https://example.com/a`) is a host fragment, not a
    // remote path: the run starts after the `//`, so look at what precedes it.
    if (matchStart > 0 && /:\/\/[^\s]*$/.test(text.slice(0, matchStart))) continue
    let raw = match[0]
    if (raw.includes('://')) continue
    // The `//host/...` half of a URL, or a UNC-ish double slash: not a path the
    // remote tree can reveal (`//` has implementation-defined meaning in POSIX).
    if (raw.startsWith('//')) continue
    if (raw.startsWith('-')) continue
    raw = stripLocationSuffix(raw)
    // Location stripping may leave noise (`a.c:12.` → `a.c:12` → `a.c`).
    while (raw.length > 1 && TRAILING_NOISE.has(raw[raw.length - 1] as string)) raw = raw.slice(0, -1)
    if (raw.length < 2) continue
    // A bare `/` or `~/` is a directory symbol, not a jump target.
    if (raw === '/' || raw === '~/' || raw === './' || raw === '../') continue
    // `1/2` and `a/b` are legitimate; `2024/11/23` is a date, so require either a
    // rooted form or a token with letters.
    if (!raw.startsWith('/') && !raw.startsWith('~') && !/[A-Za-z_]/.test(raw)) continue
    tokens.push({ start: matchStart, end: matchStart + raw.length - 1, path: raw })
  }
  return tokens
}

/**
 * Absolute candidates for one token, in the order they should be validated.
 *
 * The caller stats each in turn (bounded) and acts on the first hit, which is
 * why the order matters: the shell's reported cwd beats a workspace-root guess,
 * and the home directory is the last resort (most relative paths a shell prints
 * are relative to where the user is).
 */
export function resolutionCandidates(token: string, ctx: PathResolutionContext = {}): string[] {
  const out: string[] = []
  const push = (candidate: string | undefined): void => {
    if (candidate === undefined || candidate === '') return
    const normalized = normalizeRemotePath(candidate)
    if (!normalized.startsWith('/')) return
    if (!out.includes(normalized)) out.push(normalized)
  }
  if (token.startsWith('/')) {
    push(token)
    return out
  }
  if (token.startsWith('~/')) {
    if (ctx.home !== undefined && ctx.home !== '') push(joinRemotePath(ctx.home, token.slice(2)))
    return out
  }
  if (ctx.cwd !== undefined && ctx.cwd !== '') push(joinRemotePath(ctx.cwd, token))
  for (const root of ctx.roots ?? []) push(joinRemotePath(root, token))
  if (ctx.home !== undefined && ctx.home !== '') push(joinRemotePath(ctx.home, token))
  return out
}
