/**
 * Shared explorer state.
 *
 * This is a MODULE-LEVEL singleton rather than a React context on purpose:
 * the plugin has two mount points — the sidebar panel (explorer / search /
 * source control / history / terminal) and the conversation-view editor tab
 * next to 轨迹 — and both must see the same binding, git status and tab strip.
 * Components subscribe through `useExplorer()`, a `useSyncExternalStore` read
 * of an immutable snapshot rebuilt on every mutation, so either surface can
 * repaint the other.
 *
 * Remote work stays lazy: a directory is listed once per expansion, a diff
 * loads both revisions on demand, and git status is one NUL-separated call.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {
  DiffModel,
  GitStatusDetail,
  RemoteHostSummary,
  RemoteRoutingStatus,
  RemoteWorkspaceBinding,
} from '../protocol.ts'
import { api, RemoteApiError } from './api.ts'
import { normalizeRepoSubdir, repoSubdirOf, repoWorkdir } from '../git-ops.ts'
import { buildDiffModel } from './scm/diff-model.ts'
import { bucketStatus, buildTreeMarks, type StatusBuckets, type TreeMarks } from './scm/status-map.ts'
import { loadCommitFileDiff, findRepos, loadDiff, loadHead, loadStatusDetail, resolveRepoRoot, type DiffPayload } from './scm/actions.ts'
import { detectLang, makeT, type Lang } from './i18n.ts'
import { revealViewTab } from './reveal.ts'
import { isHtmlFile, isImageFile, isMarkdownFile, toast } from './vsc/kit.tsx'

/** One editor tab (code file, preview or diff). */
export interface EditorTab {
  id: string
  kind: 'file' | 'diff'
  /** Absolute remote path. */
  fullPath: string
  /** Path relative to the workspace root (what the UI shows). */
  rel: string
  loading: boolean
  error: string | undefined
  /** File payload. */
  text: string
  dirty: boolean
  saving: boolean
  binary: boolean
  truncated: boolean
  image: boolean
  markdown: boolean
  html: boolean
  /** Preview vs source for markdown/html. */
  preview: boolean
  /** Staged side for a diff. */
  staged: boolean
  /** Untracked files diff against an empty left side. */
  untracked: boolean
  /** Set for a commit drill-down: the diff compares `ref^` with `ref`. */
  ref?: string
  /** 1-based line to reveal after load (a content-search hit). */
  line?: number
  /**
   * Bumped on every reveal request. The line number alone cannot re-trigger a
   * jump to the line the caret is already on.
   */
  lineNonce?: number
  diff: DiffPayload | undefined
  model: DiffModel | undefined
  view: 'split' | 'before' | 'after'
}

export interface HeadInfo {
  branch: string
  detached: boolean
  ahead: number
  behind: number
}

interface State {
  ctx: Context | undefined
  ready: boolean
  error: string | undefined
  hosts: RemoteHostSummary[]
  workspaces: RemoteWorkspaceBinding[]
  routing: RemoteRoutingStatus
  workspaceId: string
  status: GitStatusDetail | undefined
  head: HeadInfo | undefined
  repoRoot: string | undefined
  /** Workspace-relative directory git runs in ('' = the workspace root). */
  repoSubdir: string
  repoMissing: boolean
  gitBusy: boolean
  gitError: string | undefined
  tabs: EditorTab[]
  activeTabId: string | undefined
  revision: number
  /** Where the editor pane is mounted ('center' = conversation view). */
  editorSurface: 'center' | 'sidebar'
  /** The active sidebar panel (shared so any surface can switch it). */
  view: RailView
  /** A pending search request raised by the explorer's context menu. */
  searchRequest: SearchRequest | undefined
}

/** The sidebar rail destinations. */
export type RailView = 'explorer' | 'search' | 'scm' | 'history' | 'editor' | 'terminal' | 'workspaces'

/** One "search this folder" request coming from the tree. */
export interface SearchRequest {
  /** Monotonic id so a repeated request still re-triggers the view. */
  id: number
  mode: 'name' | 'content'
  /** Pre-filled query (usually empty). */
  query: string
  /** Absolute remote directory the search is scoped to. */
  scope: string
}

const WS_KEY = 'dsh-remote-vs.files.ws'
const VIEW_KEY = 'dsh-remote-vs.view'
/** Per-workspace repository sub-directory, keyed by workspace id. */
const REPO_SUBDIR_KEY = 'dsh-remote-vs.repo.subdir'

