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
import { api, RemoteApiError, configureTimeouts, fileReadTimeoutMs, gitTimeoutMs } from './api.ts'
import { DEFAULT_GIT_TIMEOUT_MS, clientDeadlineFor } from '../timeouts.ts'
import { normalizeRepoSubdir, repoSubdirOf, repoWorkdir } from '../git-ops.ts'
import { buildDiffModel } from './scm/diff-model.ts'
import type { ChangeMark, ChangeSet } from './vsc/change-marks.ts'
import { changeSetFromHunks } from './changes/model.ts'
import { undoContext, type UndoContext } from './changes/undo-context.ts'
import { applyStageOverrides, bucketStatus, buildTreeMarks, insertStagedEntry, optimisticStageDetail, type ChangeEntry, type StageOverride, type StatusBuckets, type TreeMarks } from './scm/status-map.ts'
import { loadCommitFileDiff, findRepos, loadDiff, loadHead, loadStatusDetail, probeStatusDir, probeStatusPaths, resolveRepoRoot, applyHunk, stagePaths, unstagePaths, type DiffPayload } from './scm/actions.ts'
import { StageCoordinator } from './scm/stage-queue.ts'
import { collapseDir, dropExpandedRows, expandDir, pruneDirExpansions, type DirExpansions } from './scm/untracked-dirs.ts'
import { detectLang, makeT, type Lang } from './i18n.ts'
import { effectiveEditorSurface, type EditorSurface } from './float-editor.ts'
import { captureLiveEditorPosition, captureLiveEditorText, isLiveEditorDirty, isLiveEditorFor, markLiveEditorSaved } from './live-editor.ts'
import { planWorkspaceFollow, selectionIsSessionBinding, type WorkspaceFollowDecision } from './remote-file-open-target.ts'
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
  /**
   * The text as last LOADED from / SAVED to the remote file.
   *
   * `text` is the live-buffer handoff copy (see `captureLiveBuffer`) and may
   * therefore hold unsaved edits; this is the disk-side reference the editor
   * uses as its dirty baseline. Without the split, a remount with the handoff
   * text would label unsaved edits "clean" (dirty dot off, Save disabled, close
   * guard silent) — the exact silent-loss path the handoff exists to avoid.
   */
  baseline?: string
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
  /**
   * 「本会话改了什么」的行标记（来自会话改动数据层，见 `vsc/change-marks.ts`）。
   * `undefined` = 这个 tab 根本没有改动数据（编辑器连 gutter 都不会多装一栏）。
   */
  changeSet?: ChangeSet | null
  /** 最近一次跳到的改动点在 `changeSet.hunks` 里的下标（0-based）；`<0` = 还没跳过。 */
  activeHunk?: number
  /** 编辑器报告文档已与 `changeSet` 脱钩（用户敲过字），上层该重新拉数据。 */
  changeStale?: boolean
  /** 改动点跳转目标行（1-based）。与 `line` 分开，两条跳转链路互不干扰。 */
  revealHunkLine?: number
  /** 改动点跳转的 nonce，语义同 `lineNonce`。 */
  revealHunkNonce?: number
  /**
   * 重读（`reloadTab`）成功后递增的 nonce。
   *
   * 它存在的唯一理由：`CodeEditor` 的 `initial` **只在挂载时读一次**，所以
   * "远端内容变了" 必须靠**重挂**才能进到编辑器缓冲区（详见 `reloadTab` 的注释）。
   * `EditorPane` 把它拼进 `key`，这里的每次递增就是一次重挂。
   */
  reloadNonce?: number
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
  /** Effective per-git-command budget (ms), from the Host's config. */
  gitDeadlineMs: number
  tabs: EditorTab[]
  activeTabId: string | undefined
  revision: number
  /** Where the editor pane is mounted ('center' = conversation view). */
  editorSurface: 'center' | 'sidebar'
  /** True while the editor is popped out into the floating window. */
  floatOpen: boolean
  /**
   * True once the host's frame-wide overlay slot actually rendered the
   * floating window host. Until then the menu entry stays disabled: a surface
   * that can never paint is worse than a missing entry.
   */
  floatAvailable: boolean
  /** The active sidebar panel (shared so any surface can switch it). */
  view: RailView
  /** A pending search request raised by the explorer's context menu. */
  searchRequest: SearchRequest | undefined
  /** A pending "show this folder in the tree" request (search-result menu). */
  revealRequest: RevealRequest | undefined
  /** A pending "open a terminal in this folder" request (search-result menu). */
  terminalRequest: TerminalRequest | undefined
  /**
   * Expanded untracked DIRECTORY rows (`-u normal` collapses a directory into
   * one row, so the panel asks for its contents on demand — see
   * `scm/untracked-dirs.ts`). Kept in the store, not in the panel: it has to
   * outlive every status the panel adopts, and only the store sees those.
   */
  untrackedDirs: DirExpansions
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

/** One "show this folder in the explorer tree" request. */
export interface RevealRequest {
  /** Monotonic id so asking for the same folder twice still re-triggers. */
  id: number
  /** Absolute remote DIRECTORY to expand and scroll to. */
  path: string
}

