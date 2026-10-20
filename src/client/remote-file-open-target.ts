/**
 * Where a clicked file reference should open when the owning session lives in
 * a remote workspace (pure — no React, no fetch, so the gate can drive it).
 *
 * DSH renders every file reference as a `dsh-resource://file/…` address and
 * opens it through its own right-sidebar preview. That preview resolves the
 * address path against the SESSION WORKSPACE ROOT. A model that quotes a path
 * relative to its CURRENT directory (e.g. `_xfer/reports/x.md` while working
 * in `…/workbase/app-web`) therefore misses by one segment, and a
 * remote session's workspace root only exists as an EMPTY local alias dir —
 * the click dies with the host-side ENOENT the user sees.
 *
 * This module answers "which binding, which remote paths to try" for the
 * client interceptor:
 *  - relative paths are tried against the workspace root first and the
 *    session's current working directory second (the model's usual writing
 *    base), which is what makes the one-segment miss heal;
 *  - absolute spellings (local alias, POSIX remote, drive-qualified alias)
 *    are folded back onto the binding;
 *  - anything that does not name a known binding answers `undefined`, so the
 *    native preview keeps handling local sessions and unknown addresses.
 */

/** One remote binding as the client store exposes it. */
export interface RemoteOpenBinding {
  id: string
  alias: string
  /** Absolute POSIX workspace root on the remote host. */
  remotePath: string
}

/** Client-side binding table (store snapshot projection). */
export interface RemoteOpenBindings {
  bindings: readonly RemoteOpenBinding[]
  /** Binding id -> materialized local alias directory. */
  aliasPaths: Readonly<Record<string, string>>
}

/** One click resolved to a binding plus the remote paths to try, in order. */
export interface RemoteOpenTarget {
  binding: RemoteOpenBinding
  candidates: readonly string[]
}

/** Decoded `dsh-resource://file/…` address. */
export type ParsedFileAddress =
  | { scope: 'session'; sessionId: string; path: string }
  | { scope: 'absolute'; path: string }

const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