function readWorkspaceId(): string {
  try {
    return localStorage.getItem(WS_KEY) ?? ''
  } catch {
    return ''
  }
}

/** Stored repository sub-directory for one binding ('' = the workspace root). */
export function readRepoSubdir(workspaceId: string): string {
  try {
    const raw = localStorage.getItem(REPO_SUBDIR_KEY)
    if (raw === null) return ''
    const saved: unknown = JSON.parse(raw)
    if (typeof saved !== 'object' || saved === null) return ''
    const value = (saved as Record<string, unknown>)[workspaceId]
    return typeof value === 'string' ? normalizeRepoSubdir(value) : ''
  } catch {
    return ''
  }
}

function writeRepoSubdir(workspaceId: string, subdir: string): void {
  try {
    const raw = localStorage.getItem(REPO_SUBDIR_KEY)
    const saved: unknown = raw === null ? {} : JSON.parse(raw)
    const map: Record<string, string> = (typeof saved === 'object' && saved !== null)
      ? { ...(saved as Record<string, string>) }
      : {}
    if (subdir === '') delete map[workspaceId]
    else map[workspaceId] = subdir
    localStorage.setItem(REPO_SUBDIR_KEY, JSON.stringify(map))
  } catch {
    // Private mode: the choice simply does not survive a reload.
  }
}

function readStoredView(): RailView {
  try {
    const saved = localStorage.getItem(VIEW_KEY)
    if (saved === 'explorer' || saved === 'search' || saved === 'scm' || saved === 'history'
      || saved === 'editor' || saved === 'terminal' || saved === 'workspaces') {
      return saved
    }
  } catch {
    // Private mode: ignore.
  }
  return 'explorer'
}

const t = makeT(detectLang())
const lang: Lang = detectLang()

const EMPTY_STATUS: GitStatusDetail = { entries: [], ignored: [], truncated: false }

const state: State = {
  ctx: undefined,
  ready: false,
  error: undefined,
  hosts: [],
  workspaces: [],
  routing: { mode: 'off', aliasPaths: {}, tombstones: [] },
  workspaceId: readWorkspaceId(),
  status: undefined,
  head: undefined,
  repoRoot: undefined,
  repoSubdir: '',
  repoMissing: false,
  gitBusy: false,
  gitError: undefined,
  tabs: [],
  activeTabId: undefined,
  revision: 0,
  editorSurface: 'sidebar',
  view: readStoredView(),
  searchRequest: undefined,
}

/** Everything a view can read, plus the actions. */
export interface ExplorerValue {
  ctx: Context | undefined
  t: (key: string) => string
  lang: Lang
  ready: boolean
  error: string | undefined
  hosts: RemoteHostSummary[]
  workspaces: RemoteWorkspaceBinding[]
  routing: RemoteRoutingStatus
  workspaceId: string
  workspace: RemoteWorkspaceBinding | undefined
  /** Binding id → materialized local alias dir (the session↔binding gate). */
  aliasPaths: Record<string, string>
  alias: string
  /** Remote workspace root (absolute). */
  root: string
  /** Enclosing git repository root, when the binding is inside one. */
  repoRoot: string | undefined
  /** Workspace-relative directory git runs in ('' = the workspace root). */
  repoSubdir: string
  /** Absolute directory git runs in (workspace root + repoSubdir). */
  repoWorkdir: string
  repoMissing: boolean
  status: GitStatusDetail | undefined
  buckets: StatusBuckets
  marks: TreeMarks
  head: HeadInfo | undefined
  gitBusy: boolean
  gitError: string | undefined
  tabs: EditorTab[]
  activeTab: EditorTab | undefined
  activeTabId: string | undefined
  revision: number
  editorSurface: 'center' | 'sidebar'
  view: RailView
  searchRequest: SearchRequest | undefined
  setView: (view: RailView) => void
  /** Switch to the search panel (optionally scoped to a folder) — the tree's
      "find in folder" entry point. */
  requestSearch: (request: { mode: 'name' | 'content'; query?: string; scope: string }) => void
  selectWorkspace: (id: string) => void
  /** Point git at a directory inside the workspace (repositories often live in
      a subdirectory of the binding rather than at its root). */
  setRepoSubdir: (subdir: string) => Promise<void>
  /** Repositories found under the workspace root, as workspace-relative dirs. */
  discoverRepos: () => Promise<string[]>
  refreshAll: () => void
  refreshGit: () => Promise<void>
  afterWrite: () => Promise<void>
  openFile: (fullPath: string, options?: { line?: number }) => void
  openDiff: (rel: string, staged: boolean, untracked?: boolean) => void
  openCommitFile: (hash: string, rel: string) => void
  activateTab: (id: string) => void
  closeTab: (id: string) => void
  updateTab: (id: string, patch: Partial<EditorTab>) => void
  saveTab: (id: string, content: string) => Promise<void>
  reloadTab: (id: string) => Promise<void>
  info: (text: string) => void
  fail: (text: string) => void
}