/** One "open a terminal here" request. */
export interface TerminalRequest {
  /** Monotonic id so the same folder can be opened twice. */
  id: number
  /**
   * Host alias the directory lives on.
   *
   * Carried explicitly, and NOT taken from the terminal panel's own last-used
   * host: the panel remembers whatever host the user ran a shell on last, so a
   * menu action on a workspace bound elsewhere opened the shell on the WRONG
   * machine — the `cd` then failed with "No such file or directory" for a path
   * that exists perfectly well on its own host.
   */
  alias: string
  /** Absolute remote directory the fresh shell should `cd` into. */
  dir: string
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

// ------------------------------------------------- optimistic stage/unstage

/**
 * Local stage/unstage results, for ONE repository, that a full status read may
 * not have seen yet.
 *
 * Skipping the repository-wide refresh after a stage is what makes the click
 * instant, but another verb (a save, a discard, a commit) can still have a full
 * `git status` in flight — and on a large repository that read started minutes
 * ago. Landing it as-is would flip the row the user just staged back into
 * "changes", so `refreshGit` re-applies whatever started after the read did
 * (see `applyStageOverrides`) and prunes the rest.
 */
let stageOverrides = new Map<string, StageOverride>()
/** Repository the overrides above belong to (`alias\nroot`); '' = none. */
let stageOverrideTarget = ''
/** Monotonic ticket: what a status read started at (see `applyStageOverrides`). */
let stageSeq = 0

/** Repository identity for the override bookkeeping. */
function stageTargetKey(target: { alias: string; root: string }): string {
  return `${target.alias}\n${target.root}`
}

/**
 * The stage/unstage coordinator (see `scm/stage-queue.ts`).
 *
 * One instance per page: the panel's clicks, this store's status model and the
 * user notifications meet here. Every verb it drives is the panel's own action
 * layer, so nothing about it needs a host-side change.
 */
const stageCoordinator = new StageCoordinator(
  {
    stage: (target, paths) => stagePaths(target.alias, target.root, paths),
    unstage: (target, paths) => unstagePaths(target.alias, target.root, paths),
    probe: (target, paths) => probeStatusPaths(target.alias, target.root, paths),
  },
  {
    apply: applyLocalStage,
    report: (notice) => {
      // The wording lives HERE, as two literal `t()` calls: the coordinator has
      // no i18n (it is driven by a check with no React), and a key reached
      // through a lookup would look unreferenced to `.spike/i18n-check.mjs`.
      const paths = noticePaths(notice.paths)
      if (notice.kind === 'mismatch') toast(`${t('scm.stageMismatch')} · ${paths}`, true)
      else toast(`${t('scm.stageUnverified')} · ${paths}`, true)
    },
  },
)

/** How many affected paths a notice names before it summarises them. */
const NOTICE_PATHS = 3

/** A short, readable path list for a stage/unstage notice. */
function noticePaths(paths: readonly string[]): string {
  if (paths.length <= NOTICE_PATHS) return paths.join(', ')
  return `${paths.slice(0, NOTICE_PATHS).join(', ')} (+${paths.length - NOTICE_PATHS})`
}

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
  gitDeadlineMs: DEFAULT_GIT_TIMEOUT_MS,
  tabs: [],
  activeTabId: undefined,
  revision: 0,
  editorSurface: 'sidebar',
  floatOpen: false,
  floatAvailable: false,
  view: readStoredView(),
  searchRequest: undefined,
  revealRequest: undefined,
  terminalRequest: undefined,
  untrackedDirs: new Map(),
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
  /** Effective per-git-command budget (ms), for the loading hint. */
  gitDeadlineMs: number
  tabs: EditorTab[]
  activeTab: EditorTab | undefined
  activeTabId: string | undefined
  revision: number
  /** Effective editor mount: the floating window wins over the base surface. */
  editorSurface: EditorSurface
  floatOpen: boolean
  floatAvailable: boolean
  view: RailView
  searchRequest: SearchRequest | undefined
  /** Pending "show this folder in the tree" request (consumed by the explorer). */
  revealRequest: RevealRequest | undefined
  /** Pending "open a terminal here" request (consumed by the terminal panel). */
  terminalRequest: TerminalRequest | undefined
  setView: (view: RailView) => void
  /** Switch to the search panel (optionally scoped to a folder) — the tree's
      "find in folder" entry point. */
  requestSearch: (request: { mode: 'name' | 'content'; query?: string; scope: string }) => void
  /**
   * Show one remote directory in the explorer: switch to it, expand the folder
   * and its ancestors, then scroll its row into view. Raised by the search
   * results' "open containing folder" entry.
   */
  revealInExplorer: (dir: string) => void
  /**
   * Open a fresh terminal tab whose shell `cd`s into `dir`. Raised by the
   * search results' "open in terminal" entry.
   */
  openTerminalAt: (dir: string) => void
  /**
   * The USER's pick — the workspace dropdowns and the wizard's "open files".
   *
   * Only this entry point records a choice: it is what lets a pending follow
   * know the user has taken over. Switches the plugin makes on its own (opening
   * a file that lives in another binding, the follow itself) go through the
   * store's internal auto path instead and never claim to be a choice.
   */
  selectWorkspace: (id: string) => void
  /** Point git at a directory inside the workspace (repositories often live in
      a subdirectory of the binding rather than at its root). */
  setRepoSubdir: (subdir: string) => Promise<void>
  /** Repositories found under the workspace root, as workspace-relative dirs. */
  discoverRepos: () => Promise<string[]>
  refreshAll: () => void
  refreshGit: () => Promise<void>
  afterWrite: () => Promise<void>
  /**
   * Stage / unstage paths: the row moves at once, and ONE path-limited status
   * confirms it (no repository-wide status, no extras — see `stageOptimistic`).
   */
  stageOptimistic: (paths: readonly string[], staged: boolean) => Promise<void>
  /** Expanded untracked directory rows: directory path → the rows under it. */
  untrackedDirs: DirExpansions
  /** Expand / collapse one untracked directory row (one path-limited status). */
  toggleUntrackedDir: (dirPath: string) => Promise<void>
  openFile: (fullPath: string, options?: { line?: number }) => void
  /**
   * 「在悬浮编辑器中打开」：把编辑器整体浮出，再打开这个文件。
   *
   * 先捕获当前编辑器缓冲区再切表面（见 `captureLiveBuffer`）：主界面里没保存
   * 的编辑不会因为这次切换丢掉。
   */
  openInFloatEditor: (fullPath: string, options?: { line?: number }) => void
  /** 同上，只是打开的是工作区 diff（SCM 更改列表的悬浮入口）。 */
  openDiffInFloatEditor: (rel: string, staged: boolean, untracked?: boolean) => void
  /** 停靠回主界面（底层的中心视图或侧栏表面）。 */
  dockFloatingEditor: () => void
  openDiff: (rel: string, staged: boolean, untracked?: boolean) => void
  openCommitFile: (hash: string, rel: string) => void
  activateTab: (id: string) => void
  closeTab: (id: string) => void
  updateTab: (id: string, patch: Partial<EditorTab>) => void
  /** 换一份会话改动标记（`activeHunk` 归零）。 */
  applyChangeSet: (tabId: string, set: ChangeSet | null) => void
  /** 上一个 / 下一个改动点（绕回），返回目标行号并驱动编辑器跳过去。 */
  gotoChange: (tabId: string, dir: 1 | -1) => number | undefined
  /** 编辑器报告文档已脱钩：标记作废，等上层重新拉数据。 */
  markChangeStale: (tabId: string) => void
  /**
   * 撤销本会话在某个文件里的一处改动（悬浮按钮那一动作；`mark` 来自
   * `changeSet.marks`，`hunk` 是 `patches` 的下标）。
   */
  undoChange: (tabId: string, mark: ChangeMark) => Promise<void>
  /**
   * Write one file tab back to the remote host.
   * @returns true only when the write really succeeded — the caller uses it to
   *   advance the editor's dirty baseline (see `CodeEditorHandle.markSaved`).
   */
  saveTab: (id: string, content: string) => Promise<boolean>
  reloadTab: (id: string) => Promise<void>
  info: (text: string) => void
  fail: (text: string) => void
}

/** Stable action identities — `build()` runs on every publish. */
const info = (text: string): void => toast(text, false)
const fail = (text: string): void => toast(text, true)

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
 *
 * DECLARATION ORDER IS LOAD-BEARING: this block must stay ABOVE the
 * `snapshot = build()` line below. `build()` is invoked during module
 * evaluation, so a `let` declared after that call is still in its temporal dead
 * zone and the module throws "Cannot access 'derivedViews' before
 * initialization" — which neither `tsc` nor the bundler can see.
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