function stripQueryAndFragment(address: string): string {
  const end = address.search(/[?#]/)
  return end === -1 ? address : address.slice(0, end)
}

function decodeSegments(segments: readonly string[]): string[] | undefined {
  try {
    return segments.map(segment => decodeURIComponent(segment))
  } catch {
    return undefined
  }
}

/**
 * Decode one file address the way `dsh-util-workspace-path` writes it: the
 * scope names the first segment, `session` carries the id then a path, and
 * `absolute` carries one path. Anything else — another scheme, an unknown
 * scope, bad percent-encoding — answers `undefined` and the caller delegates.
 */
export function parseFileAddress(address: string): ParsedFileAddress | undefined {
  if (!address.startsWith(FILE_ADDRESS_PREFIX)) return undefined
  const segments = stripQueryAndFragment(address.slice(FILE_ADDRESS_PREFIX.length)).split('/')
  const scope = segments[0]
  if (scope === 'session') {
    const [id, ...rest] = segments.slice(1)
    if (id === undefined || id === '') return undefined
    const path = decodeSegments(rest)
    if (path === undefined || path.length === 0) return undefined
    return { scope, sessionId: id, path: path.join('/') }
  }
  if (scope === 'absolute') {
    const rest = segments.slice(1)
    // A UNC path keeps one empty first segment (`absolute//server/share`).
    const unc = rest[0] === '' && rest.length > 1
    const path = decodeSegments(unc ? rest.slice(1) : rest)
    if (path === undefined || path.length === 0 || path[0] === '') return undefined
    if (unc) return { scope, path: `//${path.join('/')}` }
    // A drive-qualified first segment (`C:`) is already absolute without a
    // leading slash; a POSIX path is rooted.
    const drive = /^[A-Za-z]:$/.test(path[0])
    return { scope, path: drive ? path.join('/') : `/${path.join('/')}` }
  }
  return undefined
}

/** Slash spelling used inside the resolver (the alias side is Windows). */
function slashes(value: string): string {
  return value.replace(/\\/g, '/')
}

/** Trim trailing separators, preserving a bare POSIX root. */
function trimTrailing(value: string): string {
  if (value === '/') return value
  return value.replace(/\/+$/, '')
}

/** Case-insensitive only for Windows-style spellings; POSIX stays exact. */
function foldCase(value: string): string {
  return /^[A-Za-z]:\//.test(value) || value.startsWith('//') ? value.toLowerCase() : value
}

function samePath(left: string, right: string): boolean {
  return foldCase(trimTrailing(slashes(left))) === foldCase(trimTrailing(slashes(right)))
}

/** True when `child` is at/inside `parent` (boundary-aware, case per spelling). */
function contains(parent: string, child: string): boolean {
  const root = trimTrailing(foldCase(slashes(parent)))
  const target = trimTrailing(foldCase(slashes(child)))
  return target === root || (root === '/' ? target.startsWith('/') : target.startsWith(`${root}/`))
}

/** The part of `child` below `parent`, slash-separated ('' when equal). */
function relativeTo(parent: string, child: string): string {
  const root = trimTrailing(foldCase(slashes(parent)))
  const target = trimTrailing(slashes(child))
  const folded = foldCase(target)
  if (folded === root) return ''
  return folded.startsWith(`${root}/`) ? target.slice(root.length + 1) : ''
}

function isWindowsAbsolute(path: string): boolean {
  return /^[A-Za-z]:\//.test(path) || path.startsWith('//')
}

function remoteJoin(base: string, rel: string): string {
  const root = trimTrailing(base)
  if (rel === '') return root
  return root === '/' ? `/${rel}` : `${root}/${rel}`
}

/** The local alias directory of one binding, normalized for comparison. */
function aliasDirOf(table: RemoteOpenBindings, binding: RemoteOpenBinding): string | undefined {
  const dir = table.aliasPaths[binding.id]
  return typeof dir === 'string' && dir !== '' ? trimTrailing(slashes(dir)) : undefined
}

/**
 * Binding whose local alias directory IS the given workspace path.
 *
 * This is the session→binding gate: the host's `workspaces` list says which
 * workspace a session belongs to, and that workspace path is the alias dir the
 * routing layer materialized for exactly one binding. Exact match, no guessing.
 */
export function bindingForWorkspacePath(
  table: RemoteOpenBindings,
  workspacePath: string | undefined,
): RemoteOpenBinding | undefined {
  if (workspacePath === undefined || workspacePath === '') return undefined
  const target = trimTrailing(slashes(workspacePath))
  for (const binding of table.bindings) {
    const dir = aliasDirOf(table, binding)
    if (dir !== undefined && samePath(dir, target)) return binding
  }
  return undefined
}

/** True for a remote POSIX absolute path (the only spelling bindings use). */
function isRemoteAbsolute(path: string | undefined): path is string {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//')
}

/**
 * The binding that owns one REMOTE path: the alias narrows the host, the remote
 * path decides between the bindings on it.
 *
 * One alias routinely carries SEVERAL bindings (the same host mounted at
 * `/home/user/repo-a/…` and `/home/user/repo-b/…`), so an alias-only match hands
 * back whichever was created first: the editor then opens the file the caller
 * named while the sidebar, the tree and the workspace selector stay on the
 * other workspace. The remote root the caller already holds (`summary.root`, a
 * session cwd) is therefore the deciding evidence — an exact root match wins,
 * then the deepest binding root that contains the file, and only then the
 * alias's first binding (the historical fallback, for a caller that knows
 * nothing but the alias).
 *
 * @param table - client bindings plus their alias directories.
 * @param options.alias - host alias, when known (a hard filter).
 * @param options.remoteRoot - absolute remote workspace root, when known.
 * @param options.filePath - absolute remote file path, when known.
 * @returns the owning binding, or `undefined` when the alias matches nothing.
 */
export function bindingForRemoteFile(
  table: RemoteOpenBindings,
  options: { alias?: string | undefined; remoteRoot?: string | undefined; filePath?: string | undefined },
): RemoteOpenBinding | undefined {
  const alias = options.alias?.trim()
  const pool = alias === undefined || alias === ''
    ? [...table.bindings]
    : table.bindings.filter(binding => binding.alias === alias)
  if (pool.length === 0) return undefined

  const root = options.remoteRoot === undefined ? '' : trimTrailing(slashes(options.remoteRoot))
  if (root !== '') {
    const exact = pool.find(binding => samePath(binding.remotePath, root))
    if (exact !== undefined) return exact
  }

  const probe = isRemoteAbsolute(options.filePath)
    ? options.filePath
    : isRemoteAbsolute(options.remoteRoot) ? options.remoteRoot : undefined
  if (probe !== undefined) {
    let best: { binding: RemoteOpenBinding; length: number } | undefined
    for (const binding of pool) {
      const candidate = trimTrailing(binding.remotePath)
      if (!contains(candidate, probe)) continue
      if (best === undefined || candidate.length > best.length) best = { binding, length: candidate.length }
    }
    if (best !== undefined) return best.binding
  }

  return pool[0]
}

/**
 * The binding one change-panel row belongs to.
 *
 * The panel holds the session's own remote root (`summary.root`) and the row's
 * absolute remote path, which is exactly what separates two bindings sharing an
 * alias. Keeping the three-field call in one named function is what the gate
 * drives — the dock is a one-liner around it.
 */
export function bindingForChangedFile(
  table: RemoteOpenBindings,
  summary: { alias: string; root: string },
  filePath: string,
): RemoteOpenBinding | undefined {
  return bindingForRemoteFile(table, { alias: summary.alias, remoteRoot: summary.root, filePath })
}

/** Why the workspace selector kept the binding it already had. */
export type WorkspaceFollowHold =
  /** No session is on screen (or the id is empty). */
  | 'no-session'
  /** This session was already followed: a later manual pick must stand. */
  | 'already-followed'
  /** The session's binding is not resolvable yet (table empty/stale). */
  | 'unresolved'

/** What the workspace selector should do about the session on screen. */
export type WorkspaceFollowDecision =
  | { action: 'keep'; reason: WorkspaceFollowHold }
  | { action: 'select'; bindingId: string; followedSession: string }

/**
 * Decide whether the sidebar should switch to the binding a session works in.
 *
 * Pure, so the wiring (`selectWorkspace`) stays a one-liner in the store while
 * the policy is drivable by the gate:
 *  - a session is followed ONCE — after that the user's manual pick stands
 *    until another session takes the seat (so the selector never yanks itself
 *    back while the user is browsing another workspace);
 *  - an unresolved binding keeps the CURRENT selection: a session whose
 *    workspace is not in the table yet must not blank the sidebar or move it
 *    somewhere arbitrary.
 *
 * @param options.sessionId - the session on screen, when known.
 * @param options.followedSession - the session already followed, if any.
 * @param options.bindingId - the binding resolved for that session, if any.
 */
export function decideWorkspaceFollow(options: {
  sessionId: string | undefined
  followedSession: string | undefined
  bindingId: string | undefined
}): WorkspaceFollowDecision {
  const sessionId = options.sessionId
  if (sessionId === undefined || sessionId === '') return { action: 'keep', reason: 'no-session' }
  if (options.followedSession === sessionId) return { action: 'keep', reason: 'already-followed' }
  const bindingId = options.bindingId
  if (bindingId === undefined || bindingId === '') return { action: 'keep', reason: 'unresolved' }
  return { action: 'select', bindingId, followedSession: sessionId }
}

/**
 * Resolve the session's binding from whatever the caller knows, then decide.
 *
 * The whole follow policy lives here — the store's `followSessionWorkspace` is
 * a three-line applier around it (`selectWorkspace` + remembering the session),
 * and the gate drives THIS function with stubs, so a policy change cannot pass
 * the gate by being mirrored there.
 *
 * @param options.table - client bindings plus their alias directories.
 * @param options.sessionId - the session on screen, when known.
 * @param options.workspacePath - the session's host workspace path (alias dir).
 * @param options.alias - host alias the session is routed to, when known.
 * @param options.remoteRoot - absolute remote root of the session's workspace.
 * @param options.followedSession - the session already followed, if any.
 */
export function planWorkspaceFollow(options: {
  table: RemoteOpenBindings
  sessionId: string | undefined
  workspacePath?: string | undefined
  alias?: string | undefined
  remoteRoot?: string | undefined
  followedSession: string | undefined
}): WorkspaceFollowDecision {
  // The host's own workspace path is the strongest evidence (it IS the alias
  // dir of exactly one binding). Without it, the remote root the caller holds
  // still separates two bindings sharing an alias. With NEITHER, nothing is
  // resolved — never "the first binding".
  const binding = bindingForWorkspacePath(options.table, options.workspacePath)
    ?? (options.alias === undefined && options.remoteRoot === undefined
      ? undefined
      : bindingForRemoteFile(options.table, { alias: options.alias, remoteRoot: options.remoteRoot }))
  return decideWorkspaceFollow({
    sessionId: options.sessionId,
    followedSession: options.followedSession,
    bindingId: binding?.id,
  })
}

/** Binding whose local alias directory CONTAINS the given host path. */
function bindingForHostPath(
  table: RemoteOpenBindings,
  hostPath: string,
): RemoteOpenBinding | undefined {
  const target = trimTrailing(slashes(hostPath))
  let best: { binding: RemoteOpenBinding; length: number } | undefined
  for (const binding of table.bindings) {
    const dir = aliasDirOf(table, binding)
    if (dir === undefined || !contains(dir, target)) continue
    if (best === undefined || dir.length > best.length) best = { binding, length: dir.length }
  }
  return best?.binding
}

/** POSIX single-quote a word for a remote `bash -c` style command line. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Bounded remote search for a clicked path that no candidate resolved.
 *
 * The model's final answer may quote a PROJECT-relative path (`_xfer/reports/
 * r.md`) while its shell `cd` happened INSIDE each command — the session cwd
 * never moved, so no cwd candidate exists. A unique file whose path ENDS with
 * the clicked relative spelling is then the only sane answer; the search is
 * only issued after every direct candidate missed, so the normal click stays
 * one stat call.
 *
 * @param remoteRoot - the binding's absolute remote workspace root.
 * @param relative - the clicked path, slash-separated and workspace-relative.
 * @returns the `find` command line, or `undefined` for an unusable path.
 */
export function suffixFindCommand(remoteRoot: string, relative: string): string | undefined {
  const clean = slashes(relative).replace(/^(?:\.\/)+/, '')
  if (clean === '' || clean.startsWith('/') || clean.split('/').some(part => part === '' || part === '.' || part === '..')) {
    return undefined
  }
  const base = clean.split('/').pop()
  if (base === undefined || base === '') return undefined
  const root = trimTrailing(remoteRoot)
  return `find ${shellQuote(root)} -maxdepth 6 -type f -name ${shellQuote(base)} -print 2>/dev/null | head -40`
}

/** Pick the unique search hit whose path ends with the clicked spelling. */
export function uniqueSuffixMatch(remoteRoot: string, relative: string, stdout: string): string | undefined {
  const clean = slashes(relative).replace(/^(?:\.\/)+/, '')
  const suffix = `/${trimTrailing(clean)}`
  const root = trimTrailing(remoteRoot)
  const hits: string[] = []
  for (const line of stdout.split('\n')) {
    const candidate = trimTrailing(slashes(line.trim()))
    if (candidate === '' || !contains(root, candidate)) continue
    if (!candidate.endsWith(suffix)) continue
    if (!hits.includes(candidate)) hits.push(candidate)
  }
  return hits.length === 1 ? hits[0] : undefined
}

/**
 * Resolve one clicked address to a remote binding and its candidate paths.
 *
 * @param address - the clicked `dsh-resource://file/…` address.
 * @param table - client bindings plus their alias directories.
 * @param sessionWorkspacePath - the clicked session's workspace path (the
 *   `workspaces` snapshot's item path); the binding is matched on it.
 * @param sessionCwd - the session's CURRENT working directory when known; it
 *   supplies the second, model-cwd-relative candidate.
 * @returns the binding and ordered remote candidates, or `undefined` when the
 *   click is not a remote-workspace file (the caller keeps the native path).
 */
export function resolveRemoteOpenTarget(options: {
  address: string
  table: RemoteOpenBindings
  sessionWorkspacePath?: string | undefined
  sessionCwd?: string | undefined
}): RemoteOpenTarget | undefined {
  const parsed = parseFileAddress(options.address)
  if (parsed === undefined) return undefined

  if (parsed.scope === 'absolute') {
    const binding = bindingForHostPath(options.table, parsed.path)
    if (binding === undefined) return undefined
    const dir = aliasDirOf(options.table, binding)
    if (dir === undefined) return undefined
    const rel = relativeTo(dir, parsed.path)
    if (rel === '' || !contains(dir, parsed.path)) return undefined
    return { binding, candidates: [remoteJoin(binding.remotePath, rel)] }
  }

  const binding = bindingForWorkspacePath(options.table, options.sessionWorkspacePath)
  if (binding === undefined) return undefined
  const aliasDir = aliasDirOf(options.table, binding)
  if (aliasDir === undefined) return undefined

  const candidates: string[] = []
  const push = (value: string | undefined): void => {
    if (value === undefined || value === '') return
    const normalized = trimTrailing(value)
    if (normalized !== '' && !candidates.includes(normalized)) candidates.push(normalized)
  }
  const path = slashes(parsed.path)

  if (path.startsWith('/')) {
    // POSIX absolute: either the remote spelling itself, or an alias spelling
    // that happens to be POSIX-rooted on another host (not meaningful here).
    if (contains(binding.remotePath, path)) push(path)
    return candidates.length === 0 ? undefined : { binding, candidates }
  }
  if (isWindowsAbsolute(path)) {
    if (!contains(aliasDir, path)) return undefined
    const rel = relativeTo(aliasDir, path)
    if (rel === '') return undefined
    return { binding, candidates: [remoteJoin(binding.remotePath, rel)] }
  }

  // Relative path: workspace-root-relative first, then the session's current
  // directory (the model usually quotes relative to where it actually worked).
  // The current directory may arrive in EITHER spelling — the host commits a
  // remote path when the session cd'ed, while a GUI-born session carries the
  // local alias — so both are folded onto the binding.
  const relative = path.replace(/^(?:\.\/)+/, '')
  if (relative === '') return undefined
  push(remoteJoin(binding.remotePath, relative))
  const cwd = options.sessionCwd
  if (cwd !== undefined) {
    const current = trimTrailing(slashes(cwd))
    const workspace = options.sessionWorkspacePath
    let relCwd: string | undefined
    if (workspace !== undefined && contains(workspace, current)) relCwd = relativeTo(workspace, current)
    else if (contains(binding.remotePath, current)) relCwd = relativeTo(binding.remotePath, current)
    else if (contains(aliasDir, current)) relCwd = relativeTo(aliasDir, current)
    if (relCwd !== undefined && relCwd !== '') push(remoteJoin(remoteJoin(binding.remotePath, relCwd), relative))
  }
  return candidates.length === 0 ? undefined : { binding, candidates }
}