/** Stable action identities — `build()` runs on every publish. */
const info = (text: string): void => toast(text, false)
const fail = (text: string): void => toast(text, true)

const listeners = new Set<() => void>()
let snapshot: ExplorerValue = build()

/**
 * The derived git views for one status value, memoised on that value's identity.
 *
 * `build()` runs on EVERY publish — including the ones that only flip a UI bit
 * (`gitBusy`, the active tab, a preview toggle, a panel switch). Bucketing and
 * marking the whole change list twice per publish was pure waste, and handing
 * out fresh objects each time also defeated every `useMemo` downstream that
 * keys on `buckets`/`marks`, because their identities never survived a render.
 *
 * The status object is replaced only when git actually answers, so caching on
 * its identity is exactly the right key: same status in, same two objects out.
 */
let derivedStatus: GitStatusDetail | undefined
let derivedViews: { buckets: StatusBuckets; marks: TreeMarks } | undefined

function deriveViews(status: GitStatusDetail): { buckets: StatusBuckets; marks: TreeMarks } {
  if (derivedViews === undefined || derivedStatus !== status) {
    const buckets = bucketStatus(status)
    derivedStatus = status
    derivedViews = { buckets, marks: buildTreeMarks(status, buckets) }
  }
  return derivedViews
}

function build(): ExplorerValue {
  const workspace = state.workspaces.find(item => item.id === state.workspaceId) ?? state.workspaces[0]
  const status = state.status ?? EMPTY_STATUS
  const views = deriveViews(status)
  return {
    ctx: state.ctx,
    t,
    lang,
    ready: state.ready,
    error: state.error,
    hosts: state.hosts,
    workspaces: state.workspaces,
    routing: state.routing,
    workspaceId: state.workspaceId,
    workspace,
    aliasPaths: state.routing.aliasPaths,
    alias: workspace?.alias ?? '',
    root: workspace?.remotePath ?? '',
    repoRoot: state.repoRoot,
    repoSubdir: state.repoSubdir,
    repoWorkdir: repoWorkdir(workspace?.remotePath ?? '', state.repoSubdir),
    repoMissing: state.repoMissing,
    status: state.status,
    buckets: views.buckets,
    marks: views.marks,
    head: state.head,
    gitBusy: state.gitBusy,
    gitError: state.gitError,
    tabs: state.tabs,
    activeTab: state.tabs.find(item => item.id === state.activeTabId),
    activeTabId: state.activeTabId,
    revision: state.revision,
    editorSurface: state.editorSurface,
    view: state.view,
    searchRequest: state.searchRequest,
    setView,
    requestSearch,
    selectWorkspace,
    setRepoSubdir,
    discoverRepos,
    refreshAll,
    refreshGit,
    afterWrite,
    openFile,
    openDiff,
    openCommitFile,
    activateTab,
    closeTab,
    updateTab,
    saveTab,
    reloadTab,
    info,
    fail,
  }
}

function publish(): void {
  snapshot = build()
  for (const listener of listeners) listener()
}

function patch(next: Partial<State>): void {
  Object.assign(state, next)
  publish()
}

/** Subscribe to the explorer store. */
export function useExplorer(): ExplorerValue {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => snapshot,
  )
}

/** The repo-relative path of an absolute remote path ('' when outside). */
export function repoRelative(repoRoot: string | undefined, fullPath: string): string {
  if (repoRoot === undefined) return ''
  const base = repoRoot.replace(/\/+$/, '')
  if (fullPath === base) return ''
  if (fullPath.startsWith(`${base}/`)) return fullPath.slice(base.length + 1)
  return ''
}

function currentWorkspace(): RemoteWorkspaceBinding | undefined {
  return state.workspaces.find(item => item.id === state.workspaceId) ?? state.workspaces[0]
}