const listeners = new Set<() => void>()
let snapshot: ExplorerValue = build()

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
    gitDeadlineMs: state.gitDeadlineMs,
    tabs: state.tabs,
    activeTab: state.tabs.find(item => item.id === state.activeTabId),
    activeTabId: state.activeTabId,
    revision: state.revision,
    editorSurface: effectiveEditorSurface(state.editorSurface, state.floatOpen),
    floatOpen: state.floatOpen,
    floatAvailable: state.floatAvailable,
    view: state.view,
    searchRequest: state.searchRequest,
    revealRequest: state.revealRequest,
    terminalRequest: state.terminalRequest,
    setView,
    requestSearch,
    revealInExplorer,
    openTerminalAt,
    selectWorkspace,
    setRepoSubdir,
    discoverRepos,
    refreshAll,
    refreshGit,
    afterWrite,
    stageOptimistic,
    untrackedDirs: state.untrackedDirs,
    toggleUntrackedDir,
    openFile,
    openInFloatEditor,
    openDiffInFloatEditor,
    dockFloatingEditor,
    openDiff,
    openCommitFile,
    activateTab,
    closeTab,
    updateTab,
    applyChangeSet,
    gotoChange,
    markChangeStale,
    undoChange,
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
      // Apply the Host's effective timeouts FIRST: `refreshGit()` right below
      // computes its deadline from them, and a stale default would cut a large
      // repository off at the old 45 s before the raised value could apply.
      const timeouts = configureTimeouts(payload.timeouts)
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
        gitDeadlineMs: timeouts.gitMs,
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

/** Monotonic ticket for "show this folder" requests (0 = none yet). */
let revealSeq = 0

/**
 * Show one remote directory in the explorer.
 *
 * Two stages, because the tree is lazily loaded: this raises the request and
 * switches the panel, and the explorer itself expands the ancestors (loading
 * each level) and scrolls the row into view — it is the only place that knows
 * which directories are currently expanded.
 *
 * @param dir - absolute remote DIRECTORY (a file's parent for a file hit).
 */
export function revealInExplorer(dir: string): void {
  revealSeq += 1
  patch({ revealRequest: { id: revealSeq, path: dir } })
  setView('explorer')
}

/** Monotonic ticket for "open a terminal here" requests. */
let terminalSeq = 0

/**
 * Open a fresh terminal tab whose shell lands in `dir` — on the CURRENT
 * workspace's host.
 *
 * The terminal panel consumes the request (it owns the tabs) and the shell gets
 * a quoted `cd` once its PTY reports ready — the host's terminal route has no
 * "start in this directory" parameter, so a typed command is the honest way.
 *
 * The alias travels IN the request. The panel otherwise opens new tabs on the
 * host it last used, which put the shell on a different machine than the path
 * belongs to and made the `cd` fail with "No such file or directory".
 *
 * @param dir - absolute remote directory.
 */
export function openTerminalAt(dir: string): void {
  terminalSeq += 1
  patch({ terminalRequest: { id: terminalSeq, alias: currentWorkspace()?.alias ?? '', dir } })
  setView('terminal')
}

/**
 * Select the binding every view works against — the USER's choice.
 *
 * This is the entry point the snapshot hands to the views (`ExplorerValue.
 * selectWorkspace`), so every dropdown and the workspace wizard land here. It
 * records the pick for the session on screen, which is what stops a follow that
 * has not resolved yet from undoing it.
 */
export function selectWorkspace(id: string): void {
  applyWorkspaceSelection(id, true)
}

/**
 * Select a binding on the PLUGIN's own initiative, claiming nothing.
 *
 * Two callers: opening a file that belongs to another binding (the change
 * panel, the click interceptor) and the follow itself. Neither is a statement
 * about where the user wants to browse — clicking a changed file is "show me
 * this result", not "I moved my workspace" — so a pending follow stays free to
 * put the selection back on the session's binding afterwards.
 */
function selectWorkspaceAuto(id: string): void {
  applyWorkspaceSelection(id, false)
}

/** Move the selection; `byUser` decides whether it is remembered as a choice. */
function applyWorkspaceSelection(id: string, byUser: boolean): void {
  if (state.workspaceId === id) return
  if (byUser) noteManualPick()
  // Local stage results are repository-relative: another binding's paths must
  // never be re-applied to this one. The expanded untracked directories are
  // repository-relative too.
  stageOverrides = new Map()
  stageOverrideTarget = ''
  patch({
    workspaceId: id,
    tabs: [],
    activeTabId: undefined,
    status: undefined,
    head: undefined,
    repoRoot: undefined,
    repoSubdir: readRepoSubdir(id),
    untrackedDirs: new Map(),
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
 * The session whose binding the sidebar already followed (per page load).
 *
 * Module state, not a ref: the two surfaces that can trigger the follow (the
 * sidebar and the change panel) must share it, or each would drag the selector
 * to its own idea of the session's workspace on every repaint.
 */
let followedSession: string | undefined

/**
 * The binding resolved for `followedSession` (module state, same reason).
 *
 * Kept beside `followedSession` because the two are only meaningful together:
 * `workspaceMatchesSession()` trusts this id only while the session it was
 * resolved FOR is still the one being followed.
 */
let followedBindingId: string | undefined

/**
 * The registered session whose selection the USER took over by hand.
 *
 * "Follow once, then the user's choice stands" cannot be decided from
 * `followedSession` alone: a session whose workspace never resolved (a probe
 * that failed, a host that answers nothing) has no follow to remember, and the
 * retry keeps asking — so a resolution landing later would yank a selection the
 * user made in the meantime.
 *
 * Recorded ONLY for an explicit user switch (the dropdowns, the workspace
 * wizard). A selection the plugin moved on its own — clicking a changed file
 * that lives in another binding, opening it from the reference interceptor — is
 * "show me this result", not a browsing decision, and must not cancel a follow
 * that is still resolving. Cleared when the session changes (a new seat
 * re-follows).
 */
let manualPickSession: string | undefined

/**
 * Remember an explicit user choice of workspace.
 *
 * Called from the user entry point (`selectWorkspace`) only; the `let` above
 * lives with the follow narrative rather than next to the selector, so this
 * stays a hoisted call.
 */
function noteManualPick(): void {
  if (followSessionId !== undefined) manualPickSession = followSessionId
}

/**
 * The session the surfaces are showing — the subject of every follow.
 *
 * Module state, and deliberately not a React ref: this is what makes the
 * session→workspace resolution work with NO UI mounted at all. The change panel
 * registers the session it renders (see `ChangesDock`), so a conversation whose
 * sidebar was never opened still resolves its own workspace — and a first scan
 * can never be handed another workspace's repository directory.
 */
let followSessionId: string | undefined

/**
 * Register the session every follow call is about.
 *
 * Called by the surfaces that know which session is on screen. Clearing it is a
 * real state — "no session on screen" — and every consumer then answers "not
 * this session" instead of guessing.
 */
export function setFollowSession(sessionId: string | undefined): void {
  const next = sessionId === undefined || sessionId === '' ? undefined : sessionId
  if (followSessionId === next) return
  followSessionId = next
  // A new seat re-follows: the previous session's manual pick was about that
  // session's workspace, not this one's.
  manualPickSession = undefined
}

/** One resolution in flight, so the same session is never probed twice at once. */
let followFlight: { sessionId: string; promise: Promise<string | undefined> } | undefined

/**
 * Point the workspace selector (and with it the tree, the editor's dropdown and
 * the git panel) at the binding the registered session works in.
 *
 * The user's complaint this exists for: opening a session in one remote
 * workspace showed the sidebar on another — the selector kept whatever
 * localStorage held (or the FIRST binding, on a fresh profile), and a click in
 * the change panel matched its binding by alias alone, which is ambiguous as
 * soon as one host carries two workspaces under one alias).
 *
 * Resolution order, strongest evidence first (all of it inside
 * `planWorkspaceFollow`, so the policy has exactly one home):
 *  1. `workspacePath` — the host's own workspace membership for the session,
 *     which IS the alias dir of exactly one binding;
 *  2. `alias` + `remoteRoot` — what the change panel holds once it has a
 *     summary (`bindingForRemoteFile`), which disambiguates by REMOTE path;
 *  3. the session's own cwd, asked of the host (`api.sessionCwd`) — the only
 *     source available BEFORE the panel's first successful scan, which is
 *     precisely the state that used to send a foreign repository directory.
 *
 * Idempotent and re-entrant by construction:
 *  - once the session has been followed, later calls answer the recorded
 *    binding without touching the network, so a manual pick stands;
 *  - a pick the USER made before anything resolved stands just the same (see
 *    `manualPickSession`), so the retry can never undo an explicit choice;
 *  - while a resolution is in flight, concurrent callers share that one
 *    promise (the sidebar and the panel both trigger this);
 *  - an answer that arrives after the session changed is discarded.
 *
 * Called with no evidence at all it does nothing rather than guessing: an
 * unknown session must never move the selection, and must never fall back to
 * "the first binding".
 *
 * @returns the binding id that was selected, or `undefined` when nothing moved.
 */
export function followSessionWorkspace(options: {
  /** The session the caller's evidence belongs to; defaults to the registered one. */
  sessionId?: string | undefined
  /** The session's host workspace path (the local alias dir), when known. */
  workspacePath?: string | undefined
  /** Host alias the session is routed to, when known. */
  alias?: string | undefined
  /** Absolute remote root of the session's workspace, when known. */
  remoteRoot?: string | undefined
} = {}): Promise<string | undefined> {
  const asked = options.sessionId
  if (asked !== undefined && asked !== '') {
    if (followSessionId === undefined) setFollowSession(asked)
    // Evidence for one session must never steer another: the surface that owns
    // the session on screen follows it, and this one is stale.
    else if (followSessionId !== asked) return Promise.resolve(undefined)
  }
  const sessionId = followSessionId
  if (sessionId === undefined) return Promise.resolve(undefined)
  // Already followed: the user's manual pick stands, and no round trip is spent
  // re-deciding what was already decided. A manual pick made BEFORE anything
  // resolved (see `manualPickSession`) is the same promise, kept even though
  // there is no follow to remember.
  if (followedSession === sessionId) return Promise.resolve(followedBindingId)
  if (manualPickSession === sessionId) return Promise.resolve(undefined)
  const inFlight = followFlight
  if (inFlight !== undefined && inFlight.sessionId === sessionId) return inFlight.promise
  const promise = resolveSessionWorkspace(sessionId, options).finally(() => {
    if (followFlight?.promise === promise) followFlight = undefined
  })
  followFlight = { sessionId, promise }
  return promise
}

/**
 * Resolve one session's binding and apply it (the applier behind the API above).
 *
 * The cwd probe is a LAST resort, and only when the caller's own evidence
 * resolved nothing: it is an HTTP round trip per attempt, and the panel retries
 * on a slow timer — evidence that already answers must not cost one. A probe
 * that fails (or answers nothing usable) leaves the selection exactly as it
 * was; the caller retries later, and `workspaceMatchesSession()` keeps saying
 * "not proven" in the meantime, so nothing wrong is ever sent.
 */
async function resolveSessionWorkspace(
  sessionId: string,
  options: { workspacePath?: string | undefined; alias?: string | undefined; remoteRoot?: string | undefined },
): Promise<string | undefined> {
  const plan = (cwd?: string): WorkspaceFollowDecision => planWorkspaceFollow({
    table: remoteOpenBindings(),
    sessionId,
    workspacePath: options.workspacePath,
    alias: options.alias,
    remoteRoot: options.remoteRoot,
    sessionCwd: cwd,
    followedSession,
  })
  let decision = plan()
  if (decision.action === 'keep' && decision.reason === 'unresolved') {
    let cwd: string | undefined
    try {
      const answer = await api.sessionCwd(sessionId)
      cwd = answer.cwd
    } catch {
      // A failed probe resolves nothing: the selection stands, nothing is sent.
      return undefined
    }
    // The session may have changed while the host was answering; its evidence
    // must not be applied to the new one.
    if (followSessionId !== sessionId) return undefined
    if (cwd !== undefined && cwd !== '') decision = plan(cwd)
  }
  if (decision.action === 'keep') return undefined
  // The user may have chosen a workspace WHILE this resolution was in flight:
  // a choice beats a late answer.
  if (followSessionId !== sessionId || manualPickSession === sessionId) return undefined
  followedSession = decision.followedSession
  followedBindingId = decision.bindingId
  if (state.workspaceId !== decision.bindingId) selectWorkspaceAuto(decision.bindingId)
  return decision.bindingId
}

/**
 * Whether the views' CURRENT selection is the binding resolved for the followed
 * session. `false` whenever that cannot be proven (no session, nothing resolved
 * yet, or a manual pick moved the selection elsewhere) — see
 * `selectionIsSessionBinding`, which owns the comparison.
 */
export function workspaceMatchesSession(): boolean {
  return selectionIsSessionBinding({
    table: remoteOpenBindings(),
    sessionId: followSessionId,
    followedSession,
    followedBindingId,
    selectedId: currentWorkspace()?.id,
  })
}

/**
 * The repository sub-directory to hand the host for one session, or `''` when
 * the selection cannot be proven to be that session's binding.
 *
 * `''` is not "no answer": it tells the host to use the SESSION ROOT (and its
 * own unique-candidate probe), which is the only correct instruction when the
 * caller cannot name the session's repository. Sending the selected binding's
 * directory instead is what produced the reported loop — the host ran `cd` on
 * `session root + another workspace's subdir`, answered `session directory is
 * missing on the host` (exit 90), the panel lost its summary and asked again
 * three seconds later, forever.
 *
 * @param sessionId - the session the caller is about to ask the host about.
 *   Omitted, the registered session is used; given, a registration that is
 *   about a DIFFERENT session answers `''` — a panel listing one conversation
 *   must never describe another one's repository.
 */
export function sessionRepoSubdir(sessionId?: string | undefined): string {
  if (sessionId !== undefined && sessionId !== '' && sessionId !== followSessionId) return ''
  if (!workspaceMatchesSession()) return ''
  return readRepoSubdir(activeBinding().key)
}

/** The binding id the views are on (the dropdown/tree's answer), plain read. */
export function selectedWorkspaceId(): string {
  return currentWorkspace()?.id ?? ''
}

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
  // A local stage/unstage that happens while this read is in flight cannot be
  // in its answer: remember where the local timeline stood when it started.
  const stageAt = stageSeq
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
      withDeadline(loadStatusDetail(workspace.alias, root), gitDeadlineMs(), t('editor.readTimeout')),
      withDeadline(loadHead(workspace.alias, root), gitDeadlineMs(), t('editor.readTimeout')),
    ])
    if (stale()) return
    // A directory INSIDE a repository settles on that repository's root, so the
    // stored choice is what git actually uses (and what the picker shows).
    const settled = repoSubdirOf(workspace.remotePath, root) ?? state.repoSubdir
    if (settled !== state.repoSubdir) writeRepoSubdir(key, settled)
    // Keep the local stage results this read could not have seen, and retire
    // the ones it did see (they are in `detail` now, for better or worse).
    const target = stageTargetKey({ alias: workspace.alias, root })
    const status = stageOverrideTarget === target ? applyStageOverrides(detail, stageOverrides, stageAt) : detail
    if (stageOverrideTarget === target) {
      for (const [path, override] of stageOverrides) {
        if (override.at <= stageAt) stageOverrides.delete(path)
      }
    }
    // An expanded untracked directory survives this refresh only while git still
    // reports the same directory row (see `pruneDirExpansions`).
    patch({
      repoRoot: root,
      repoSubdir: settled,
      repoMissing: false,
      status,
      head,
      gitBusy: false,
      gitError: undefined,
      untrackedDirs: pruneDirExpansions(state.untrackedDirs, status),
    })
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

/** The repository the SCM panel is pointed at, or undefined when none. */
export function scmTarget(): { alias: string; root: string } | undefined {
  const workspace = currentWorkspace()
  if (workspace === undefined || state.repoRoot === undefined) return undefined
  return { alias: workspace.alias, root: state.repoRoot }
}

/**
 * Move paths between the index and the worktree halves of the LOCAL status
 * model — the optimistic update, its rollback, and the correction the probe
 * asks for all land here.
 *
 * Pure model work: no command is issued, nothing but `status` is republished,
 * and the explorer's revision is left alone (staging does not change the remote
 * tree, so re-listing directories over SFTP would be pure waste). The paths are
 * also remembered so a full status read that started BEFORE this change cannot
 * undo it (see `applyStageOverrides`).
 */
export function applyLocalStage(paths: readonly string[], staged: boolean): void {
  if (paths.length === 0) return
  const target = scmTarget()
  const key = target === undefined ? '' : stageTargetKey(target)
  if (key !== stageOverrideTarget) {
    // Another repository (or none): the previous overrides name paths that
    // mean something else here, so they must not be applied to it.
    stageOverrides = new Map()
    stageOverrideTarget = key
  }
  stageSeq += 1
  for (const path of paths) stageOverrides.set(path, { staged, at: stageSeq })
  if (state.status === undefined) return
  // A file inside an expanded untracked directory has no record of its own
  // (`-u normal` reported only the directory): staging it must still show up
  // under "staged changes" instead of vanishing from the list.
  let next = state.status
  if (staged) for (const path of paths) next = insertStagedEntry(next, path)
  next = optimisticStageDetail(next, paths, staged)
  if (next === state.status) return
  // A staged row is no longer an untracked row: it leaves the expansion, and a
  // directory row that stopped being untracked takes its whole expansion with
  // it (see `pruneDirExpansions`).
  const dirs = staged ? dropExpandedRows(state.untrackedDirs, paths) : state.untrackedDirs
  patch({ status: next, untrackedDirs: pruneDirExpansions(dirs, next) })
}

/**
 * Stage / unstage paths with instant local feedback and ONE cheap check.
 *
 * The reported problem: `+` on one file in a large repository fired four
 * repository-wide git commands (the `git add`, a full `git status`, and the
 * three extras loaders), so the click cost minutes and locked the panel. Here
 * the row moves immediately in the local model, the real verb goes out at once,
 * and a single path-limited `git status -- <paths>` (cost independent of the
 * repository size) confirms it — rolling the row back and telling the user when
 * the repository disagrees.
 *
 * Resolves when the verification is in; rejects when the git verb itself failed
 * (the caller reports that error).
 */
export async function stageOptimistic(paths: readonly string[], staged: boolean): Promise<void> {
  const target = scmTarget()
  if (target === undefined || paths.length === 0) return
  await stageCoordinator.submit(target, paths, staged)
}

/**
 * Expand or collapse one untracked DIRECTORY row.
 *
 * `-u normal` collapses an untracked directory into a single `dir/` row, so its
 * contents are invisible. Expanding costs exactly ONE path-limited
 * `git status -uall -- <dir>/` — never a repository-wide status, never the
 * extras — and the rows it answers with are shown under the directory row.
 * Collapsing costs nothing at all.
 *
 * The expansions are pruned against every status the panel adopts, so a
 * directory that gets staged or deleted takes its rows with it (see
 * `scm/untracked-dirs.ts`).
 *
 * @param dirPath - the directory row's repo-relative path (with its `/`).
 */
export async function toggleUntrackedDir(dirPath: string): Promise<void> {
  if (dirPath === '' || !dirPath.endsWith('/')) return
  if (state.untrackedDirs.has(dirPath)) {
    patch({ untrackedDirs: collapseDir(state.untrackedDirs, dirPath) })
    return
  }
  // A double click must not buy two probes: the second click only arrives while
  // the first one's answer is still in flight.
  if (dirProbes.has(dirPath)) return
  const target = scmTarget()
  if (target === undefined) return
  dirProbes.add(dirPath)
  try {
    const stdout = await probeStatusDir(target.alias, target.root, dirPath)
    // Read the state AFTER the round trip: another directory may have been
    // expanded (or this one collapsed) while the probe was in flight.
    patch({ untrackedDirs: expandDir(state.untrackedDirs, dirPath, stdout) })
  } finally {
    dirProbes.delete(dirPath)
  }
}

/** Directory rows whose expansion probe is in flight (see `toggleUntrackedDir`). */
const dirProbes = new Set<string>()

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
  // While the editor floats, the shell tab has no editor to reveal: the file
  // just went into the floating window (which is already on screen).
  if (effectiveEditorSurface(state.editorSurface, state.floatOpen) !== 'center') return
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

/**
 * Copy the live editor buffer onto its tab before the editor is remounted.
 *
 * Why this exists: `CodeEditor` reads its `initial` text ONCE, on mount
 * (`src/client/CodeEditor.tsx`), and the tab's stored text is only ever written
 * by a load/reload/handoff — typing lives exclusively in CodeMirror. Every tab
 * switch (a normal file click, another tab in the strip, a diff) and every
 * editor-surface flip therefore unmounts and remounts the editor, and without
 * this handoff the edits typed since the load would silently disappear (and a
 * later Ctrl+S would write the pre-edit text back).
 *
 * The text is written into the tab, which is exactly the input the replacement
 * mount reads: no extra channel exists or is needed. The DISK-side baseline is
 * deliberately left alone (`EditorTab.baseline`), so the remount still knows
 * the text is unsaved. The scroll + caret half of the handoff lives in
 * `live-editor.ts`.
 */
function captureLiveBuffer(): void {
  // The position is cheap and is needed even for a CLEAN tab: a surface flip
  // remounts the very same tab, and the replacement's render happens before
  // the old view's unmount report.
  captureLiveEditorPosition()
  const active = state.tabs.find(item => item.id === state.activeTabId)
  // The whole document is only materialized when the tab may hold something the
  // store does not: the buffer is edited, or a previous handoff already copied
  // unsaved text into `text` (so undoing back to the disk bytes must still be
  // carried). A clean, already-synced tab skips the O(file) copy.
  const synced = active !== undefined
    && active.kind === 'file'
    && active.text === (active.baseline ?? active.text)
  if (synced && !isLiveEditorDirty()) return
  const captured = captureLiveEditorText()
  if (captured === undefined) return
  const tab = state.tabs.find(item => item.id === captured.tabId)
  // Diffs and previews have no CodeMirror buffer; and an unchanged buffer
  // would just hand the same string back, so neither case touches the store.
  if (tab === undefined || tab.kind !== 'file' || tab.text === captured.text) return
  patchTab(captured.tabId, { text: captured.text })
}

/**
 * Flip the editor into the floating surface, capturing the live buffer first.
 *
 * A no-op while already floating (the editor is not remounted then), and a
 * toast-only refusal on a host that cannot host the window — the caller still
 * opens the file, just on the normal surface.
 */
function enterFloatSurface(): void {
  if (!state.floatAvailable) {
    toast(t('float.unavailable'), true)
    return
  }
  if (state.floatOpen) return
  captureLiveBuffer()
  patch({ floatOpen: true })
}

/**
 * Deadline for one git round trip.
 *
 * Was a fixed 45 s shared with file reads, which made a cold `git status` on a
 * large remote repository look like a dead host ("读取超时（远端无响应）(45s)").
 * Git now follows the configured `gitTimeoutMs` (default 300 s), refreshed from
 * the Host's workspaces answer — see `timeouts.ts`.
 */
function gitDeadlineMs(): number {
  return clientDeadlineFor(gitTimeoutMs())
}

/** Deadline for one SFTP file read (editor, diff sides, preview). */
function fileReadDeadlineMs(): number {
  return clientDeadlineFor(fileReadTimeoutMs())
}

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
  captureLiveBuffer()
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
      const read = await withDeadline(api.fileOp.read(workspace.alias, fullPath), fileReadDeadlineMs(), t('editor.readTimeout'))
      patchTab(id, {
        loading: false,
        binary: read.binary,
        truncated: read.truncated,
        text: read.binary ? '' : (read.text ?? ''),
        // The disk side of the dirty comparison (see EditorTab.baseline).
        ...(read.binary ? {} : { baseline: read.text ?? '' }),
      })
    } catch (error) {
      patchTab(id, { loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  })()
}