/**
 * The active binding PLUS the id its per-workspace localStorage is keyed by.
 *
 * The id is the resolved binding's own id, not `state.workspaceId`: on a
 * fresh browser profile `state.workspaceId` is '' while `currentWorkspace()`
 * has already auto-selected `workspaces[0]` (and the UI shows it). Reading
 * per-binding state under '' while writing it under the resolved id loses the
 * value on every reload — and reading a stale id hands a deleted binding's
 * setting to a different workspace.
 */
function activeBinding(): { workspace: RemoteWorkspaceBinding | undefined; key: string } {
  const workspace = currentWorkspace()
  return { workspace, key: workspace?.id ?? state.workspaceId }
}

/**
 * Monotonic ticket for git refreshes. Two refreshes can overlap whenever the
 * binding changes or a write lands mid-read, and both panels stay mounted, so
 * an older response arriving last would otherwise write ITS repository into
 * the state the newer binding is using — after which every staged/discard
 * button would act on the wrong repo (scm/actions.ts takes alias + repoRoot).
 */
let gitGeneration = 0

// -------------------------------------------------------------- lifecycle

let booted = false

/** Install the context and load hosts/workspaces once per page. */
export function bootstrap(ctx: Context): void {
  if (booted) {
    if (state.ctx !== ctx) patch({ ctx })
    return
  }
  booted = true
  patch({ ctx })
  refreshAll()
}

/** Reload hosts + workspace bindings and the routing status. */
export function refreshAll(): void {
  if (state.ctx === undefined) return
  Promise.all([api.getHosts(), api.getWorkspaces()]).then(
    ([hosts, payload]) => {
      // The stored sub-directory is keyed by the RESOLVED binding (see
      // activeBinding): it was written under that id, so reading it under the
      // raw `state.workspaceId` ('' on a fresh profile) lost it every reload.
      const key = activeBinding().key
      patch({
        hosts,
        workspaces: payload.workspaces,
        routing: { mode: payload.mode, aliasPaths: payload.aliasPaths, tombstones: payload.tombstones },
        workspaceId: key,
        repoSubdir: readRepoSubdir(key),
        ready: true,
        error: undefined,
      })
      void refreshGit()
    },
    (error: unknown) => {
      patch({ ready: true, error: error instanceof RemoteApiError ? error.message : String(error) })
    },
  )
}

/** Switch the sidebar panel (persisted across reloads). */
export function setView(view: RailView): void {
  if (state.view === view) return
  patch({ view })
  try {
    localStorage.setItem(VIEW_KEY, view)
  } catch {
    // Private mode: ignore.
  }
}

/** One-shot request from the explorer: "search this folder". */
export function requestSearch(request: { mode: 'name' | 'content'; query?: string; scope: string }): void {
  searchSeq += 1
  patch({
    searchRequest: {
      id: searchSeq,
      mode: request.mode,
      query: request.query ?? '',
      scope: request.scope,
    },
  })
  setView('search')
}

/** Select the binding every view works against. */
export function selectWorkspace(id: string): void {
  if (state.workspaceId === id) return
  patch({
    workspaceId: id,
    tabs: [],
    activeTabId: undefined,
    status: undefined,
    head: undefined,
    repoRoot: undefined,
    repoSubdir: readRepoSubdir(id),
  })
  try {
    localStorage.setItem(WS_KEY, id)
  } catch {
    // Private mode: ignore.
  }
  void refreshGit()
}

let searchSeq = 0

/**
 * Point git at a directory inside the workspace. Repositories often live in a
 * sub-directory of the binding (`/srv/app` holding `/srv/app/web/.git`), and
 * git only answers for the directory it is run in, so the choice is persisted
 * per binding and re-resolved on every refresh.
 */
export async function setRepoSubdir(subdir: string): Promise<void> {
  const { workspace, key } = activeBinding()
  const clean = normalizeRepoSubdir(subdir)
  if (workspace !== undefined) writeRepoSubdir(key, clean)
  patch({ repoSubdir: clean, repoRoot: undefined, gitError: undefined })
  await refreshGit()
}

/** Repositories found under the workspace root (workspace-relative, root first). */
export async function discoverRepos(): Promise<string[]> {
  const workspace = currentWorkspace()
  if (workspace === undefined) return []
  const found = await findRepos(workspace.alias, workspace.remotePath)
  return found
    .map(dir => repoSubdirOf(workspace.remotePath, dir))
    .filter((dir): dir is string => dir !== undefined)
}