/**
 * Binding table for the click interceptor (`remote-file-open.ts`).
 *
 * A plain snapshot read, not a hook: the interceptor runs inside a service
 * method call (no React render), so it needs the current bindings and alias
 * directories synchronously. Unknown/empty state answers empty tables.
 */
export function remoteOpenBindings(): {
  bindings: RemoteWorkspaceBinding[]
  aliasPaths: Record<string, string>
} {
  return { bindings: state.workspaces, aliasPaths: state.routing.aliasPaths }
}

/**
 * Open one file that belongs to a SPECIFIC remote binding (the click
 * interceptor already resolved it), switching the explorer's selected
 * workspace when the on-screen one differs.
 *
 * @returns true when the file was handed to the editor; false when the binding
 *   is unknown (the caller then keeps the native preview).
 */
export function openRemoteFileInBinding(
  bindingId: string,
  remotePath: string,
  options: { line?: number } = {},
): boolean {
  const binding = state.workspaces.find(item => item.id === bindingId)
  if (binding === undefined || remotePath === '') return false
  // AUTO, not a user choice: clicking a result that lives in another binding
  // must not cancel the session's pending follow (see `selectWorkspaceAuto`).
  if (state.workspaceId !== binding.id) selectWorkspaceAuto(binding.id)
  openFile(remotePath, options)
  return true
}