/** Re-read git status for the current binding. */
export async function refreshGit(): Promise<void> {
  const { workspace, key } = activeBinding()
  if (workspace === undefined) return
  const gen = ++gitGeneration
  // Discard a response that is no longer about the binding on screen (the
  // user switched) or is superseded by a newer refresh. Without this the
  // slower request wins the last write and the panel shows one workspace's
  // repository while the selector and every action use another's.
  const stale = (): boolean => gen !== gitGeneration || activeBinding().key !== key
  patch({ gitBusy: true })
  try {
    const workdir = repoWorkdir(workspace.remotePath, state.repoSubdir)
    const root = await resolveRepoRoot(workspace.alias, workdir)
    if (stale()) return
    if (root === undefined) {
      patch({ repoRoot: undefined, repoMissing: true, status: EMPTY_STATUS, head: undefined, gitBusy: false, gitError: undefined })
      return
    }
    const [detail, head] = await Promise.all([
      withDeadline(loadStatusDetail(workspace.alias, root), READ_DEADLINE_MS, t('editor.readTimeout')),
      withDeadline(loadHead(workspace.alias, root), READ_DEADLINE_MS, t('editor.readTimeout')),
    ])
    if (stale()) return
    // A directory INSIDE a repository settles on that repository's root, so the
    // stored choice is what git actually uses (and what the picker shows).
    const settled = repoSubdirOf(workspace.remotePath, root) ?? state.repoSubdir
    if (settled !== state.repoSubdir) writeRepoSubdir(key, settled)
    patch({ repoRoot: root, repoSubdir: settled, repoMissing: false, status: detail, head, gitBusy: false, gitError: undefined })
  } catch (error) {
    if (stale()) return
    // Clear the repo identity too. Leaving a previous binding's `repoRoot` in
    // place kept its branch, change list and sync buttons painted while the
    // selector said something else — and ScmPanel keys "Loading…" off
    // repoRoot === undefined, so NOT clearing it showed a stale repo while
    // clearing it without an error message showed a spinner forever. The
    // message is now rendered by the panel (see ScmPanel's empty state).
    patch({
      repoRoot: undefined,
      head: undefined,
      status: EMPTY_STATUS,
      gitBusy: false,
      gitError: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Refresh everything a working-tree change can invalidate. */
export async function afterWrite(): Promise<void> {
  await refreshGit()
  patch({ revision: state.revision + 1 })
}

// -------------------------------------------------------------- tab model

function computeRel(fullPath: string): string {
  const workspace = currentWorkspace()
  const root = workspace?.remotePath ?? ''
  if (root !== '' && fullPath.startsWith(`${root}/`)) return fullPath.slice(root.length + 1)
  return repoRelative(state.repoRoot, fullPath) || fullPath
}

function upsertTab(tab: EditorTab): void {
  const already = state.tabs.some(item => item.id === tab.id)
  if (already) {
    patch({ activeTabId: tab.id })
    revealEditor()
    return
  }
  patch({ tabs: [...state.tabs, tab], activeTabId: tab.id })
  revealEditor()
}

/**
 * Pending reveal retry. Module level on purpose: `revealEditor` is called from
 * store actions, so no component lifecycle could ever cancel it.
 */
let revealRetry: ReturnType<typeof setTimeout> | undefined

/**
 * Bring the editor into view. On the 'center' surface the shell renders only
 * the selected conversation view, so a file opened from the sidebar must also
 * select that tab — otherwise the click looks like a no-op. When the tab
 * cannot be found (another host build, or the shell's markup changed) the user
 * is told where the file opened instead of being left guessing.
 */
function revealEditor(): void {
  if (state.editorSurface !== 'center') return
  const label = t('view.editor')
  // A newer open supersedes the pending retry: arming a second one left the
  // timers piling up one per opened file (each doing its own full-document tab
  // scan 80ms later), and an older retry could pop its "opened in …" toast on
  // top of the newer open.
  if (revealRetry !== undefined) {
    clearTimeout(revealRetry)
    revealRetry = undefined
  }
  // The tab only exists once the shell has painted it; one deferred retry
  // covers the frame in which a freshly registered view is being added.
  if (revealViewTab(label)) return
  revealRetry = setTimeout(() => {
    revealRetry = undefined
    if (!revealViewTab(label)) toast(`${t('editor.openedIn')}「${label}」`, false)
  }, 80)
}

function patchTab(id: string, next: Partial<EditorTab>): void {
  patch({ tabs: state.tabs.map(tab => (tab.id === id ? { ...tab, ...next } : tab)) })
}

/** Deadline for one remote read: a wedged host must never look like a spinner. */
const READ_DEADLINE_MS = 45_000

/**
 * Reject a remote call that never answers. The host route has its own caps,
 * but a stuck TCP/SSH round trip would otherwise leave a tab loading forever
 * with no way to tell what happened.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} (${Math.round(ms / 1000)}s)`)), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** Open (or focus) a remote file in the editor tab strip. */
export function openFile(fullPath: string, options: { line?: number } = {}): void {
  const workspace = currentWorkspace()
  if (workspace === undefined || fullPath === '') return
  const id = `file:${workspace.alias}:${fullPath}`
  // Re-opening a tab that is already up only re-addresses the reveal line, so
  // a second search hit in the same file moves the cursor instead of reloading.
  // The nonce also re-triggers a jump to the SAME line (value alone would not).
  if (state.tabs.some(tab => tab.id === id)) {
    patch({
      activeTabId: id,
      tabs: state.tabs.map(tab => (tab.id === id
        ? (options.line === undefined
            ? tab
            : { ...tab, line: options.line, lineNonce: (tab.lineNonce ?? 0) + 1 })
        : tab)),
    })
    revealEditor()
    return
  }
  upsertTab({
    id,
    kind: 'file',
    fullPath,
    rel: computeRel(fullPath),
    loading: true,
    error: undefined,
    text: '',
    dirty: false,
    saving: false,
    binary: false,
    truncated: false,
    image: isImageFile(fullPath),
    markdown: isMarkdownFile(fullPath),
    html: isHtmlFile(fullPath),
    preview: isMarkdownFile(fullPath) || isHtmlFile(fullPath),
    staged: false,
    untracked: false,
    ...(options.line === undefined ? {} : { line: options.line, lineNonce: 1 }),
    diff: undefined,
    model: undefined,
    view: 'split',
  })
  void (async () => {
    try {
      const read = await withDeadline(api.fileOp.read(workspace.alias, fullPath), READ_DEADLINE_MS, t('editor.readTimeout'))
      patchTab(id, {
        loading: false,
        binary: read.binary,
        truncated: read.truncated,
        text: read.binary ? '' : (read.text ?? ''),
      })
    } catch (error) {
      patchTab(id, { loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  })()
}

/** Open (or focus) a working-tree diff of one repository path. */
export function openDiff(rel: string, staged: boolean, untracked = false): void {
  const workspace = currentWorkspace()
  if (workspace === undefined || state.repoRoot === undefined || rel === '') {
    toast(t('git.notARepo'), true)
    return
  }
  const root = state.repoRoot
  const id = `diff:${workspace.alias}:${root}:${rel}:${staged ? 'staged' : 'worktree'}`
  upsertTab({
    id,
    kind: 'diff',
    fullPath: `${root.replace(/\/+$/, '')}/${rel}`,
    rel,
    loading: true,
    error: undefined,
    text: '',
    dirty: false,
    saving: false,
    binary: false,
    truncated: false,
    image: isImageFile(rel),
    markdown: false,
    html: false,
    preview: false,
    staged,
    untracked,
    diff: undefined,
    model: undefined,
    view: 'split',
  })
  void (async () => {
    try {
      const payload = await withDeadline(loadDiff(workspace.alias, root, rel, staged, untracked), READ_DEADLINE_MS, t('editor.readTimeout'))
      patchTab(id, {
        loading: false,
        diff: payload,
        model: payload.unsupported ? undefined : buildDiffModel(payload),
        binary: payload.unsupported,
      })
    } catch (error) {
      patchTab(id, { loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  })()
}

/** Open (or focus) one file of one commit (`ref^` against `ref`). */
export function openCommitFile(hash: string, rel: string): void {
  const workspace = currentWorkspace()
  const root = state.repoRoot
  if (workspace === undefined || root === undefined || rel === '') return
  const id = `commit:${workspace.alias}:${hash}:${rel}`
  upsertTab({
    id,
    kind: 'diff',
    fullPath: `${root.replace(/\/+$/, '')}/${rel}`,
    rel,
    loading: true,
    error: undefined,
    text: '',
    dirty: false,
    saving: false,
    binary: false,
    truncated: false,
    image: false,
    markdown: false,
    html: false,
    preview: false,
    staged: true,
    untracked: false,
    ref: hash,
    diff: undefined,
    model: undefined,
    view: 'split',
  })
  void (async () => {
    try {
      const payload = await withDeadline(loadCommitFileDiff(workspace.alias, root, hash, rel), READ_DEADLINE_MS, t('editor.readTimeout'))
      patchTab(id, {
        loading: false,
        diff: payload,
        model: payload.unsupported ? undefined : buildDiffModel(payload),
        binary: payload.unsupported,
      })
    } catch (error) {
      patchTab(id, { loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  })()
}

export function activateTab(id: string): void {
  patch({ activeTabId: id })
}

export function closeTab(id: string): void {
  const index = state.tabs.findIndex(tab => tab.id === id)
  const next = state.tabs.filter(tab => tab.id !== id)
  const activeTabId = state.activeTabId === id
    ? (next[Math.min(index, next.length - 1)]?.id ?? next[next.length - 1]?.id)
    : state.activeTabId
  patch({ tabs: next, activeTabId })
}

export function updateTab(id: string, next: Partial<EditorTab>): void {
  patchTab(id, next)
}

/** Write one tab back to the remote host. */
export async function saveTab(id: string, content: string): Promise<void> {
  const workspace = currentWorkspace()
  const tab = state.tabs.find(item => item.id === id)
  if (workspace === undefined || tab === undefined || tab.kind !== 'file' || tab.binary || tab.truncated) return
  // Never fall back to the tab's loaded text. `tab.text` is only ever written
  // by a load/reload, never by typing, so substituting it here would push the
  // PRE-EDIT bytes to the remote file and report success — destroying the
  // user's edit with a confirmation. A caller without a live buffer must
  // refuse to save instead (see EditorPane.saveActive).
  if (typeof content !== 'string') {
    toast(t('editor.needSource'), true)
    return
  }
  const text = content
  patchTab(id, { saving: true, text })
  try {
    await api.fileOp.write(workspace.alias, tab.fullPath, text)
    patchTab(id, { saving: false, dirty: false })
    toast(`${t('editor.saved')} · ${tab.rel}`, false)
    await afterWrite()
  } catch (error) {
    patchTab(id, { saving: false })
    toast(error instanceof Error ? error.message : String(error), true)
  }
}

/** Re-read one tab (file content or diff payload). */
export async function reloadTab(id: string): Promise<void> {
  const workspace = currentWorkspace()
  const tab = state.tabs.find(item => item.id === id)
  if (workspace === undefined || tab === undefined) return
  if (tab.kind === 'file') {
    try {
      const read = await withDeadline(api.fileOp.read(workspace.alias, tab.fullPath), READ_DEADLINE_MS, t('editor.readTimeout'))
      patchTab(id, {
        loading: false,
        error: undefined,
        text: read.binary ? '' : (read.text ?? ''),
        binary: read.binary,
        truncated: read.truncated,
        dirty: false,
      })
    } catch (error) {
      patchTab(id, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  const root = state.repoRoot
  if (root === undefined) return
  try {
    const payload = tab.ref !== undefined
      ? await withDeadline(loadCommitFileDiff(workspace.alias, root, tab.ref, tab.rel), READ_DEADLINE_MS, t('editor.readTimeout'))
      : await withDeadline(loadDiff(workspace.alias, root, tab.rel, tab.staged, tab.untracked), READ_DEADLINE_MS, t('editor.readTimeout'))
    patchTab(id, {
      loading: false,
      error: undefined,
      diff: payload,
      binary: payload.unsupported,
      model: payload.unsupported ? undefined : buildDiffModel(payload),
      dirty: false,
    })
  } catch (error) {
    patchTab(id, { error: error instanceof Error ? error.message : String(error) })
  }
}

/** Note where the editor pane is mounted (set by the client entry). */
export function setEditorSurface(surface: 'center' | 'sidebar'): void {
  patch({ editorSurface: surface })
}

/** Mount-time hook: boot the store for a given ctx. */
export function useBootstrap(ctx: Context): void {
  useEffect(() => {
    bootstrap(ctx)
  }, [ctx])
}