/**
 * Whether the plugin's own rich editor is the place a remote file click should
 * land (the click interceptor's gate, see `remote-file-open.ts`).
 *
 * The centre conversation view is the normal case; while the editor floats it
 * is the floating window instead — the file still belongs in OUR editor, not in
 * the host's native preview. On the sidebar-fallback layout (`sidebar`) the
 * interceptor stays off, exactly as before this feature.
 */
export function isEditorTakeoverActive(): boolean {
  return effectiveEditorSurface(state.editorSurface, state.floatOpen) !== 'sidebar'
}

/** Open (or focus) a working-tree diff of one repository path. */
export function openDiff(rel: string, staged: boolean, untracked = false): void {
  captureLiveBuffer()
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
      const payload = await withDeadline(loadDiff(workspace.alias, root, rel, staged, untracked), gitDeadlineMs(), t('editor.readTimeout'))
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
  captureLiveBuffer()
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
      const payload = await withDeadline(loadCommitFileDiff(workspace.alias, root, hash, rel), gitDeadlineMs(), t('editor.readTimeout'))
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
  // Switching away from a file tab remounts the editor, so the outgoing live
  // buffer has to be captured first — otherwise every tab click silently
  // discards edits typed since that tab was loaded (the tab's `text` is only
  // the last load/handoff copy). Same protection for the pre-existing paths
  // that switch tabs below (`openFile`/`openDiff`/`openCommitFile`).
  captureLiveBuffer()
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

/** Write one tab back to the remote host. @returns true when the write landed. */
export async function saveTab(id: string, content: string): Promise<boolean> {
  const workspace = currentWorkspace()
  const tab = state.tabs.find(item => item.id === id)
  if (workspace === undefined || tab === undefined || tab.kind !== 'file' || tab.binary || tab.truncated) return false
  // Never fall back to the tab's loaded text. `tab.text` is only ever written
  // by a load/reload or by the surface handoff (`captureLiveBuffer`), never as
  // a fallback for a caller without a live buffer, so substituting it here
  // would push the PRE-EDIT (or the lost-buffer) bytes to the remote file and
  // report success — destroying the user's edit with a confirmation. A caller
  // without a live buffer must refuse to save instead (see EditorPane.saveActive).
  if (typeof content !== 'string') {
    toast(t('editor.needSource'), true)
    return false
  }
  const text = content
  patchTab(id, { saving: true, text })
  try {
    await api.fileOp.write(workspace.alias, tab.fullPath, text)
    /**
     * The remote file now holds `text`, so that becomes the disk-side dirty
     * baseline (a later remount compares against it).
     *
     * The dirty FLAG is deliberately not written here when a live editor is
     * mounted for this tab: the user may have typed while the write was in
     * flight, and clearing it would mark that newer buffer saved. The editor
     * re-derives it (`markLiveEditorSaved` below) — and if the pane was
     * remounted mid-write, the correction reaches the replacement through the
     * `savedText` prop effect in `CodeEditor`. Only a tab with NO mounted
     * editor (closed while saving, or never focused) has nothing that could be
     * newer, and there the flag is cleared directly.
     */
    const liveEditor = isLiveEditorFor(id)
    patchTab(id, { saving: false, baseline: text, ...(liveEditor ? {} : { dirty: false }) })
    markLiveEditorSaved(id, text)
    toast(`${t('editor.saved')} · ${tab.rel}`, false)
    await afterWrite()
    return true
  } catch (error) {
    patchTab(id, { saving: false })
    toast(error instanceof Error ? error.message : String(error), true)
    return false
  }
}

/**
 * Re-read one tab (file content or diff payload).
 *
 * A FILE tab's content has to reach the mounted editor through a REMOUNT, which
 * is why the nonce below exists: `CodeEditor` reads its `initial` prop once, on
 * mount (`key` = tab identity), so patching `tab.text` alone leaves the live
 * buffer on the OLD bytes — the screen would show content the remote file no
 * longer has, and the next Ctrl+S would write those stale bytes back, silently
 * undoing whatever changed the file (a hover-revert, a discard, another tool).
 * `EditorPane` folds `reloadNonce` into the editor's `key`; bumping it here is
 * what makes the re-read visible, and the remount restores scroll + caret from
 * the per-tab view state (see `.spike/viewstate-check.mjs`).
 *
 * ORDER IS LOAD-BEARING: text and `dirty` are patched FIRST, the nonce SECOND.
 * The remount reads `initial` from the tab, so a nonce bump that raced ahead of
 * the new text would mount the editor on the old content — exactly the bug this
 * is fixing, only harder to see.
 */
export async function reloadTab(id: string): Promise<void> {
  const workspace = currentWorkspace()
  const tab = state.tabs.find(item => item.id === id)
  if (workspace === undefined || tab === undefined) return
  if (tab.kind === 'file') {
    try {
      const read = await withDeadline(api.fileOp.read(workspace.alias, tab.fullPath), fileReadDeadlineMs(), t('editor.readTimeout'))
      patchTab(id, {
        loading: false,
        error: undefined,
        text: read.binary ? '' : (read.text ?? ''),
        binary: read.binary,
        truncated: read.truncated,
        dirty: false,
        ...(read.binary ? {} : { baseline: read.text ?? '' }),
      })
      // Only now: the new text must already be in the tab when the editor remounts.
      patchTab(id, { reloadNonce: (tab.reloadNonce ?? 0) + 1 })
    } catch (error) {
      patchTab(id, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  const root = state.repoRoot
  if (root === undefined) return
  try {
    const payload = tab.ref !== undefined
      ? await withDeadline(loadCommitFileDiff(workspace.alias, root, tab.ref, tab.rel), gitDeadlineMs(), t('editor.readTimeout'))
      : await withDeadline(loadDiff(workspace.alias, root, tab.rel, tab.staged, tab.untracked), gitDeadlineMs(), t('editor.readTimeout'))
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

/**
 * Record that the host's frame-wide overlay slot actually rendered the
 * floating window host (see `FloatingEditorWindow`).
 *
 * This is a runtime handshake, not a configuration flag: on a host whose
 * `shell.overlay` slot is missing, the entry never mounts and the menu entries
 * stay disabled instead of opening a surface that cannot paint.
 */
export function setFloatEditorAvailable(available: boolean): void {
  if (available) {
    if (state.floatAvailable) return
    patch({ floatAvailable: true })
    return
  }
  // The host went away while the editor floated (plugin unmount / host swap).
  // Keeping `floatOpen` would leave the main surfaces showing the "docked
  // elsewhere" placeholder with no window to dock from, so the flag has to go.
  //
  // The capture below is BEST EFFORT and usually cannot carry the text: React
  // detaches a child's ref before the parent's passive cleanup runs, so the
  // editor handle is already gone by the time the overlay entry unmounts. The
  // tab therefore keeps whatever the last switch captured — this call must not
  // be read as a guarantee.
  if (!state.floatAvailable && !state.floatOpen) return
  captureLiveBuffer()
  patch({ floatAvailable: false, floatOpen: false })
}

/**
 * Open one file in the floating editor (file-tree / search / SCM menu action).
 *
 * Order matters twice:
 *   1. the live buffer is captured BEFORE the surface flips (the flip unmounts
 *      the editor that owns it);
 *   2. a second capture runs even when already floating, because opening
 *      another file is a tab switch — the very action that remounts the editor
 *      and would otherwise drop the edits typed in the tab being left.
 * A host whose overlay slot is unavailable gets the file in the normal surface
 * instead (with the reason toasted), so the click is never a dead end.
 */
export function openInFloatEditor(fullPath: string, options: { line?: number } = {}): void {
  // Mirror `openFile`'s precondition: with no binding or no path there is no tab
  // to show, and floating an empty editor is worse than not floating at all.
  if (currentWorkspace() === undefined || fullPath === '') {
    openFile(fullPath, options)
    return
  }
  captureLiveBuffer()
  enterFloatSurface()
  openFile(fullPath, options)
}

/**
 * The floating variant of `openDiff` — the SCM change list's entry.
 *
 * Same handoff order as `openInFloatEditor`; a diff tab has no text buffer of
 * its own, but the file editor that WAS on screen still does.
 */
export function openDiffInFloatEditor(rel: string, staged: boolean, untracked = false): void {
  // `openDiff` refuses (with its own toast) without a repository or a path;
  // floating the editor onto a tab that will never open is worse than not
  // floating at all.
  if (currentWorkspace() === undefined || state.repoRoot === undefined || rel === '') {
    openDiff(rel, staged, untracked)
    return
  }
  captureLiveBuffer()
  enterFloatSurface()
  openDiff(rel, staged, untracked)
}

/**
 * Dock the editor back onto its base surface (centre conversation view or the
 * sidebar fallback), carrying the live buffer with it.
 */
export function dockFloatingEditor(): void {
  if (!state.floatOpen) return
  captureLiveBuffer()
  patch({ floatOpen: false })
  // The shell renders only the selected conversation view; a docked editor
  // behind another tab would look like the window simply vanished.
  revealEditor()
}

/**
 * 换一份「本会话改了什么」的标记。
 *
 * `activeHunk` 归零是刻意的：数据换了一份，上一份里"跳到第 3 处"的下标没有任何
 * 意义。0 表示"当前停在第 1 处"（打开这个文件的调用方本来就会把 caret 放到
 * `hunks[0]`），所以紧接着按"下一个"会走到第 2 处，不会把第 1 处跳过。
 */
export function applyChangeSet(tabId: string, set: ChangeSet | null): void {
  patchTab(tabId, { changeSet: set, activeHunk: 0, changeStale: false })
}

/**
 * 在改动点之间前后移动（到头绕回），返回目标行号（1-based）。
 *
 * `activeHunk` 是 `changeSet.hunks` 的 **0-based 下标**，`<0` / 缺省表示"这批数据
 * 里还没跳过"：第一次向后跳落在第 1 处、向前跳落在最后一处 —— 用户按下快捷键期
 * 待的是"带我去看改动"，而不是"从第 1 处跳到第 2 处、把第 1 处跳过"。
 *
 * 跳转目标顺手写进 tab（`revealHunkLine` + 递增的 `revealHunkNonce`），编辑器通过
 * props 收到后自己选中并滚动；调用方（面板按钮、键盘）只需要调这一个函数。这与
 * 面板里内联的那套步进算法是同一套下标语义，两边混用也不会错位。
 */
export function gotoChange(tabId: string, dir: 1 | -1): number | undefined {
  const tab = state.tabs.find(item => item.id === tabId)
  const hunks = tab?.changeSet?.hunks ?? []
  if (tab === undefined || hunks.length === 0) return undefined
  const current = tab.activeHunk ?? -1
  const next = current < 0 || current >= hunks.length
    ? (dir > 0 ? 0 : hunks.length - 1)
    : (current + dir + hunks.length) % hunks.length
  const line = hunks[next]
  if (line === undefined) return undefined
  patchTab(tabId, {
    activeHunk: next,
    revealHunkLine: line,
    revealHunkNonce: (tab.revealHunkNonce ?? 0) + 1,
  })
  return line
}

/**
 * 编辑器报告"文档已经和改动数据脱钩"（用户敲了字）。
 *
 * 只打标记、不做别的：标记本身已在编辑器内部被清空（见 `change-marks.ts`），
 * 重新拉数据是上层的事，仓库在这一层不发起任何请求。
 */
export function markChangeStale(tabId: string): void {
  const tab = state.tabs.find(item => item.id === tabId)
  if (tab === undefined || tab.changeStale === true) return
  patchTab(tabId, { changeStale: true })
}

/**
 * 撤销「本会话在某个文件里的一处改动」（改动行上那个悬浮按钮点下去的动作）。
 *
 * 语义是**把远端工作区里这一块反向应用回去**，不是编辑器 buffer 的 undo：真正的反向
 * 操作由 `applyHunk(..., 'revert')` 在主机上跑 `git apply -R` 完成，hunk 的上下文对
 * 不上时它自己会拒绝 —— 那正是冲突护栏。这里绝不自己算文本替换：浏览器一侧没有基线
 * 内容，重算出来的区间只会把别人的改动一起盖掉。
 *
 * 每一步的先后都不是随意的：
 * 1. 编辑器里有未保存内容时**直接拒绝**：用远端补丁盖掉用户还没保存的编辑是最糟的
 *    结果（既丢编辑，又让"撤销"变成"覆盖"）。
 * 2. 没有撤销坐标就什么也不做：改动列表没在屏幕上时，"哪台主机、哪个仓库"是未知数。
 * 3. 没有补丁（二进制文件、非文本 diff、`hunk` 下标对不上）同样什么也不做。
 * 4. 成功后才作废这批标记、再重读文件：标记描述的是"撤销前那一刻"的行号，撤销后它们
 *    全部失效；重读让标签页的数字回到磁盘上的事实。
 * 5. 失败时**不清标记、不重读**：远端一个字节都没动，屏幕上那份标记仍然是事实。
 */
/**
 * Re-read one file's change set from the host and hand it to the editor.
 *
 * The host reads the worktree for every `diff` call, so the marks this installs
 * describe the file as it is right now — which is what makes them survive a
 * revert (or any other external write) without the user re-opening the file.
 */
async function refreshChangeSet(tabId: string, context: UndoContext): Promise<void> {
  const tab = state.tabs.find(item => item.id === tabId)
  if (tab === undefined || tab.kind !== 'file') return
  try {
    const diff = await api.changes.diff(context.sessionId, tab.fullPath)
    if (diff === null || diff.kind !== 'text' || diff.hunks.length === 0) {
      applyChangeSet(tabId, null)
      return
    }
    applyChangeSet(tabId, changeSetFromHunks(diff.hunks, `${tab.fullPath}@${Date.now()}`))
  } catch {
    // A read that fails leaves no marks rather than wrong ones.
    applyChangeSet(tabId, null)
  }
}

export async function undoChange(tabId: string, mark: ChangeMark): Promise<void> {
  const tab = state.tabs.find(item => item.id === tabId)
  if (tab === undefined) {
    info(t('changes.undoMissing'))
    return
  }
  if (tab.dirty === true) {
    info(t('changes.undoDirty'))
    return
  }
  const context = undoContext()
  if (context === undefined) {
    info(t('changes.undoNoContext'))
    return
  }
  const patch = tab.changeSet?.patches?.[mark.hunk ?? -1]
  if (patch === undefined || patch.trim() === '') {
    info(t('changes.undoMissing'))
    return
  }
  try {
    // 'revert' = 远端 `git apply -R`；上下文不匹配它就抛错，这就是冲突护栏。
    await applyHunk(context.alias, context.root, patch, 'revert')
  } catch (error) {
    // 可把 git 的说法附在后面（"patch does not apply" 之类），但**不动**标记与文件。
    const detail = error instanceof Error ? error.message.trim() : String(error).trim()
    info(detail === '' ? t('changes.undoConflict') : `${t('changes.undoConflict')} · ${detail}`)
    return
  }
  // Refresh the marks instead of dropping them, and put the caret back where the
  // revert happened.
  //
  // Dropping them was the old behaviour and it broke the flow in three ways: the
  // editor's floating prev/next control disappeared until the file was clicked
  // again, the remount re-ran the "reveal line" the file was opened with (hunk
  // one, i.e. the top of the file) so the caret jumped away from the revert, and
  // the remaining changes lost their marks. The host re-reads the file for this
  // call, so the set describes the file as it is now.
  const anchor = mark.from
  await reloadTab(tabId)
  await refreshChangeSet(tabId, context)
  const after = state.tabs.find(item => item.id === tabId)
  patchTab(tabId, {
    // The line the tab was opened with no longer exists in this file's history;
    // left in place it would drag the caret to the top on the next remount.
    line: undefined,
    lineNonce: undefined,
    revealHunkLine: anchor,
    revealHunkNonce: (after?.revealHunkNonce ?? 0) + 1,
  })
  info(t('changes.undone'))
  // The host still holds the pre-revert comparison, so the panel would keep the
  // old counts (and re-opening the file would paint the OLD hunks against the
  // NEW buffer). Force a scan now: the list is the user's evidence that the
  // revert happened, and it must not lag the editor by a turn.
  void api.changes.list(context.sessionId, true).catch(() => undefined)
}

/** Mount-time hook: boot the store for a given ctx. */
export function useBootstrap(ctx: Context): void {
  useEffect(() => {
    bootstrap(ctx)
  }, [ctx])
}
