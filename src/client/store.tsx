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
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {
  DiffModel,
  GitStatusDetail,
  RemoteChangedFile,
  RemoteChangesTurnView,
  RemoteHostSummary,
  RemoteRoutingStatus,
  RemoteWorkspaceBinding,
  RemoteFileEntry,
} from '../protocol.ts'
import { api, RemoteApiError, configureTimeouts, fileReadTimeoutMs, gitTimeoutMs } from './api.ts'
import { DEFAULT_GIT_TIMEOUT_MS, clientDeadlineFor } from '../timeouts.ts'
import { normalizeRepoSubdir, repoSubdirOf, repoWorkdir } from '../git-ops.ts'
import { buildDiffModel } from './scm/diff-model.ts'
import type { ChangeMark, ChangeSet } from './vsc/change-marks.ts'
import { changeSetFromDiff, diffNoticeKey, noticeOfDiff, type DiffNotice } from './changes/diff-outcome.ts'
import { applyFailureText } from './changes/apply-failure.ts'
import { sessionDiffOutcome } from './changes/session-diff.ts'
import { tabsToMarkStale, turnMarksStale, type MarksTab } from './changes/staleness.ts'
import { hunkRevertClearsTurn, markTurnReverted } from './changes/turn-reverted.ts'
import { undoContext, type UndoContext } from './changes/undo-context.ts'
import { changeOriginForTab, forgetChangeOrigin, rememberChangeOrigin, resolveUndoTarget } from './changes/undo-target.ts'
import { applyStageOverrides, bucketStatus, buildTreeMarks, insertStagedEntry, optimisticStageDetail, type ChangeEntry, type StageOverride, type StatusBuckets, type TreeMarks } from './scm/status-map.ts'
import { loadCommitFileDiff, findRepos, loadDiff, loadHead, loadStatusDetail, probeRepoRoot, probeStatusDir, probeStatusPaths, applyHunk, stagePaths, unstagePaths, type DiffPayload } from './scm/actions.ts'
import { StageCoordinator } from './scm/stage-queue.ts'
import { collapseDir, dropExpandedRows, expandDir, pruneDirExpansions, type DirExpansions } from './scm/untracked-dirs.ts'
import { ReadQueue } from './scm/read-queue.ts'
import {
  gitCacheKey,
  parseGitCacheKey,
  patchCachedGitStatus,
  patchCachedUntrackedDirs,
  readGitSnapshot,
  retainGitSnapshots,
  writeGitSnapshot,
  type GitSnapshot,
} from './scm/git-cache.ts'
import { detectLang, makeT, type Lang } from './i18n.ts'
import { effectiveEditorSurface, type EditorSurface } from './float-editor.ts'
import { captureLiveEditorPosition, captureLiveEditorText, isLiveEditorDirty, isLiveEditorFor, markLiveEditorSaved } from './live-editor.ts'
import { editorSeatCount } from './editor-capability.ts'
import { planWorkspaceFollow, selectionIsSessionBinding, type WorkspaceFollowDecision } from './remote-file-open-target.ts'
import { revealViewTab } from './reveal.ts'
import { applyConnectionStatuses, connectionStateOf, isConnectionFailure, markConnectionProbeOk } from './connection.ts'
import { isRequestAbort } from './request-gate.ts'
import { confirmDialog, isImageFile, toast } from './vsc/kit.tsx'
import { hasTextSource, isBytePreview, previewKindOf } from './vsc/preview-model.ts'
import {
  isWithinRoot,
  normalizeRemotePath,
  parentDirectoryOf,
  resolutionCandidates,
} from './vsc/terminal-links.ts'

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
  /**
   * The remote VERSION this buffer was loaded from / last saved to.
   *
   * Sent back on save as an optimistic lock: the Host refuses the write when the
   * remote file has a different mtime (or size), because that means a person or
   * an agent wrote it after this buffer was read and saving would destroy their
   * work with a cheerful "saved". Kept here rather than in the editor because it
   * must survive a surface handoff and a tab switch.
   *
   * `undefined` means NO baseline (a file created by this session, or a write
   * whose post-save stat failed): the save then goes through unguarded, exactly
   * as before this feature — the guard protects a known history, it must never
   * invent one.
   */
  remoteMtime?: number
  /** Size that belonged to `remoteMtime` (the second half of the same baseline). */
  remoteSize?: number
  /**
   * Set when a save was REFUSED because the remote file moved on, carrying what
   * is there now. The pane turns this into an offer — overwrite / reload / see
   * the difference — instead of a red toast the user cannot act on.
   */
  conflict?: { mtime: number | null; size: number | null }
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
  /**
   * 重命名差异的旧路径（commit diff 专用）。
   *
   * `openCommitFile` 的首次加载把它一起交给 `loadCommitFileDiff`（两个路径一起
   * `git show -M` 才能把 rename 配对），但 `reloadTab` 是另一个调用点：不存进 tab，
   * 重载（工具栏 ⟳ / 断线恢复的批量 reload）就只会拿新路径去问 git，rename 立刻
   * 退化成「整篇新增」。
   */
  origPath?: string
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
  /**
   * 这批改动标记的建立时刻（`Date.now()`，`applyChangeSet` 写入）。
   *
   * 面板的轮询用它和 `RemoteChangesSummary.at` 比先后：标记比列表新时（保存/撤销
   * 刚重读过），那份更早的列表不能证明标记过期（见 `changes/staleness.ts`）。
   */
  changeSetAt?: number
  /** 改动点跳转目标行（1-based）。与 `line` 分开，两条跳转链路互不干扰。 */
  revealHunkLine?: number
  /** 改动点跳转的 nonce，语义同 `lineNonce`。 */
  revealHunkNonce?: number
  /**
   * 「会话改动」面板那一行的只读 diff（不是 git 工作区 diff）。
   *
   * 有它 = 这一页是账本轮次的比较：两栏都只读（改前是还原出来的基线、改后是远端
   * 当前内容），没有 hunk 暂存/撤销，重新载入走账本而不是 `git diff`。`reloadTab`
   * 与 `saveTargetOf` 都按它分流。
   */
  sessionDiff?: {
    sessionId: string
    alias: string
    /** 会话账本的仓库根（`git apply -R` 的目标目录，也是仓库目录的答案）。 */
    root: string
    /** 面板显示路径（标签条与 diff 头用它，不参与任何写操作）。 */
    display: string
  }
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
  /**
   * True while the git slice on screen is a CACHED read of this workspace whose
   * background refresh has not landed yet (see `scm/git-cache.ts`).
   *
   * It is what lets the panel say so: a monorepo re-read can take minutes, and
   * a change list that old must not be mistaken for a fresh one. Cleared the
   * moment a real read paints, or when the workspace was read moments ago and
   * the refresh was skipped as redundant.
   */
  gitCached: boolean
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
  /** A pending "select this commit in the history rail" request. */
  commitFocus: CommitFocusRequest | undefined
  /**
   * Expanded untracked DIRECTORY rows (`-u normal` collapses a directory into
   * one row, so the panel asks for its contents on demand — see
   * `scm/untracked-dirs.ts`). Kept in the store, not in the panel: it has to
   * outlive every status the panel adopts, and only the store sees those.
   */
  untrackedDirs: DirExpansions
}

/** The sidebar rail destinations. */
export type RailView = 'explorer' | 'search' | 'scm' | 'history' | 'editor' | 'terminal' | 'ports' | 'monitor' | 'workspaces'

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

/** One "show this commit in the history rail" request. */
export interface CommitFocusRequest {
  /** Monotonic id so selecting the same commit twice still re-triggers. */
  id: number
  hash: string
}

const WS_KEY = 'dsh-remote-vs.files.ws'
const VIEW_KEY = 'dsh-remote-vs.view'
/** Per-workspace repository sub-directory, keyed by workspace id. */
const REPO_SUBDIR_KEY = 'dsh-remote-vs.repo.subdir'
/**
 * Per-workspace open file tabs, so a page reload does not lose the workbench.
 *
 * PATHS ONLY. The remote source itself never reaches browser storage — the
 * README promises exactly that ("no cross-refresh content cache"), and a
 * "restore the tabs" feature is the most tempting place to break it: keeping
 * `text` here would put remote files on disk and would be one more copy to keep
 * fresh. Paths are enough to reopen them, and a stale path fails harmlessly
 * (the file open reports it and the tab is dropped).
 */
const TABS_KEY = 'dsh-remote-vs.tabs'
/**
 * How many tabs one reload reopens.
 *
 * Each restored tab costs one remote read, and a page reload happens on every
 * plugin upgrade / `dsh web` restart — a workbench with thirty open files must
 * not turn that into thirty concurrent reads against six channel slots.
 */
const TAB_RESTORE_LIMIT = 12
/** Parallel reads while restoring (deliberately below the 6-channel budget). */
const TAB_RESTORE_CONCURRENCY = 2

/** One workspace's persisted workbench. */
interface StoredTabSet {
  /** Absolute remote paths, in strip order. */
  paths: string[]
  /** The path of the active tab, when there was one. */
  active?: string
}

/** Every workspace's persisted workbench, keyed by binding id. */
type StoredTabs = Record<string, StoredTabSet>

/**
 * Read the stored tab sets.
 *
 * Strict on shape and lenient on junk: a half-written or hand-edited entry must
 * degrade to "nothing to restore" instead of throwing on page load (module-level
 * state that throws here would take the whole panel down before it renders).
 */
function readStoredTabs(): StoredTabs {
  try {
    const raw = localStorage.getItem(TABS_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: StoredTabs = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue
      const entry = value as { paths?: unknown; active?: unknown }
      if (!Array.isArray(entry.paths)) continue
      const paths = entry.paths.filter((item): item is string => typeof item === 'string' && item !== '')
      if (paths.length === 0) continue
      out[key] = typeof entry.active === 'string' ? { paths, active: entry.active } : { paths }
    }
    return out
  } catch {
    return {}
  }
}

/** The signature of what got persisted last, so publishes do not rewrite it. */
let persistedTabsSignature = ''
/** The restore happens at most once per page load. */
let tabsRestored = false
/**
 * Persistence is armed only once the restore has finished (or decided there was
 * nothing to restore).
 *
 * Before that, the strip is legitimately EMPTY: the bootstrap publishes
 * (hosts/workspaces/git) run before any tab is reopened, and writing that empty
 * set would delete the very list the restore is about to read. The guard is
 * about that one window, not about "never store an empty workbench" — closing
 * every tab afterwards DOES remove the entry, which is what keeps a deleted tab
 * from coming back on the next reload.
 */
let tabsPersistReady = false

/**
 * Persist the current file tabs for the current workspace.
 *
 * Called from every publish (a tab opened / closed / switched re-renders the
 * strip, and that is exactly when the persisted set changes). The signature
 * keeps a keystroke-driven publish from touching localStorage, whose writes are
 * synchronous and would otherwise land on the typing path.
 *
 * Only FILE tabs are stored: a diff / commit tab is a view of git state that is
 * cheap to reopen from the SCM panel, and restoring one without its repository
 * context would open a tab that cannot load.
 */
function persistTabsIfChanged(): void {
  const workspace = currentWorkspace()
  if (workspace === undefined) return
  const paths = state.tabs.filter(tab => tab.kind === 'file').map(tab => tab.fullPath)
  const activeTab = state.tabs.find(tab => tab.id === state.activeTabId)
  const active = activeTab?.kind === 'file' ? activeTab.fullPath : undefined
  const signature = `${workspace.id}\u0000${active ?? ''}\u0000${paths.join('\u0000')}`
  if (signature === persistedTabsSignature) return
  // See `tabsPersistReady`: an empty strip before the restore has run is the
  // bootstrap's transient state, not a user closing their last tab.
  if (!tabsPersistReady && paths.length === 0) return
  persistedTabsSignature = signature
  try {
    const all = readStoredTabs()
    if (paths.length === 0) delete all[workspace.id]
    else all[workspace.id] = active === undefined ? { paths } : { paths, active }
    localStorage.setItem(TABS_KEY, JSON.stringify(all))
  } catch {
    // Private mode / quota: the workbench simply does not come back.
  }
}

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
      || saved === 'editor' || saved === 'terminal' || saved === 'ports' || saved === 'monitor' || saved === 'workspaces') {
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
  // Pre-bootstrap placeholder: same default as the plugin config (nforce).
  routing: { mode: 'enforce', aliasPaths: {}, tombstones: [] },
  workspaceId: readWorkspaceId(),
  status: undefined,
  head: undefined,
  repoRoot: undefined,
  repoSubdir: '',
  repoMissing: false,
  gitBusy: false,
  gitError: undefined,
  gitCached: false,
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
  commitFocus: undefined,
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
  /** The painted git slice is a cached one; a background refresh is running. */
  gitCached: boolean
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
  /** Pending "select this commit in the history rail" request. */
  commitFocus: CommitFocusRequest | undefined
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
  /** Open the history rail with this commit selected (blame / file history). */
  focusCommit: (hash: string) => void
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
  /**
   * Re-read git for the binding on screen.
   *
   * `join` shares a read that is already in flight — the right contract for an
   * automatic refresh, since a second walk of the same repository answers
   * exactly the same question. `fresh` (the default) waits for a running read
   * and then reads again: the answer must include whatever the caller just
   * wrote.
   */
  refreshGit: (mode?: 'join' | 'fresh') => Promise<void>
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
  /** 把当前编辑器整体浮出（双击会话视图的「远程编辑器」标签）。 */
  openFloatingEditor: () => void
  /** 停靠回主界面（底层的中心视图或侧栏表面）。 */
  dockFloatingEditor: () => void
  /**
   * Show the SAME editor in the conversation-view tab (full width).
   *
   * The docked sidebar pane is the default seat; the centre tab is an optional
   * second seat for the same buffer. Flipping the surface unmounts one mount and
   * mounts the other, so the live buffer is captured first (see
   * `captureLiveBuffer`).
   */
  openEditorInCenter: () => void
  /** Dock the editor back into the sidebar (the reverse of `openEditorInCenter`). */
  dockEditorSidebar: () => void
  openDiff: (rel: string, staged: boolean, untracked?: boolean) => void
  openCommitFile: (hash: string, rel: string, origPath?: string) => void
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
   * 撤销本会话对某个文件的**全部**改动（改动面板那一行的动作）。
   *
   * @returns 远端是否真的写了（`false` = 被某道门拒了，文件未变）。
   */
  revertFileChanges: (target: RevertFileTarget) => Promise<boolean>
  /**
   * Write one file tab back to the remote host.
   * @returns true only when the write really succeeded — the caller uses it to
   *   advance the editor's dirty baseline (see `CodeEditorHandle.markSaved`).
   */
  saveTab: (id: string, content: string, options?: { force?: boolean }) => Promise<boolean>
  /**
   * Forget the pending save-conflict banner for one tab (the user dismissed it).
   *
   * The buffer and the dirty flag are untouched: dismissing only hides the
   * offer, it never decides anything on the user's behalf.
   */
  dismissConflict: (id: string) => void
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
    gitCached: state.gitCached,
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
    commitFocus: state.commitFocus,
    setView,
    requestSearch,
    revealInExplorer,
    openTerminalAt,
    focusCommit,
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
    openFloatingEditor,
    dockFloatingEditor,
    openEditorInCenter,
    dockEditorSidebar,
    openDiff,
    openCommitFile,
    activateTab,
    closeTab,
    updateTab,
    applyChangeSet,
    gotoChange,
    markChangeStale,
    undoChange,
    revertFileChanges,
    saveTab,
    dismissConflict,
    reloadTab,
    info,
    fail,
  }
}

function publish(): void {
  snapshot = build()
  // Every mutation ends here, and a tab opened / closed / activated is such a
  // mutation — so this is the one place the stored workbench cannot fall behind
  // (an explicit call at each of the dozen tab sites would eventually miss one).
  persistTabsIfChanged()
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

/**
 * The store's subscription, extracted so `useExplorerSelector` passes React a
 * STABLE function: a fresh arrow per render makes `useSyncExternalStore`
 * unsubscribe/resubscribe on every paint.
 */
function subscribeStore(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Shallow equality for selector results — one level deep, `Object.is` per field.
 *
 * Selectors naturally build a fresh `{ repoRoot, head, … }` object out of the
 * snapshot, and a plain `Object.is` would then see a new reference on every
 * publish and repaint the panel anyway (defeating the whole point). Passing this
 * as `equal` compares the FIELDS, so "the snapshot was rebuilt but none of the
 * fields I read changed" answers `true` and the previous value (and render) is
 * kept. Arrays are compared as objects, i.e. by index.
 *
 * Shallow is deliberate: every selected field is either a primitive or a
 * REFERENCE the store already owns (`status`, `buckets`, `tabs`, `untrackedDirs`
 * …). Comparing those by reference is a real value check — the store only
 * replaces them when they actually change.
 */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  for (const key of keys) {
    // `hasOwnProperty` first: `Object.is(undefined, undefined)` must still pass
    // only for a field that EXISTS on both sides (a shorter object is a change).
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false
    if (!Object.is(left[key], right[key])) return false
  }
  return true
}

/**
 * Subscribe to ONE slice of the explorer store.
 *
 * Why this exists: `useExplorer()` hands out the whole `ExplorerValue`, and
 * every `publish()` builds a NEW snapshot object — so every subscriber repaints
 * on every mutation, including mutations its panel does not read (a save bumps
 * the tab array, a git refresh replaces `status`, a rail switch changes `view`).
 * With the panels kept MOUNTED, one publish therefore repainted every panel,
 * and the SCM panel's change list (up to 4000 rows) was rebuilt for a change in
 * an unrelated field.
 *
 * This hook re-renders its component ONLY when the selected value changes:
 *  - `publish()` still notifies every listener (that is how the store stays a
 *    single source of truth), but React asks this hook for a fresh value and
 *    `Object.is`-compares it with the last rendered one; equal means no render;
 *  - the selector runs at most once per (snapshot, selector) pair, and its
 *    result is kept in a per-hook cache, so an equal result keeps the PREVIOUS
 *    reference (downstream `useMemo`s keyed on it stay valid).
 *
 * Constraints, all from `useSyncExternalStore`:
 *  - the value returned for an UNCHANGED snapshot must be stable. This hook
 *    guarantees it (cache keyed on the snapshot identity), which is also why a
 *    selector may safely return a fresh object — with `shallowEqual` it is
 *    compared and the old reference is kept, and without `equal` it is cached
 *    and only recomputed when the snapshot itself changes;
 *  - `selector` must be PURE and should read only the snapshot. It may be an
 *    inline arrow (the hook tracks its identity, so a selector that closes over
 *    props is recomputed when it changes), but a module-level selector is
 *    cheaper: its identity is stable, so between publishes the cache answers
 *    without running it at all;
 *  - `selector` must not mutate the snapshot.
 *
 * @param selector - pure read of the fields this component needs.
 * @param equal - comparison used to decide whether the new selection is the
 *   same value; defaults to `Object.is`. Pass `shallowEqual` for object slices.
 */
export function useExplorerSelector<T>(
  selector: (snapshot: ExplorerValue) => T,
  equal: (a: T, b: T) => boolean = Object.is,
): T {
  /**
   * Last (snapshot, selector) → value. A `useRef`, not module state: two
   * components selecting different fields must not evict each other.
   */
  const cache = useRef<{ source: ExplorerValue; selector: (snapshot: ExplorerValue) => T; value: T } | undefined>(undefined)
  /**
   * Latest selector/equal, kept in refs so `getSelection` can stay stable
   * (one `useCallback([])`) while still calling the CURRENT functions. A
   * selector that closes over props changes identity every render; comparing it
   * with the cached one is what makes such a selector recompute (and see the new
   * props) instead of returning the previous, now stale, value.
   */
  const selectorRef = useRef(selector)
  selectorRef.current = selector
  const equalRef = useRef(equal)
  equalRef.current = equal
  const getSelection = useCallback((): T => {
    const source = snapshot
    const current = cache.current
    if (current !== undefined && current.source === source && current.selector === selectorRef.current) {
      // Same snapshot, same selector: the cached value is the answer. This is
      // what `useSyncExternalStore` requires (a changing value here would loop),
      // and what keeps two consecutive reads of one snapshot identical.
      return current.value
    }
    const next = selectorRef.current(source)
    if (current !== undefined && equalRef.current(current.value, next)) {
      // The snapshot moved but this slice did not: keep the OLD reference so
      // React sees no change (no render) and downstream memo keys stay stable.
      cache.current = { source, selector: selectorRef.current, value: current.value }
      return current.value
    }
    cache.current = { source, selector: selectorRef.current, value: next }
    return next
  }, [])
  return useSyncExternalStore(subscribeStore, getSelection)
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
 * Git reads, one walk at a time per (workspace, repository directory).
 *
 * Two reads can be wanted at once — the background refresh of the binding on
 * screen and a ⟳ / post-write read — and on a large repository a second walk of
 * the same tree is minutes of duplicate work whose answers disagree about which
 * one is current. The queue gives callers two contracts instead of that race
 * (`scm/read-queue.ts`): `join` shares a read already in flight (automatic
 * refreshes, workspace switches), `fresh` waits for it and reads again (⟳, and
 * every write, whose answer must include the write).
 */
const gitReads = new ReadQueue(refreshGitBusy)

/**
 * Which read may repaint the visible slice, per binding.
 *
 * The repo picker can ask for a DIFFERENT directory of the same workspace while
 * a read of another one is still walking; the older answer describes the
 * directory the user just left and must not land on top of the newer request.
 * Cache writes are deliberately not gated: they belong to the directory the read
 * was about, and are what makes the next visit instant.
 */
const latestGitRead = new Map<string, number>()
let gitReadTicket = 0

/**
 * Cancellation handle for the git read in flight per binding.
 *
 * A workspace switch must take the OLD workspace's repository walk out of the
 * browser's connection pool. The browser gives one origin six connections and
 * the walk (probe + status + branch header) is the largest thing the plugin
 * sends; measured on the reported P710/Z700 trees, the walk took 8–9 s and a
 * purely in-memory `/status` route took 2.7–4.6 s during it — that is queueing,
 * not a slow host. Aborting the HTTP request frees the connection immediately;
 * the answer of an aborted read is dropped on purpose (a newer read of that
 * binding, or of the workspace now on screen, is the one that matters).
 *
 * One controller per binding, so a repo-picker move (same binding, another
 * directory) also retires the read it supersedes.
 */
const gitReadAborts = new Map<string, AbortController>()

/** True when `bindingId`'s read `ticket` may paint the on-screen slice. */
function gitReadIsCurrent(bindingId: string, ticket: number): boolean {
  return latestGitRead.get(bindingId) === ticket && activeBinding().key === bindingId
}

/** The cache key of what the panel is showing (workspace + repository directory). */
function currentGitKey(): string {
  return gitCacheKey(activeBinding().key, state.repoSubdir)
}

/** Recompute the busy flag from the queue (called on every start/settle). */
function refreshGitBusy(): void {
  const bindingId = activeBinding().key
  const busy = gitReads.inflightKeys().some(key => parseGitCacheKey(key)?.bindingId === bindingId)
  if (state.gitBusy !== busy) patch({ gitBusy: busy })
}

/**
 * A cached read this young is what a refresh would answer anyway.
 *
 * Flipping between two workspaces must not start a monorepo-wide walk on every
 * hop: within this window the cached slice is treated as current. Every explicit
 * refresh (⟳, a write) and every switch to an OLDER snapshot still re-reads.
 */
const CACHED_FRESH_MS = 5_000

/**
 * The state fields one cached read stands for — the switch's synchronous paint.
 *
 * A MISS clears the slice exactly like the old code did: the workspace has never
 * been read, so there is nothing honest to show and the read about to start owns
 * the "Loading…" state. `repoSubdir` keeps the persisted choice so that read
 * runs in the directory the user last used.
 *
 * `refreshing` says whether a background read was actually started; when it is
 * false the slice is merely a few seconds old and is presented as current — a
 * "cached" badge with nothing refreshing would be noise, not information.
 */
function cachedGitSlice(bindingId: string, refreshing: boolean): Partial<State> {
  const subdir = readRepoSubdir(bindingId)
  const snapshot = readGitSnapshot(gitCacheKey(bindingId, subdir))
  if (snapshot === undefined) {
    return {
      status: undefined,
      head: undefined,
      repoRoot: undefined,
      repoSubdir: subdir,
      repoMissing: false,
      untrackedDirs: new Map(),
      gitError: undefined,
      gitCached: false,
    }
  }
  return {
    status: snapshot.status,
    head: snapshot.head,
    repoRoot: snapshot.repoRoot,
    repoSubdir: snapshot.repoSubdir,
    repoMissing: snapshot.repoMissing,
    untrackedDirs: snapshot.untrackedDirs,
    gitError: undefined,
    gitCached: refreshing,
  }
}

/** Paint the cached slice of `bindingId` (a selection moved there). */
function adoptCachedGit(bindingId: string): void {
  patch(cachedGitSlice(bindingId, true))
}

/** Mirror the expansion set into the cached snapshot of the binding on screen. */
function mirrorUntrackedDirs(): void {
  const { workspace, key } = activeBinding()
  if (workspace === undefined) return
  patchCachedUntrackedDirs(gitCacheKey(key, state.repoSubdir), state.repoRoot, state.untrackedDirs)
}

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
      // A snapshot of a workspace the table no longer holds must never be
      // handed to another one: its change list names paths of a foreign tree.
      const bindingIds = new Set(payload.workspaces.map(item => item.id))
      retainGitSnapshots(bindingIds)
      for (const id of [...latestGitRead.keys()]) {
        if (!bindingIds.has(id)) latestGitRead.delete(id)
      }
      // The selection can resolve ELSEWHERE after the table changed (a deleted
      // workspace falls back to the first entry). That is a switch like any
      // other, and its cached slice is what keeps the panel from "Loading…".
      const resolved = activeBinding().key
      if (resolved !== key) adoptCachedGit(resolved)
      // Bring the previous page's workbench back AFTER the workspace table is
      // known: the stored sets are keyed by binding id, and a tab can only be
      // reopened against the workspace that owns it.
      restoreStoredTabs()
      void refreshGit('join')
    },
    (error: unknown) => {
      patch({ ready: true, error: error instanceof RemoteApiError ? error.message : String(error) })
    },
  )
}

/** `file:` tab id for one path on one host (the one place that shape is built). */
function tabIdOf(alias: string, fullPath: string): string {
  return `file:${alias}:${fullPath}`
}

/**
 * Open one stored path and wait until the read settles.
 *
 * `openFile` is fire-and-forget by design (every caller is a click), but a
 * restore has to know whether it worked — that is what separates "restored 5"
 * from "3 files are gone" — and it must not put a dozen reads in flight at
 * once. Waiting for the tab to leave `loading` is the only signal available
 * without changing that public contract.
 *
 * THREE outcomes, and the distinction is the point: a slow read (a thin link, a
 * huge file, a cold cache) is NOT a missing file. Treating a short wait as
 * failure closed the tab and dropped its path from storage, so "slow" turned
 * into "gone" — the exact "encode the uncertain as a negative" failure this
 * project keeps paying for. Only a tab that finished WITH an error is missing;
 * one that is still loading when the wait ends is unknown and left untouched,
 * so the next reload tries again.
 */
type StoredTabOutcome = 'restored' | 'missing' | 'unknown'

/** How long to watch one restoring read before calling its outcome unknown. */
const TAB_RESTORE_WAIT_MS = 150_000
/** Poll interval while watching a restoring read. */
const TAB_RESTORE_POLL_MS = 50

async function openStoredTab(alias: string, fullPath: string): Promise<StoredTabOutcome> {
  openFile(fullPath)
  const id = tabIdOf(alias, fullPath)
  const attempts = Math.ceil(TAB_RESTORE_WAIT_MS / TAB_RESTORE_POLL_MS)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const tab = state.tabs.find(item => item.id === id)
    if (tab === undefined) return 'missing'
    if (!tab.loading) return tab.error === undefined ? 'restored' : 'missing'
    await new Promise(resolve => setTimeout(resolve, TAB_RESTORE_POLL_MS))
  }
  // Still loading: the read owns its own deadline, so this is "could not tell
  // within a generous window", not "does not exist".
  return 'unknown'
}

/** Reopen `paths` two at a time, reporting what came back and dropping only the misses. */
async function reopenTabs(
  alias: string,
  paths: readonly string[],
): Promise<{ restored: number; missing: number; unknown: number }> {
  const queue = [...paths]
  let restored = 0
  let missing = 0
  let unknown = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const next = queue.shift()
      if (next === undefined) return
      const outcome = await openStoredTab(alias, next)
      if (outcome === 'restored') {
        restored += 1
        continue
      }
      if (outcome === 'unknown') {
        // Leave both the tab and the stored path alone: it may still be loading,
        // and closing it would turn a slow read into "this file is gone".
        unknown += 1
        continue
      }
      missing += 1
      // Close the tab this restore created. The user did not open it this time,
      // so leaving a red error tab in the strip is noise they never asked for;
      // the toast counts it instead. (`closeTab` on an absent id is a no-op.)
      closeTab(tabIdOf(alias, next))
    }
  }
  await Promise.all(Array.from({ length: TAB_RESTORE_CONCURRENCY }, () => worker()))
  return { restored, missing, unknown }
}

/**
 * Reopen the file tabs this browser had for the current workspace.
 *
 * Runs once per page load, for the CURRENT workspace only: switching workspaces
 * keeps its existing contract (the strip is cleared and the user is told so
 * first), and re-running this on every `refreshAll` would fight that clear
 * rather than complement it.
 *
 * A tab that no longer loads (deleted, renamed, no permission) is dropped and
 * COUNTED — silently restoring "6 of 9" would leave the user looking for three
 * tabs they think they had.
 *
 * Only PATHS are restored. Caret and scroll position are not persisted: the
 * README's privacy stance is "paths only, never content", and a caret stored
 * weeks ago would point into a file that has since changed.
 */
export function restoreStoredTabs(): void {
  if (tabsRestored) return
  tabsRestored = true
  const workspace = currentWorkspace()
  const stored = workspace === undefined ? undefined : readStoredTabs()[workspace.id]
  if (workspace === undefined || stored === undefined || stored.paths.length === 0) {
    // Nothing to reopen: arm persistence now, or the first real tab would be
    // stored but a later "close all" could never remove it.
    tabsPersistReady = true
    return
  }
  const paths = stored.paths.slice(0, TAB_RESTORE_LIMIT)
  const activePath = stored.active
  void (async () => {
    try {
      const { restored, missing, unknown } = await reopenTabs(workspace.alias, paths)
      if (activePath !== undefined) {
        const id = tabIdOf(workspace.alias, activePath)
        if (state.tabs.some(tab => tab.id === id)) patch({ activeTabId: id })
      }
      if (restored > 0) toast(t('editor.tabsRestored').replace('{count}', String(restored)), false)
      if (missing > 0) toast(t('editor.tabsRestoreMissing').replace('{count}', String(missing)), true)
      // Slow is not missing: say so, and keep the tab for the next reload.
      if (unknown > 0) toast(t('editor.tabsRestoreUnknown').replace('{count}', String(unknown)), false)
    } finally {
      // From here on the strip is the user's, not the bootstrap's: an empty one
      // means they closed everything.
      tabsPersistReady = true
    }
  })()
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

/** Outcome of one terminal path click (see `jumpToTerminalPath`). */
export type TerminalPathJump = 'revealed' | 'missing' | 'outside' | 'blocked'

/**
 * Jump from a path printed in the TERMINAL to that folder in the directory tree
 * (Ctrl+Click in the terminal; the wiring lives in `XTerm`/`TerminalView`).
 *
 * The token is only text, so the absolute path is decided by a short candidate
 * chain (`vsc/terminal-links.ts`) and then CONFIRMED against the host: the first
 * candidate that exists wins, and its directory (the path itself for a folder,
 * its parent for a file) is revealed in the tree. A hit outside every binding on
 * that host is reported instead of silently jumping somewhere unrelated — the
 * tree can only show what a binding covers.
 *
 * @param alias - host the terminal TAB is connected to (not the panel's host
 *   picker: a tab can outlive a picker change).
 * @param token - the path as printed in the terminal.
 * @param hints - shell cwd (OSC 7) and remote home, for relative/`~` tokens.
 */
export async function jumpToTerminalPath(
  alias: string,
  token: string,
  hints: { home?: string; cwd?: string } = {},
): Promise<TerminalPathJump> {
  if (alias === '' || token === '') return 'missing'
  const bindings = state.workspaces.filter(item => item.alias === alias)
  const roots = bindings
    .map(item => item.remotePath)
    .sort((left, right) => right.length - left.length)
  const candidates = resolutionCandidates(token, {
    ...(hints.home === undefined ? {} : { home: hints.home }),
    ...(hints.cwd === undefined ? {} : { cwd: hints.cwd }),
    roots,
  })
  if (candidates.length === 0) {
    toast(t('term.pathOutside'), true)
    return 'outside'
  }
  for (const candidate of candidates) {
    let entry: RemoteFileEntry
    try {
      // Bounded: a dead link must not leave the click hanging with no answer.
      entry = await withDeadline(
        api.fileOp.stat(alias, candidate),
        clientDeadlineFor(fileReadTimeoutMs()),
        t('editor.readTimeout'),
      )
    } catch {
      // Not this candidate (or the link hiccuped): try the next one.
      continue
    }
    const dir = entry.isDir ? normalizeRemotePath(candidate) : parentDirectoryOf(candidate)
    const binding = bindings.find(item => isWithinRoot(dir, item.remotePath))
    if (binding === undefined) {
      // The path exists but no workspace covers it: the tree has nowhere to show
      // it, and moving the panel somewhere unrelated would be a lie.
      toast(t('term.pathOutside'), true)
      return 'outside'
    }
    if (state.workspaceId !== binding.id && !selectWorkspaceAuto(binding.id)) {
      toast(t('term.pathBlocked'), true)
      return 'blocked'
    }
    revealInExplorer(dir)
    return 'revealed'
  }
  toast(t('term.pathMissing'), true)
  return 'missing'
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

/** Monotonic ticket for "show this commit" requests from the editor. */
let commitFocusSeq = 0

/**
 * Open the history rail and select one commit.
 *
 * Blame cells and the file-history menu only know a hash; the history panel owns
 * the list and the detail pane, so the selection travels as a request (the same
 * pattern as `revealInExplorer` / `openTerminalAt`).
 */
export function focusCommit(hash: string): void {
  if (hash === '' || /^0+$/.test(hash)) return
  commitFocusSeq += 1
  patch({ commitFocus: { id: commitFocusSeq, hash } })
  setView('history')
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
  if (state.workspaceId === id) return
  /**
   * A workspace switch closes EVERY tab (`applyWorkspaceSelection` replaces the
   * list), so unsaved buffers must be confirmed first — the same rule the single
   * tab close already follows (`EditorPane.closeWithGuard`). Without this the
   * edits vanished with no prompt, from this plugin's own workspace dropdown.
   *
   * The CLEAN path stays fully synchronous on purpose: a switch that was read
   * before repaints its whole change list in the same frame (see the hydration
   * comment in `applyWorkspaceSelection`, and `check-git-cache` asserts it).
   * Only the dirty path awaits the dialog.
   */
  const dirty = state.tabs.filter(tab => tab.dirty)
  if (dirty.length === 0) {
    applyWorkspaceSelection(id, true)
    return
  }
  void (async () => {
    if (!(await confirmDiscardOnWorkspaceSwitch(dirty))) return
    applyWorkspaceSelection(id, true)
  })()
}

/**
 * Switch workspace on the PLUGIN's own initiative (session follow, opening a
 * file that belongs to another binding), claiming nothing.
 *
 * Two callers: opening a file that belongs to another binding (the change
 * panel, the click interceptor) and the follow itself. Neither is a statement
 * about where the user wants to browse — clicking a changed file is "show me
 * this result", not "I moved my workspace" — so a pending follow stays free to
 * put the selection back on the session's binding afterwards.
 *
 * Never discards unsaved edits: when any tab is dirty the switch is skipped and
 * the selection stays where the user left it (they can still switch by hand,
 * which goes through `selectWorkspace` and its confirmation).
 *
 * @returns whether the selection really is `id` afterwards. The auto callers
 *   MUST check it: skipping the switch is not a no-op for them — a caller that
 *   goes on to open a file would read that file with the OLD workspace's alias
 *   (another host, or another file at the same path). See
 *   `openRemoteFileInBinding`.
 */
function selectWorkspaceAuto(id: string): boolean {
  if (state.workspaceId === id) return true
  if (state.tabs.some(tab => tab.dirty)) return false
  applyWorkspaceSelection(id, false)
  return true
}

/** Ask once before a workspace switch closes dirty editor tabs. */
let switchGuardBusy = false
/** Generation of the run that currently owns `switchGuardBusy` (see `finish`). */
let switchGuardToken = 0
/**
 * How long a dirty workspace switch waits for its confirmation.
 *
 * The guard is a module-level flag, so an answer that never arrives must not
 * hold it forever: the modal slot can be replaced, and the host can unmount the
 * dialog host while the question is up. Without a deadline the flag would stay
 * `true` for the rest of the session and every later dirty switch would do
 * nothing at all, with no message (only a reload recovers). Generous on
 * purpose — it exists for the pathological case, not to rush the user.
 */
const SWITCH_GUARD_TIMEOUT_MS = 60_000

/**
 * Ask before a workspace switch closes dirty editor tabs.
 *
 * @returns true only when the user answered "discard and switch"; a dismiss, a
 *   second pending switch and a TIMEOUT all answer false — the timeout also
 *   releases the guard and says so, so the failure is never silent.
 */
function confirmDiscardOnWorkspaceSwitch(dirty: readonly EditorTab[]): Promise<boolean> {
  if (switchGuardBusy) return Promise.resolve(false)
  switchGuardBusy = true
  const token = ++switchGuardToken
  return new Promise<boolean>((resolve) => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (answer: boolean, timedOut = false): void => {
      // A late answer from a dialog that already timed out must neither resolve
      // this promise a second time nor unlock a NEWER guard run.
      if (done) return
      done = true
      if (timer !== undefined) clearTimeout(timer)
      if (switchGuardToken === token) switchGuardBusy = false
      resolve(answer)
      if (timedOut) toast(t('editor.switchTimeout'), true)
    }
    timer = setTimeout(() => finish(false, true), SWITCH_GUARD_TIMEOUT_MS)
    timer.unref?.()
    void confirmDialog({
      title: t('editor.switchDirty'),
      text: dirty.map(tab => tab.rel).join('、'),
      danger: true,
      okText: t('editor.discardSwitch'),
    }).then(answer => finish(answer), () => finish(false))
  })
}

/**
 * The in-flight switch probe, so a newer switch cancels an older dial.
 *
 * A test dial is a real SSH connection attempt: against a host that is down it
 * runs for the connection timeout (tens of seconds), and it is a FOREGROUND
 * request (the tree is waiting on its answer), so it would hold the background
 * git channel shut behind it. Switching again makes that dial pointless, hence
 * the abort.
 */
let switchProbe: { alias: string; controller: AbortController } | undefined

/**
 * Re-prove one alias' link when the user selects a workspace on it.
 *
 * The connection chip polls (and an explicit retry is exactly this pair of
 * calls), but the tree gates on the same evidence: `loadDir`/`prefetchDir`
 * refuse an alias known down. A switch made inside the poll interval therefore
 * used to leave the tree empty until the next tick — the user had to retry by
 * hand. One dial here answers the question the switch just raised; a failed
 * probe changes nothing (the chip owns the failure, and the alias stays down).
 */
function probeConnectionOnSwitch(alias: string): void {
  if (alias === '') return
  switchProbe?.controller.abort()
  const controller = new AbortController()
  switchProbe = { alias, controller }
  void (async () => {
    try {
      // Background on purpose: a dead host's dial runs for the connection
      // timeout (45 s + guard). As a FOREGROUND request it would hold the
      // foreground counter up for that whole window and starve every background
      // git read; as a background one it only contends with the git channel,
      // while the tree keeps showing its cached/empty state.
      const answer = await api.testHost(alias, { background: true, signal: controller.signal })
      if (controller.signal.aborted || !answer.ok) return
      // The same two steps as the chip's retry: record the success (so a stale
      // poll cannot paint it red again) and refresh the pooled status.
      markConnectionProbeOk(alias)
      const statuses = await api.connectionStatus()
      if (controller.signal.aborted) return
      applyConnectionStatuses(statuses)
    } catch {
      // A failed probe is not news: the alias keeps the state the chip shows.
    } finally {
      if (switchProbe?.controller === controller) switchProbe = undefined
    }
  })()
}

/** Move the selection; `byUser` decides whether it is remembered as a choice. */
function applyWorkspaceSelection(id: string, byUser: boolean): void {
  if (state.workspaceId === id) return
  if (byUser) noteManualPick()
  const target = state.workspaces.find(item => item.id === id)
  // A connection probe started for the workspace being left is a real SSH dial
  // (up to the connection timeout on a dead host) and it is a FOREGROUND
  // request: left running, it would keep the background git channel of the NEW
  // workspace shut. Cancel it whether or not the new alias needs its own probe.
  if (switchProbe !== undefined && switchProbe.alias !== target?.alias) {
    switchProbe.controller.abort()
    switchProbe = undefined
  }
  // The workspace being left may have a full `git status` walk in flight. It is
  // no longer what the screen shows, and its connections are exactly what the
  // new workspace's directory list needs — cancel it here (the read drops its
  // answer; the cache it may already have written stays).
  for (const [readId, controller] of [...gitReadAborts]) {
    if (readId === id) continue
    controller.abort()
    gitReadAborts.delete(readId)
  }
  // Local stage results are repository-relative: another binding's paths must
  // never be re-applied to this one. The expanded untracked directories are
  // repository-relative too.
  stageOverrides = new Map()
  stageOverrideTarget = ''
  // Hydrate in the SAME frame as the selection: a workspace that was read once
  // repaints its whole change list here instead of showing "Loading…" for the
  // minutes a repository-wide walk takes. A miss clears the slice and the read
  // started below owns the loading state (see `scm/git-cache.ts`).
  const snapshot = readGitSnapshot(gitCacheKey(id, readRepoSubdir(id)))
  const stale = snapshot === undefined || Date.now() - snapshot.at >= CACHED_FRESH_MS
  patch({
    workspaceId: id,
    tabs: [],
    activeTabId: undefined,
    ...cachedGitSlice(id, stale),
  })
  try {
    localStorage.setItem(WS_KEY, id)
  } catch {
    // Private mode: ignore.
  }
  // A join can be a read that is ALREADY running (flip away and back): the busy
  // flag must reflect that before anything is published again.
  refreshGitBusy()
  if (stale) void refreshGit('join')
  // Selected onto an alias whose last known state was `error`: ask once, so the
  // tree is not gated offline by evidence from before the switch.
  if (target !== undefined && connectionStateOf(target.alias) === 'error') probeConnectionOnSwitch(target.alias)
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
  // An explicit choice settles the follow for good: no fast retry may move the
  // selection out from under it afterwards.
  clearFollowRetry()
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
  // …and its pending retry was about the previous session too.
  clearFollowRetry()
  // A different seat gets its own fast-retry budget.
  followFastRetrySpent = undefined
}

/** One resolution in flight, so the same session is never probed twice at once. */
let followFlight: { sessionId: string; promise: Promise<string | undefined> } | undefined

/**
 * Fast retries for a session whose workspace has not resolved yet.
 *
 * Opening a conversation right after a page load (or before the change panel's
 * first scan) used to leave the selector on the previous workspace until the
 * panel's slow fallback came around: the workspace visibly switched by itself a
 * quarter of a minute later, which reads as a slow/glitchy app. Three quick
 * attempts cover that window; the SLOW fallback stays in the panel, so this is a
 * latency fix, not a second poll. Only an UNRESOLVED follow retries: an answer
 * that landed, a manual pick and a session change all stop the chain.
 *
 * Module-level state for the same reason the follow itself is: it must outlive
 * any one surface's render, and there is exactly one follow per page.
 */
const FOLLOW_FAST_RETRY_MS = [300, 1_000, 3_000] as const

/** The pending fast-retry chain (one session at a time). */
let followRetry: { sessionId: string; attempt: number; timer: ReturnType<typeof setTimeout> } | undefined

/**
 * Session whose fast-retry budget has been spent.
 *
 * The slow panel tick keeps calling the follow every 15 s; without this, each
 * unresolved answer would arm a NEW three-attempt chain and a session with no
 * resolvable workspace would cost four cwd probes per tick instead of one.
 * Cleared when the session changes (a new seat gets its own budget).
 */
let followFastRetrySpent: string | undefined

/** > 0 while a retry-driven `followSessionWorkspace` call is in flight. */
let followRetryDrive = 0

/** Drop the pending retry (a resolution landed, the session changed, or the user picked). */
function clearFollowRetry(): void {
  if (followRetry === undefined) return
  clearTimeout(followRetry.timer)
  followRetry = undefined
}

/** Is the retry chain still about the session on screen, and still wanted? */
function followRetryWanted(sessionId: string): boolean {
  return followSessionId === sessionId
    && followedSession !== sessionId
    && manualPickSession !== sessionId
}

/**
 * Arm one attempt of the chain.
 *
 * The timer calls the follow again; a resolution that still has not landed
 * schedules the next attempt, and the chain stops after
 * {@link FOLLOW_FAST_RETRY_MS}'s last entry. "Still not landed" includes a cwd
 * probe that failed (resolved as "nothing resolved", not thrown); only a
 * rejection of the whole follow call — a bug, not a host answer — stops the
 * chain outright.
 */
function startFollowRetry(sessionId: string, attempt: number): void {
  clearFollowRetry()
  if (!followRetryWanted(sessionId)) return
  if (attempt >= FOLLOW_FAST_RETRY_MS.length) {
    followFastRetrySpent = sessionId
    return
  }
  const timer = setTimeout(() => {
    followRetry = undefined
    if (!followRetryWanted(sessionId)) return
    followRetryDrive += 1
    void followSessionWorkspace({}).then(
      (resolved) => {
        followRetryDrive -= 1
        if (resolved !== undefined || !followRetryWanted(sessionId)) {
          clearFollowRetry()
          return
        }
        startFollowRetry(sessionId, attempt + 1)
      },
      () => {
        followRetryDrive -= 1
        clearFollowRetry()
      },
    )
  }, FOLLOW_FAST_RETRY_MS[attempt] as number)
  // Never keep a Node gate (or a closing page) alive just for a retry.
  timer.unref?.()
  followRetry = { sessionId, attempt, timer }
}

/**
 * Note that one resolution came back unresolved and arm the fast retry.
 *
 * A no-op while the chain already runs for this session (the chain owns its next
 * attempt — scheduling from here would restart the delays) and while a
 * retry-driven call is in flight. A chain belonging to ANOTHER session is stale
 * and is replaced.
 */
function noteFollowUnresolved(sessionId: string): void {
  // The fast budget is once per session: the slow tick must not refill it.
  if (followFastRetrySpent === sessionId) return
  if (followRetry !== undefined && followRetry.sessionId !== sessionId) clearFollowRetry()
  if (followRetryDrive > 0 || followRetry !== undefined) return
  startFollowRetry(sessionId, 0)
}

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
  if (followedSession === sessionId) {
    clearFollowRetry()
    return Promise.resolve(followedBindingId)
  }
  if (manualPickSession === sessionId) {
    clearFollowRetry()
    return Promise.resolve(undefined)
  }
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
      // Still unresolved, so the fast retry gets its chance (the panel's slow
      // fallback would otherwise be the only way out).
      noteFollowUnresolved(sessionId)
      return undefined
    }
    // The session may have changed while the host was answering; its evidence
    // must not be applied to the new one.
    if (followSessionId !== sessionId) return undefined
    if (cwd !== undefined && cwd !== '') decision = plan(cwd)
  }
  if (decision.action === 'keep') {
    // Nothing resolved (the host knows no usable cwd for this session, or the
    // evidence names no binding): arm the fast retry instead of waiting for the
    // panel's slow one.
    noteFollowUnresolved(sessionId)
    return undefined
  }
  // The user may have chosen a workspace WHILE this resolution was in flight:
  // a choice beats a late answer.
  if (followSessionId !== sessionId || manualPickSession === sessionId) {
    clearFollowRetry()
    return undefined
  }
  followedSession = decision.followedSession
  followedBindingId = decision.bindingId
  // An answer landed: the chain has nothing left to do.
  clearFollowRetry()
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
 * Snapshot of the editor tabs, for non-React callers (the local gates).
 *
 * Same shape as `selectedWorkspaceId` / `gitState`: a plain read so a script can
 * assert what the store actually holds without rendering a component.
 */
export function editorTabs(): readonly EditorTab[] {
  return state.tabs
}

/**
 * The active tab's id.
 *
 * A plain getter rather than a hook, for the same reason `editorTabs` is one:
 * the restore path lives outside React, and the gates that verify it need to see
 * what the strip would consider current without mounting a component.
 */
export function activeEditorTabId(): string | undefined {
  return state.activeTabId
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
  // Pointing git at another DIRECTORY of the workspace is a switch like any
  // other: a directory that was read before paints its cached slice at once, and
  // the read below replaces it. A directory never read clears the slice, exactly
  // like before (`cachedGitSlice` reads the persisted choice, just written).
  adoptCachedGit(key)
  await refreshGit('fresh')
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

/**
 * Re-read git for the binding on screen.
 *
 * Reads go through `scm/read-queue.ts`, keyed by (binding, repository directory):
 * `join` shares a read that is already in flight — an automatic refresh has no
 * reason to duplicate a walk — while `fresh` waits for it and then reads again,
 * because the caller just wrote something and the answer must include it. Either
 * mode never runs two walks of the same repository at once, which is what lets a
 * background refresh and the ⟳ button coexist instead of racing.
 *
 * The answer is cached under the key the read STARTED with (even when the user
 * has already switched away: the walk is paid for either way, and the cache is
 * what makes the next visit instant) and repaints only while it is still that
 * binding's latest read.
 *
 * @param mode - `fresh` (default) never reuses a read that started before the
 *   call; `join` shares a running one (workspace switches, bootstrap).
 */
export async function refreshGit(mode: 'join' | 'fresh' = 'fresh'): Promise<void> {
  const { workspace, key } = activeBinding()
  if (workspace === undefined) return
  /**
   * An AUTOMATIC read (`join`: bootstrap、切工作区) must not dial a link the Host
   * already reports as down — the directory tree gates the same way
   * (`loadDir`/`prefetchDir`), and so do save and undo (`EditorPane.saveActive`,
   * `undoChange`). An EXPLICIT read (`fresh`: ⟳、写后、重连) still tries: it is
   * also how a recovered link gets re-proven.
   *
   * `undefined` (no status answer yet) must NOT block: bootstrap runs before the
   * first `/status` poll, and treating "no evidence" as "down" would leave the
   * panel empty forever.
   */
  if (mode === 'join' && connectionStateOf(workspace.alias) === 'error') {
    // Nothing cached and nothing read yet: the SCM empty state would sit on
    // "Loading…" forever, so say WHY instead. A cached slice stays untouched —
    // the connection chip is the indicator, and the panel must not paint a
    // second, raw-socket error over a list it can still show.
    if (state.repoRoot === undefined && state.status === undefined) patch({ gitError: t('scm.offlineRead') })
    return
  }
  const subdir = state.repoSubdir
  const cacheKey = gitCacheKey(key, subdir)
  const settleMs = gitReadSettleMs()
  try {
    await gitReads.run(cacheKey, () => readGit(key, subdir, cacheKey), mode, settleMs)
  } catch (error) {
    // A cancelled read (a workspace switch retired it) is not a failure: the
    // selection moved on and there is nothing to report for the old key.
    if (isRequestAbort(error)) return
    // Only the settle deadline (or a throw before the read's own try) lands
    // here: `readGit` handles read failures itself. The failure belongs to the
    // key this read STARTED with — the repo picker may have moved the panel to
    // another directory of the same workspace while this read was stuck, and
    // reporting it there would put a bogus "stuck" error and the cached badge on
    // top of that directory's successful answer.
    if (activeBinding().key !== key || currentGitKey() !== cacheKey) return
    patch({
      gitError: error instanceof Error ? error.message : String(error),
      gitCached: state.repoRoot !== undefined,
    })
  }
}

/**
 * One real read: probe the repository root, then status + branch header together,
 * then cache the answer and paint it when it still owns the screen.
 */
async function readGit(bindingId: string, subdir: string, cacheKey: string): Promise<void> {
  // The binding can disappear from the table while this read waits in the queue.
  const workspace = state.workspaces.find(item => item.id === bindingId)
  if (workspace === undefined) return
  // A read of the SAME binding is starting: the one already running describes a
  // slice that is about to be replaced (another repository directory, or a
  // refresh that started later), so it must release its connection instead of
  // walking the tree to an answer nobody will use.
  gitReadAborts.get(bindingId)?.abort()
  const controller = new AbortController()
  gitReadAborts.set(bindingId, controller)
  const signal = controller.signal
  const ticket = ++gitReadTicket
  latestGitRead.set(bindingId, ticket)
  // A local stage/unstage that happens while this read is in flight cannot be in
  // its answer: remember where the local timeline stood when it started.
  const stageAt = stageSeq
  try {
    const workdir = repoWorkdir(workspace.remotePath, subdir)
    // The strict probe (see `probeRepoRoot`): "not a repository" is a fact,
    // while a failed probe must NOT be mistaken for one — writing an empty
    // snapshot there would destroy the cached list and show the "no repository"
    // hint, which is the very blank state the cache exists to prevent.
    // `withDeadline` covers the host that never answers at all; the probe itself
    // reports transport failures.
    const probe = await withDeadline(probeRepoRoot(workspace.alias, workdir, signal), gitDeadlineMs(), t('editor.readTimeout'))
    if (probe.kind === 'failed') throw new Error(probe.error)
    if (probe.kind === 'none') {
      const snapshot: GitSnapshot = {
        repoRoot: undefined,
        repoSubdir: subdir,
        status: EMPTY_STATUS,
        head: undefined,
        repoMissing: true,
        untrackedDirs: new Map(),
        at: Date.now(),
      }
      writeGitSnapshot(cacheKey, snapshot)
      paintGit(bindingId, ticket, snapshot)
      return
    }
    const root = probe.root
    const [detail, head] = await Promise.all([
      withDeadline(loadStatusDetail(workspace.alias, root, signal), gitDeadlineMs(), t('editor.readTimeout')),
      withDeadline(loadHead(workspace.alias, root, signal), gitDeadlineMs(), t('editor.readTimeout')),
    ])
    // One half may have been aborted while the other answered; a half-finished
    // pair must never be cached (an aborted HEAD once landed as "detached").
    if (signal.aborted) return
    // A directory INSIDE a repository settles on that repository's root, so the
    // stored choice is what git actually uses (and what the picker shows). Only
    // the binding's LATEST read may rewrite that persisted choice: a read
    // superseded by a repo-picker switch must not put the OLD directory back
    // (its answer is still cached under the key it started with, which is what a
    // later switch to that directory needs).
    const settled = repoSubdirOf(workspace.remotePath, root) ?? subdir
    if (settled !== readRepoSubdir(bindingId) && latestGitRead.get(bindingId) === ticket) {
      writeRepoSubdir(bindingId, settled)
    }
    // Keep the local stage results this read could not have seen, and retire the
    // ones it did see (they are in `detail` now, for better or worse).
    const target = stageTargetKey({ alias: workspace.alias, root })
    const status = stageOverrideTarget === target ? applyStageOverrides(detail, stageOverrides, stageAt) : detail
    if (stageOverrideTarget === target) {
      for (const [path, override] of stageOverrides) {
        if (override.at <= stageAt) stageOverrides.delete(path)
      }
    }
    // An expanded untracked directory survives a read only while git still
    // reports the same directory row (see `pruneDirExpansions`). The live set
    // belongs to the binding on screen; a read of a workspace in the background
    // must prune ITS OWN cached set instead of borrowing another binding's.
    const onScreen = bindingId === activeBinding().key
    const priorDirs: DirExpansions = onScreen
      ? state.untrackedDirs
      : (readGitSnapshot(cacheKey)?.untrackedDirs ?? new Map())
    const dirs = pruneDirExpansions(priorDirs, status)
    const snapshot: GitSnapshot = {
      repoRoot: root,
      repoSubdir: settled,
      status,
      head,
      repoMissing: false,
      untrackedDirs: dirs,
      at: Date.now(),
    }
    writeGitSnapshot(cacheKey, snapshot)
    // The settled directory is a DIFFERENT cache key, and a switch back looks the
    // snapshot up under the PERSISTED choice — so both keys have to answer.
    if (settled !== subdir) writeGitSnapshot(gitCacheKey(bindingId, settled), snapshot)
    paintGit(bindingId, ticket, snapshot)
  } catch (error) {
    // An ABORTED read is not a failure. The switch (or the newer read that
    // superseded this one) cancelled it on purpose, so there is nothing to
    // report: `gitError` would blame the user's new workspace for a walk they
    // left, and the cached slice they already have stays the truth.
    if (signal.aborted || isRequestAbort(error)) return
    if (!gitReadIsCurrent(bindingId, ticket)) return
    // A failed read discards nothing that was already known: the panel keeps the
    // last good (or cached) slice and prints the message above it, so a transient
    // host error cannot blank a change list the user is working in. The slice is
    // marked cached because it now predates the failure.
    patch({
      gitError: error instanceof Error ? error.message : String(error),
      gitCached: state.repoRoot !== undefined,
    })
  } finally {
    // Only the read that still owns the slot may clear it: a newer read has
    // already replaced the map entry and must stay abortable.
    if (gitReadAborts.get(bindingId) === controller) gitReadAborts.delete(bindingId)
  }
}

/**
 * Adopt one read's answer when it still owns the screen.
 *
 * The ticket is what keeps two workspaces apart: a slow read of the workspace
 * the user just left still refreshes THAT workspace's cache — so switching back
 * is instant — but it never paints over the repository now on screen.
 */
function paintGit(bindingId: string, ticket: number, snapshot: GitSnapshot): void {
  if (!gitReadIsCurrent(bindingId, ticket)) return
  patch({
    repoRoot: snapshot.repoRoot,
    repoSubdir: snapshot.repoSubdir,
    repoMissing: snapshot.repoMissing,
    status: snapshot.status,
    head: snapshot.head,
    untrackedDirs: snapshot.untrackedDirs,
    gitError: undefined,
    gitCached: false,
  })
}

/** Refresh everything a working-tree change can invalidate. */
export async function afterWrite(): Promise<void> {
  await refreshGit()
  patch({ revision: state.revision + 1 })
}

/**
 * The connection came back: re-read everything a disconnect froze.
 *
 * `revision` is what makes the explorer re-list the root and every expanded
 * directory (the cached rows may predate the drop), and the git refresh updates
 * the status marks they are drawn with. Clean editor tabs are reloaded by the
 * caller (it owns the tab list); dirty ones must be left to the user.
 */
export function refreshAfterReconnect(): void {
  void refreshGit()
  patch({ revision: state.revision + 1 })
}

/** The repository the SCM panel is pointed at, or undefined when none. */
export function scmTarget(): { alias: string; root: string } | undefined {
  const workspace = currentWorkspace()
  if (workspace === undefined || state.repoRoot === undefined) return undefined
  return { alias: workspace.alias, root: state.repoRoot }
}

/**
 * Read-only view of the git slice, for callers that do not render.
 *
 * The UI reads the same values through `useExplorer()`; this getter exists for
 * the local gates, which drive this module in node with nothing mounted (they
 * need to observe the switch, the cached flag and what a failed read left
 * behind). It hands out primitives only, so no caller can mutate the store
 * through it.
 */
export function gitState(): {
  workspaceId: string
  repoRoot: string | undefined
  repoSubdir: string
  changes: number
  gitBusy: boolean
  gitCached: boolean
  gitError: string | undefined
  repoMissing: boolean
} {
  return {
    workspaceId: activeBinding().key,
    repoRoot: state.repoRoot,
    repoSubdir: state.repoSubdir,
    changes: state.status?.entries.length ?? 0,
    gitBusy: state.gitBusy,
    gitCached: state.gitCached,
    gitError: state.gitError,
    repoMissing: state.repoMissing,
  }
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
  const nextDirs = pruneDirExpansions(dirs, next)
  patch({ status: next, untrackedDirs: nextDirs })
  // Mirror the local move into the per-workspace cache: switching away and back
  // must not resurrect the list as it stood before the click. The paths are
  // repository-relative, so the guard is the snapshot's own repoRoot.
  const { workspace, key: bindingId } = activeBinding()
  if (workspace !== undefined) {
    const cacheKey = gitCacheKey(bindingId, state.repoSubdir)
    patchCachedGitStatus(cacheKey, state.repoRoot, next)
    patchCachedUntrackedDirs(cacheKey, state.repoRoot, nextDirs)
  }
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
    mirrorUntrackedDirs()
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
    mirrorUntrackedDirs()
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
 * Bring the editor into view.
 *
 * The docked surface (the default) is a FULL-COLUMN rail page, so opening a file
 * switches the column to the editor (the tree stays one click away on the rail)
 * — without this the click looks like a no-op. Closing its last file switches
 * back to the directory (see `closeTab`).
 *
 * On the 'center' surface the shell renders only the selected conversation
 * view, so a file opened from the sidebar must also select that tab. When the
 * tab cannot be found (another host build, or the shell's markup changed) the
 * user is told where the file opened instead of being left guessing.
 */
function revealEditor(): void {
  const surface = effectiveEditorSurface(state.editorSurface, state.floatOpen)
  // While the editor floats, neither docked surface has an editor to reveal:
  // the file just went into the floating window (which is already on screen).
  if (surface === 'float') return
  if (surface === 'sidebar') {
    if (state.view !== 'editor') setView('editor')
    return
  }
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

/**
 * Hard settle deadline for ONE queued git read (`scm/read-queue.ts`).
 *
 * A read that never settles would keep its key reserved forever: later `join`
 * calls reuse the dead promise, `fresh` callers wait for it, and the busy flag
 * stays up — one hung host call would freeze that key for the rest of the page
 * (the pre-cache code could always re-read, so this is the one regression a
 * shared flight introduces). The bound is generous on purpose: the status read
 * issues its probe and then its two loaders SEQUENTIALLY, so twice the configured
 * git budget plus slack is "stuck", not "slow".
 *
 * Exported because the panels own their own queues (SCM side lists, history log)
 * and must pass the same bound — a queue without one is a permanent lock waiting
 * for a host hiccup.
 */
export function gitReadSettleMs(): number {
  return gitDeadlineMs() * 2 + 30_000
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
  const previewKind = previewKindOf(fullPath)
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
    image: previewKind === 'image',
    markdown: previewKind === 'markdown',
    html: previewKind === 'html',
    preview: hasTextSource(previewKind),
    staged: false,
    untracked: false,
    ...(options.line === undefined ? {} : { line: options.line, lineNonce: 1 }),
    diff: undefined,
    model: undefined,
    view: 'split',
  })
  // PDF/Office/media have no editable text: reading them through fs.read would
  // only fetch a capped base64 window and land on the binary notice. The
  // preview component reads their bytes from the download route instead.
  if (isBytePreview(previewKind)) {
    patchTab(id, { loading: false })
    return
  }
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
        // The version these bytes came from: the save guard's baseline.
        remoteMtime: read.mtime,
        remoteSize: read.size,
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
 * @returns true when the click was HANDLED — either the file went to the editor,
 *   or it was deliberately refused with a message (see below); false only when
 *   the binding is unknown, which is the caller's cue to keep the native
 *   preview.
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
  if (state.workspaceId !== binding.id && !selectWorkspaceAuto(binding.id)) {
    /**
     * The auto switch is skipped while any tab has unsaved edits, and the
     * selection therefore still points at the OLD workspace. Opening the file
     * anyway would read it with that workspace's alias — a different host (the
     * read just fails) or, on the same host, whatever happens to live at the
     * same path — and it would mint a tab keyed by the wrong alias. Refuse, say
     * why, and still answer "handled" so the click interceptor does not fall
     * back to the native preview and repeat the same wrong resolution.
     */
    toast(t('files.openBlockedByDirty'), true)
    return true
  }
  openFile(remotePath, options)
  return true
}

/**
 * Whether the plugin's own rich editor is the place a remote file click should
 * land (the click interceptor's gate, see `remote-file-open.ts`).
 *
 * True while at least one SEAT exists that can render our editor in this page
 * (see `editor-capability.ts`): the docked sidebar pane is the default seat and
 * the conversation-view tab is the optional second one. "Registered" rather than
 * "currently mounted" on purpose — the panels are lazy/keep-alive, so a fresh
 * page has no mounted pane until the rail visits it, and asking for a mount
 * would send the first click to the host's native preview, which cannot resolve
 * a remote path at all. A host where no seat registers falls back to that native
 * preview, which is the only thing it can do. Unknown bindings are still
 * answered by `openRemoteFileInBinding` returning false.
 */
export function isEditorTakeoverActive(): boolean {
  return editorSeatCount() > 0
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
  const diffPath = `${root.replace(/\/+$/, '')}/${rel}`
  upsertTab({
    id,
    kind: 'diff',
    fullPath: diffPath,
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
        // The after pane is a prefix when the working-tree read hit the cap:
        // it must be read-only, or saving it would truncate the real file.
        truncated: payload.truncated === true,
        /**
         * The working-tree version this pane was read from — the save baseline,
         * taken from the SAME read rather than from a later stat (a second stat
         * could describe a version the user never saw, so the guard would accept
         * bytes read before that change). Absent for staged/commit diffs, which
         * are read-only.
         */
        ...(payload.mtime === undefined ? {} : { remoteMtime: payload.mtime, remoteSize: payload.size }),
      })
    } catch (error) {
      patchTab(id, { loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  })()
}

/** Apply a diff payload's baseline (see `DiffPayload.mtime`). */
function applyDiffBaseline(id: string, payload: { mtime?: number; size?: number }): void {
  if (payload.mtime === undefined) return
  patchTab(id, { remoteMtime: payload.mtime, remoteSize: payload.size })
}

/**
 * Open (or focus) one file of one commit (`ref^` against `ref`).
 *
 * `origPath` is the rename source from the commit's file row / patch header:
 * the two-sided view must diff the OLD path against the NEW one, or git sees
 * two unrelated paths and paints the rename as a whole-file addition.
 */
export function openCommitFile(hash: string, rel: string, origPath?: string): void {
  captureLiveBuffer()
  const workspace = currentWorkspace()
  const root = state.repoRoot
  if (workspace === undefined || root === undefined || rel === '') return
  const id = `commit:${workspace.alias}:${hash}:${rel}${origPath === undefined ? '' : `:<-${origPath}`}`
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
    ...(origPath === undefined ? {} : { origPath }),
    diff: undefined,
    model: undefined,
    view: 'split',
  })
  void (async () => {
    try {
      const payload = await withDeadline(loadCommitFileDiff(workspace.alias, root, hash, rel, origPath), gitDeadlineMs(), t('editor.readTimeout'))
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
  // Closing the LAST file returns to the directory: an empty editor page (or a
  // full-width tab with nothing in it) is where a reader has no next action.
  // Dirty tabs still go through the pane's confirmation before they get here.
  if (next.length === 0) {
    // The centre seat has nowhere to go once its last tab is gone: dock back and
    // show the directory. On the docked surface the editor IS the rail page, so
    // that page hands the column back to the explorer.
    if (state.editorSurface === 'center') setEditorSurface('sidebar')
    if (state.view === 'editor') setView('explorer')
  }
}

export function updateTab(id: string, next: Partial<EditorTab>): void {
  patchTab(id, next)
}

/**
 * One tab's save slot: at most one write in flight plus ONE pending content.
 *
 * Writes to the same remote path must never overlap. `RemoteFiles.write` is a
 * side file + `unlink` + `rename` (the atomic-save shape), so two writers race on
 * the RENAME: whichever lands last wins regardless of which the user pressed
 * last, and the store's baseline is then set by the other promise. The file can
 * end up holding the OLDER bytes while the UI says the newer ones were saved.
 *
 * Depth ONE on purpose: keyboard auto-repeat on Ctrl+S (holding it on a slow
 * link) would otherwise queue one full-document string per repeat (8 MiB files
 * make that an actual memory problem, not a theoretical one).
 */
interface SaveSlot {
  running: boolean
  /** The newest content waiting; a later request REPLACES it (last press wins). */
  pending: SaveRequest | undefined
  /** Callers waiting for the pending write; they get ITS outcome. */
  waiters: ((ok: boolean) => void)[]
}

/** One queued save: the bytes to write plus whether the user forced it. */
interface SaveRequest {
  content: string
  /**
   * Explicit "overwrite the changed remote file" (answered a conflict prompt).
   *
   * A merged request is one burst of the SAME intent, so the newest request's
   * force flag wins with its content: a forced save that coalesces a later
   * unforced one is still the user's overwrite decision, and the reverse
   * (unforced replacing forced) means they went back to the guarded path.
   */
  force: boolean
}

const saveSlots = new Map<string, SaveSlot>()

function saveSlotOf(id: string): SaveSlot {
  const existing = saveSlots.get(id)
  if (existing !== undefined) return existing
  const created: SaveSlot = { running: false, pending: undefined, waiters: [] }
  saveSlots.set(id, created)
  return created
}

/** Drop a drained slot: the map is keyed by tab id and must not grow forever. */
function releaseSaveSlot(id: string, slot: SaveSlot): void {
  if (slot.running || slot.pending !== undefined || slot.waiters.length > 0) return
  if (saveSlots.get(id) === slot) saveSlots.delete(id)
}

/**
 * Where one tab's save would go, or undefined when it is not writable NOW.
 *
 * Re-derived at EXECUTION time as well as at request time: a queued save can
 * outlive a workspace switch (the tab is gone), a reload that turns the tab
 * `truncated`, or a tab closed mid-queue. A queued write must never land in a
 * workspace that no longer shows the tab.
 *
 * The rule itself is S1's: a file tab, or a WORKING-TREE diff's after pane
 * (`kind: 'diff'`, no `ref`, not the staged side). Commit diffs and the staged
 * side are history.
 */
function saveTargetOf(id: string): { alias: string; fullPath: string; rel: string } | undefined {
  const workspace = currentWorkspace()
  const tab = state.tabs.find(item => item.id === id)
  if (workspace === undefined || tab === undefined) return undefined
  // A session diff is a comparison of the session's history, not an editable
  // working-tree copy: nothing in it may be written back (its "after" side is a
  // read of the file that a revert/agent may have moved on since).
  if (tab.sessionDiff !== undefined) return undefined
  const writable = tab.kind === 'file' || (tab.kind === 'diff' && tab.ref === undefined && !tab.staged)
  if (!writable || tab.binary || tab.truncated) return undefined
  return { alias: workspace.alias, fullPath: tab.fullPath, rel: tab.rel }
}

/**
 * Write one tab back to the remote host. @returns true when the burst's LAST
 * write landed.
 *
 * Requests for the SAME tab are serialized (see `SaveSlot`); a request that
 * arrives while one is in flight becomes the single pending write, replacing any
 * earlier pending content. Every caller of that burst — the one that started it
 * and the coalesced-away ones — resolves with the outcome of the write that
 * finally lands: the bytes they asked for are part of the newer buffer the
 * editor held, so "your edit is on disk" stays true (and a burst whose last
 * write failed reports false to all of them).
 */
export async function saveTab(id: string, content: string, options: { force?: boolean } = {}): Promise<boolean> {
  // Never fall back to the tab's loaded text. `tab.text` is only ever written
  // by a load/reload or by the surface handoff (`captureLiveBuffer`), never as
  // a fallback for a caller without a live buffer, so substituting it here
  // would push the PRE-EDIT (or the lost-buffer) bytes to the remote file and
  // report success — destroying the user's edit with a confirmation. A caller
  // without a live buffer must refuse to save instead (see EditorPane.saveActive).
  if (typeof content !== 'string') {
    toast(t('editor.needSource'), true)
    return Promise.resolve(false)
  }
  // Cheap refusal at REQUEST time: a truncated / binary / history tab answers
  // "no" synchronously and issues no write at all (the gate depends on it).
  if (saveTargetOf(id) === undefined) return Promise.resolve(false)
  /**
   * `text` is the request-time snapshot the success path compares against
   * (`newer` below): it must be recorded when the user ASKED, not when the write
   * finally runs — a handoff written in between would otherwise look like a
   * regression and keep the dirty flag for no reason.
   */
  patchTab(id, { saving: true, text: content })
  const request: SaveRequest = { content, force: options.force === true }
  const slot = saveSlotOf(id)
  if (slot.running) {
    slot.pending = request
    return new Promise<boolean>(resolve => { slot.waiters.push(resolve) })
  }
  return runSaveSlot(id, slot, request)
}

/** Drain one tab's queue: one write, then at most one pending, then settle all. */
async function runSaveSlot(id: string, slot: SaveSlot, first: SaveRequest): Promise<boolean> {
  slot.running = true
  let ok = true
  let request: SaveRequest | undefined = first
  try {
    while (request !== undefined) {
      ok = await performSave(id, request.content, request.force)
      request = slot.pending
      slot.pending = undefined
    }
  } finally {
    // `saving` is a QUEUE flag: it must stay true across the two writes of one
    // burst, or the status chip flickers "unsaved → saved → unsaved".
    slot.running = false
    patchTab(id, { saving: false })
    const waiters = slot.waiters
    slot.waiters = []
    for (const resolve of waiters) resolve(ok)
    releaseSaveSlot(id, slot)
  }
  return ok
}

/**
 * One queued write. Everything it needs is re-read when it actually runs.
 *
 * The write carries the remote VERSION this tab was based on, and the Host
 * refuses it when the file moved on since. That refusal is the whole point of
 * this function's guard: this project's normal way of working is a human and an
 * agent editing the same remote tree, and a save that silently overwrote an
 * agent's last write was the one data-loss path with no recovery (the changes
 * panel would only notice the file afterwards, with the other side already
 * gone).
 *
 * @param force - the user answered the conflict prompt with "overwrite": the
 *   write then goes through unguarded. It is an explicit decision made on
 *   screen, not a default.
 */
async function performSave(id: string, text: string, force: boolean): Promise<boolean> {
  const target = saveTargetOf(id)
  if (target === undefined) return false
  const tab = state.tabs.find(item => item.id === id)
  /**
   * The lock, built from the version this buffer was loaded from or last saved
   * to. No baseline (`undefined`) means the guard cannot say anything truthful
   * about this file, so it stays silent instead of blocking a legitimate save.
   */
  const guard = !force && tab !== undefined && tab.remoteMtime !== undefined
    ? {
        expectMtime: tab.remoteMtime,
        ...(tab.remoteSize === undefined ? {} : { expectSize: tab.remoteSize }),
      }
    : undefined
  try {
    const written = await api.fileOp.write(target.alias, target.fullPath, text, guard)
    /**
     * The remote file now holds `text`, so that becomes the disk-side dirty
     * baseline (a later remount compares against it).
     *
     * The dirty FLAG is deliberately NOT cleared while the tab may still hold
     * something newer than what was written. Two ways that happens, and both
     * must keep the flag:
     *
     *  - a live editor is mounted for this tab: the user may have typed while
     *    the write was in flight, and only the editor can tell (it re-derives
     *    through `markLiveEditorSaved` below);
     *  - the tab was switched away from mid-write: its stored `text` is then the
     *    handoff copy of that newer buffer, so comparing it with what was
     *    written detects the difference without an editor. A LATER queued save
     *    also lands here: its request-time `text` is newer than this write, so
     *    the flag stays until that one lands.
     *
     * Only a tab whose stored text IS the written text, with no mounted editor,
     * has nothing newer — there the flag is cleared directly. (Clearing it
     * otherwise is how a tab read "saved" while its buffer was not: dot off,
     * Save disabled, close guard silent.)
     */
    const liveEditor = isLiveEditorFor(id)
    const current = state.tabs.find(item => item.id === id)
    const newer = current !== undefined && current.text !== text
    patchTab(id, {
      baseline: text,
      // The version just written becomes the next save's baseline. A Host that
      // could not read it back answers null: the next save is then unguarded,
      // which is honest, rather than "conflicting" with a made-up timestamp.
      remoteMtime: written.mtime ?? undefined,
      remoteSize: written.size,
      // Whatever conflict was on screen is answered by this successful write.
      conflict: undefined,
      ...(liveEditor || newer ? {} : { dirty: false }),
    })
    markLiveEditorSaved(id, text)
    toast(`${t('editor.saved')} · ${target.rel}`, false)
    /**
     * The write is DONE, and the save result must not include a remote git read.
     *
     * `afterWrite()` re-reads `git status` and only then re-lists the tree. On a
     * monorepo that read is the expensive half (the SCM panel shows the same cost:
     * seconds, and minutes when the tree is cold), and awaiting it here made the
     * editor's "saving…" last exactly that long — which is what "saving is slow,
     * it refreshes git first" looks like from the outside. Nothing the save
     * REPORTS depends on it: the baseline advances from the write's own answer
     * above, and the dirty flag is re-derived synchronously.
     *
     * So it runs in the background. It still runs — the status marks and the tree
     * revision catch up when it lands — and the read queue collapses a burst of
     * saves into at most one follow-up walk (`ReadQueue.run(..., 'fresh')`).
     */
    void afterWrite()
    /**
     * The save just changed what this file looks like against the session
     * baseline, so the marks painted from the PREVIOUS bytes are gone (typing
     * invalidates them by design) — and nothing used to bring them back until the
     * user clicked the row in the change panel again. Re-fetch them from the tab's
     * own recorded provenance, which needs no panel interaction. Also background:
     * it is one more remote read that must not stand between the user and "saved".
     */
    refreshChangeSetForTab(id)
    return true
  } catch (error) {
    /**
     * A REFUSED save, not a failed one: the remote file moved on. Nothing was
     * written, so the buffer, its dirty flag and the baseline all stay exactly
     * as they were — the user is shown what is there now and decides.
     *
     * Deliberately NOT going through `afterWrite()`: re-listing the tree here
     * would repaint a panel behind the decision the user is about to make.
     */
    if (error instanceof RemoteApiError && error.conflict !== undefined) {
      patchTab(id, { conflict: error.conflict })
      toast(`${t('editor.conflictBlocked')} · ${target.rel}`, true)
      return false
    }
    toast(error instanceof Error ? error.message : String(error), true)
    return false
  }
}

/**
 * Drop the pending save-conflict banner for one tab.
 *
 * Hiding the offer is NOT a decision: the buffer stays dirty and the baseline
 * stays untouched, so the next save is guarded exactly as this one was. Only a
 * forced save or a reload can settle a conflict for real — anything else would
 * be deciding for the user which version of their file to keep.
 */
export function dismissConflict(id: string): void {
  const tab = state.tabs.find(item => item.id === id)
  if (tab?.conflict === undefined) return
  patchTab(id, { conflict: undefined })
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
  const tab = state.tabs.find(item => item.id === id)
  if (tab === undefined) return
  /**
   * A session-diff tab re-reads the LEDGER, not the working tree: it has its own
   * alias/root on the tab (the sidebar may be pointing at another binding), and
   * `git diff` would show a different baseline. Handled before the workspace
   * lookup below, which a session diff does not need at all.
   */
  if (tab.sessionDiff !== undefined) {
    try {
      const loaded = await loadSessionDiffPayload({
        sessionId: tab.sessionDiff.sessionId,
        alias: tab.sessionDiff.alias,
        root: tab.sessionDiff.root,
        path: tab.fullPath,
        display: tab.sessionDiff.display,
      })
      if (loaded.payload === undefined) {
        // 重新载入时拿不到完整的两栏（内容被扣下 / 已无差异 / 读不到）：说清是哪一种，
        // 而不是留一个错误字符串占位。标签页本身保留，用户可以再试或改看文件。
        const notice = loaded.notice ?? 'missing'
        patchTab(id, { loading: false, error: t(diffNoticeKey(notice)), diff: undefined, model: undefined })
        return
      }
      patchTab(id, {
        loading: false,
        error: undefined,
        diff: loaded.payload,
        model: buildDiffModel(loaded.payload),
      })
    } catch (error) {
      patchTab(id, { loading: false, error: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  const workspace = currentWorkspace()
  if (workspace === undefined) return
  if (tab.kind === 'file') {
    // Byte previews have no text buffer: fs.read would fetch a capped base64
    // window and turn the tab into "binary", hiding the preview. A revision
    // bump is the whole reload for them.
    if (isBytePreview(previewKindOf(tab.fullPath))) {
      patchTab(id, { loading: false, error: undefined, reloadNonce: (tab.reloadNonce ?? 0) + 1 })
      return
    }
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
        // A reload REPLACES the version this tab was based on, so the next save
        // is guarded against the bytes the user actually saw. Leaving the old
        // mtime here would make the very next save conflict with itself.
        remoteMtime: read.mtime,
        remoteSize: read.size,
        // Whatever conflict was pending is answered by this reload.
        conflict: undefined,
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
      ? await withDeadline(loadCommitFileDiff(workspace.alias, root, tab.ref, tab.rel, tab.origPath), gitDeadlineMs(), t('editor.readTimeout'))
      : await withDeadline(loadDiff(workspace.alias, root, tab.rel, tab.staged, tab.untracked), gitDeadlineMs(), t('editor.readTimeout'))
    patchTab(id, {
      loading: false,
      error: undefined,
      diff: payload,
      binary: payload.unsupported,
      model: payload.unsupported ? undefined : buildDiffModel(payload),
      truncated: payload.truncated === true,
      dirty: false,
    })
    // The diff now shows the CURRENT working tree, so the save baseline has to
    // follow it — a stale one would make the next save conflict with itself.
    applyDiffBaseline(id, payload)
  } catch (error) {
    patchTab(id, { error: error instanceof Error ? error.message : String(error) })
  }
}

/** Note where the editor pane is mounted (set by the client entry). */
export function setEditorSurface(surface: 'center' | 'sidebar'): void {
  patch({ editorSurface: surface })
}

/**
 * Move the editor into the conversation-view tab (full width).
 *
 * The live buffer is captured BEFORE the surface flips: the flip unmounts the
 * mount that owns it (see `captureLiveBuffer`'s header), and without that
 * handoff the edits typed since the load would disappear. The host tab is then
 * selected so the user actually sees where the editor went.
 */
export function openEditorInCenter(): void {
  if (state.editorSurface === 'center') {
    revealEditor()
    return
  }
  captureLiveBuffer()
  patch({ editorSurface: 'center' })
  revealEditor()
}

/**
 * Dock the editor back into the sidebar (the reverse of `openEditorInCenter`).
 *
 * The docked pane is the default seat and owns the whole sidebar column, so
 * `revealEditor` switches the rail to the editor page (from whatever view was
 * showing) and the tree stays one click away.
 */
export function dockEditorSidebar(): void {
  if (state.editorSurface === 'sidebar') {
    revealEditor()
    return
  }
  captureLiveBuffer()
  patch({ editorSurface: 'sidebar' })
  revealEditor()
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
 * Float the editor in its current state, without opening anything.
 *
 * The entry is a double-click on the shell's 「远程编辑器」 tab (see
 * `float-tab-trigger.ts`): the user is already looking at the editor and wants
 * it out of the layout — no file, no diff, same tabs and buffers.
 *
 * Idempotent: while the editor already floats this does nothing (the window is
 * on screen; a second trigger must not restart it).
 */
export function openFloatingEditor(): void {
  if (state.floatOpen) return
  captureLiveBuffer()
  enterFloatSurface()
  // A fresh open must not come back as a 34px bar: the ball is the minimized
  // state, and the store carries no knowledge of the window's local collapse
  // flag, so the window resets it when `floatOpen` flips (see its `wasOpenRef`).
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
  patchTab(tabId, { changeSet: set, activeHunk: 0, changeStale: false, changeSetAt: Date.now() })
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
 * 面板拿到新统计后，指出哪些已开标签页的改动标记已经过期。
 *
 * 标记的失效原来只由"本地输入"触发（`markChangeStale` 由编辑器报告），所以远端或
 * 会话继续改同一个文件时，屏幕上那份行号与补丁会一直画着、看起来仍然准确。面板每
 * 3 秒重读一次账本，那份列表就是"这批标记还算不算数"的唯一证据 —— 这里把它翻成
 * 既有那张「位置已过期」标记。
 *
 * 判据是纯函数（`changes/staleness.ts`），这里只负责选出**属于这个会话**的标签页：
 * 换会话后屏幕上可能还留着上一个会话的标记，拿本会话的列表去比对只会误报。
 * **不发起任何远端读**：重新计算是用户点该行时的事。
 *
 * @param sessionId - 面板当前会话。
 * @param files - 这一轮列表的行。
 * @param truncated - 列表自己被文件上限截断（"找不到"不再算证据）。
 * @param listedAt - 这份列表的重算时刻（`RemoteChangesSummary.at`）。
 * @param turnView - 本轮视图；带本轮来源的标记要用它那一份行来判（见实现）。
 */
export function syncChangeSetStaleness(
  sessionId: string,
  files: readonly RemoteChangedFile[],
  truncated = false,
  listedAt?: number,
  turnView?: RemoteChangesTurnView,
): void {
  const sessionRows: MarksTab[] = []
  const turnRows: MarksTab[] = []
  for (const tab of state.tabs) {
    const set = tab.changeSet
    if (set === undefined || set === null) continue
    const origin = changeOriginForTab(tab.id)
    // 没有 provenance 就没法证明这批标记是哪个会话画的：不猜。
    if (origin === undefined || origin.sessionId !== sessionId) continue
    const row: MarksTab = {
      id: tab.id,
      path: tab.fullPath,
      ...(set.added === undefined ? {} : { added: set.added }),
      ...(set.deleted === undefined ? {} : { deleted: set.deleted }),
      ...(set.status === undefined ? {} : { status: set.status }),
      ...(tab.changeStale === true ? { stale: true } : {}),
      ...(tab.changeSetAt === undefined ? {} : { at: tab.changeSetAt }),
    }
    // 行数是"哪条轴"的数字：同一文件的本轮 Δ 与会话累计按定义不同，所以每种
    // 标记只能拿它当初所在的那份列表来判，否则切一轮就会把好好的标记判成过期。
    if (origin.scope === 'turn') turnRows.push(row)
    else sessionRows.push(row)
  }
  for (const tabId of tabsToMarkStale(sessionRows, files, truncated, listedAt)) markChangeStale(tabId)
  // Remembered for later re-reads: see `latestTurns`.
  if (turnView !== undefined) rememberLatestTurn(sessionId, turnView.turn)
  /*
   * 本轮轴用 `turnMarksStale`，不是 `tabsToMarkStale`：
   * - 不传 `listedAt`（`turnView.at` 是关闭时刻、`changeSetAt` 是点击时刻，传了会
   *   让判据恒假 —— 审核 S1 的第一半）；
   * - 轮次翻篇直接判过期（`origin.turn !== turnView.turn`），否则旧轮标记永久脱离
   *   校验（S1 的第二半）。
   */
  for (const row of turnRows) {
    if (row.stale === true) continue
    if (turnMarksStale(row, changeOriginForTab(row.id)?.turn, turnView)) markChangeStale(row.id)
  }
}

/**
 * 「会话改动」面板那一行的 → 只读并排 diff（见 `changes/session-diff.ts`）。
 *
 * 与 `openFile`/`openDiff` 的区别是数据来源：这里读的是会话账本（会话起点为基线），
 * 而 `openDiff` 读的是 git 工作区（索引/HEAD 为基线）。两件事不能互相顶替 ——
 * 工作区里可能有会话开始之前就存在的未提交改动。
 *
 * 结果里的 `notice` 就是面板要显示的那句话（截断 / 二进制 / 读不到 / 已无差异），
 * 打开成功时为 `undefined`。调用方负责把它渲染出来，不要吞掉。
 */
export interface ChangeDiffTarget {
  sessionId: string
  alias: string
  /** 会话账本的仓库根（与 `revertFileChanges` 的 `root` 同源）。 */
  root: string
  /** 远端绝对路径。 */
  path: string
  /** 面板显示路径（标签条用）。 */
  display: string
  /** 面板选定的仓库子目录（透传给账本的 `repoSubdir`，可省略）。 */
  repoSubdir?: string
}

export interface ChangeDiffResult {
  opened: boolean
  /** 必须显示给用户的结论；`undefined` = 打开成功且没有任何要说明的。 */
  notice?: DiffNotice
}

/** 读一次账本 diff 并拼成 DiffPayload；拿不到可显示内容时 `undefined`。 */
async function loadSessionDiffPayload(target: ChangeDiffTarget): Promise<{
  payload: DiffPayload | undefined
  notice?: DiffNotice
}> {
  const diff = await api.changes.diff(target.sessionId, target.path, target.repoSubdir)
  // 被字节上限扣下的 diff 不值得再读文件：结论已经确定（比较不完整、不能撤销）。
  if (diff === null || diff.kind !== 'text' || diff.truncated === true || diff.hunks.length === 0) {
    const outcome = sessionDiffOutcome(diff, { text: '' }, target.display)
    return { payload: undefined, ...(outcome.ok ? {} : { notice: outcome.notice }) }
  }
  /**
   * 改后一栏的读取结果要参与结论：撞上 8 MiB 上限的 `text` 只是前缀，拿去还原
   * 基线会让两栏整体错位；二进制读取也没有可比的文本（审核 S4）。
   */
  let read: { text: string; truncated?: true; binary?: true } = { text: '' }
  try {
    const answer = await api.fileOp.read(target.alias, target.path)
    read = {
      text: answer.binary ? '' : (answer.text ?? ''),
      ...(answer.truncated === true ? { truncated: true as const } : {}),
      ...(answer.binary === true ? { binary: true as const } : {}),
    }
  } catch {
    // 读不到"改后"（已删除 / 权限）：改后一栏空着，改前仍可看。
    read = { text: '' }
  }
  const outcome = sessionDiffOutcome(diff, read, target.display)
  return { payload: outcome.ok ? outcome.payload : undefined, ...(outcome.ok ? {} : { notice: outcome.notice }) }
}

/** 打开（或聚焦）一行的会话只读 diff。 */
export async function openChangeDiff(target: ChangeDiffTarget): Promise<ChangeDiffResult> {
  const id = `changes-diff:${target.alias}:${target.path}`
  const loaded = await loadSessionDiffPayload(target)
  const notice = loaded.payload === undefined ? (loaded.notice ?? 'missing') : undefined
  const sessionDiff = {
    sessionId: target.sessionId,
    alias: target.alias,
    root: target.root,
    display: target.display,
  }
  const already = state.tabs.find(item => item.id === id)
  if (already !== undefined) {
    if (loaded.payload !== undefined) {
      patchTab(id, { diff: loaded.payload, model: buildDiffModel(loaded.payload), sessionDiff, loading: false, error: undefined })
      patch({ activeTabId: id })
      revealEditor()
    }
    return { opened: loaded.payload !== undefined, ...(notice === undefined ? {} : { notice }) }
  }
  if (loaded.payload === undefined) return { opened: false, ...(notice === undefined ? {} : { notice }) }
  upsertTab({
    id,
    kind: 'diff',
    fullPath: target.path,
    rel: target.display,
    loading: false,
    error: undefined,
    text: '',
    dirty: false,
    saving: false,
    binary: false,
    truncated: false,
    image: isImageFile(target.display),
    markdown: false,
    html: false,
    preview: false,
    staged: false,
    untracked: false,
    diff: loaded.payload,
    model: buildDiffModel(loaded.payload),
    view: 'split',
    sessionDiff,
  })
  return { opened: true, ...(notice === undefined ? {} : { notice }) }
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
 * The newest turn each session has seen (`summary.turnView.turn`).
 *
 * Written by the panel's every poll (`syncChangeSetStaleness`) and read when a
 * save/revert re-reads a turn-scope tab: the host's `turnDiff` always answers for
 * the CURRENT turn, so the provenance's `turn` must move forward with it — pinned
 * to the turn of the click, the marks would be judged stale the instant a new
 * turn closed (review S1).
 */
const latestTurns = new Map<string, number>()
/** Ceiling on tracked sessions (a long-lived page must not grow this forever). */
const LATEST_TURNS_CAP = 200

function latestTurnOf(sessionId: string): number | undefined {
  return latestTurns.get(sessionId)
}

function rememberLatestTurn(sessionId: string, turn: number): void {
  if (turn <= 0) return
  latestTurns.delete(sessionId)
  if (latestTurns.size >= LATEST_TURNS_CAP) {
    const oldest = latestTurns.keys().next().value
    if (oldest !== undefined) latestTurns.delete(oldest)
  }
  latestTurns.set(sessionId, turn)
}

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
  const turnScope = context.scope === 'turn'
  try {
    /*
     * Re-read the SAME axis the marks came from. A turn-scope tab rebuilt from the
     * session baseline would change what "undo this change" means mid-review (its
     * hunks cover the whole session, not the turn), and its counts would then
     * disagree with the turn list on every poll.
     */
    const diff = turnScope
      ? await api.changes.turnDiff(context.sessionId, tab.fullPath)
      : await api.changes.diff(context.sessionId, tab.fullPath)
    if (turnScope && (diff === null || diff.kind === 'stale' || diff.kind === 'unavailable')) {
      // The turn's comparison no longer describes the disk (a write of ours just
      // moved the file, or the turn rolled over): drop the marks and SAY so. The
      // session view is the surface that still knows the file.
      applyChangeSet(tabId, null)
      forgetChangeOrigin(tabId)
      info(t('changes.turnMarksStale'))
      return
    }
    /**
     * 不能建标记的结局都要**说出来**（审核 NIT-4）：被字节上限扣下、二进制、读不到、
     * 或者改动已经没了时，静默清空标记会让用户以为"改动消失了 / 工具坏了"。这里复用
     * 面板点行时那套结论文案（`changes/diff-outcome.ts`），一次 `info` 就够了 ——
     * 标记本身确实失效，不能继续画。
     */
    const notice = noticeOfDiff(diff)
    if (notice !== undefined) {
      applyChangeSet(tabId, null)
      info(t(diffNoticeKey(notice)))
      return
    }
    // 块级「确认保留」的身份用**远端绝对路径**（不是显示路径）：它与面板打开时
    // 是同一个字符串，所以一次保存/撤销不会让已确认的块失配，也不会把另一个仓库
    // 里同号同显示路径的块认成同一块。
    const built = changeSetFromDiff(diff, `${tab.fullPath}@${turnScope ? 'turn' : 'session'}@${Date.now()}`, { path: tab.fullPath })
    applyChangeSet(tabId, built.set)
    /*
     * A turn-scope re-read fetches the CURRENT turn's comparison (the host only
     * ever holds one). Recording that turn on the provenance is what keeps the
     * marks from being instantly judged stale the moment a new turn has closed —
     * they now describe the current turn, not the one the click happened in
     * (review S1: `origin.turn` used to stay pinned to the old turn forever).
     */
    if (turnScope) {
      const current = latestTurnOf(context.sessionId)
      if (current !== undefined && current !== context.turn) {
        rememberChangeOrigin(tabId, { ...context, turn: current })
      }
    }
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
  /**
   * 撤销是一次远端写（`git apply -R`）。链路已经判定断开时，请求发出去也只有一个
   * 结果：让 socket 文案冒出来、再被 `catch` 误标成「撤销冲突」。这里按**请求所属的
   * alias** 预判（不是页面上可见的那个），与保存路径（`EditorPane.saveActive` 的
   * offline 分支）用同一句「操作未发送」；`undefined` = 没有证据，不拦。
   *
   * 顺序是承重的：dirty 门在前（用远端补丁盖掉未保存编辑是最糟的结果），离线门在后。
   */
  if (connectionStateOf(context.alias) === 'error') {
    info(t('connection.actionFailed'))
    return
  }
  // Snapshot the set BEFORE the write: after a successful revert the marks are
  // re-read (`refreshChangeSet`), so "was this the file's only hunk" can only be
  // answered from the data the user actually clicked.
  const changeSet = tab.changeSet
  const patches = changeSet?.patches ?? []
  const patch = patches[mark.hunk ?? -1]
  if (patch === undefined || patch.trim() === '') {
    info(t('changes.undoMissing'))
    return
  }
  /**
   * Would this ONE undo leave the file with no change in this turn?
   *
   * Only then may the row be hidden from the turn list (see
   * `changes/turn-reverted.ts`): a multi-hunk file that is partially reverted still
   * has changes, and hiding it would hide them too — worse than the stale row this
   * task is fixing.
   */
  const clearsTurn = hunkRevertClearsTurn(context.scope, patches.length)
  try {
    // 'revert' = 远端 `git apply -R`；上下文不匹配它就抛错，这就是冲突护栏。
    await applyHunk(context.alias, context.root, patch, 'revert')
  } catch (error) {
    /**
     * 传输失败不是「补丁上下文变了」：报成冲突会让用户去改文件，而真正的原因是链路。
     * `applyHunk` 的补丁临时文件写失败会以 transport 错误原样抛出（`actions.ts` 的
     * write 在 try 之外），`api.call` 会给它打 `transport` 标记，所以这里的判据对
     * 「首次失败（原始 socket 文案）」和「重复失败（已本地化）」都成立。
     */
    if (isConnectionFailure(error)) {
      info(t('connection.actionFailed'))
      return
    }
    // 可把 git 的说法附在后面（"patch does not apply" 之类），但**不动**标记与文件。
    // 先按 stderr 归类：上下文变了 / 文件不在了 / 不是仓库 / 权限，四种修法完全不同。
    const detail = error instanceof Error ? error.message.trim() : String(error).trim()
    info(applyFailureText(detail, t) ?? t('changes.undoConflict'))
    return
  }
  /**
   * The remote write succeeded. Record it on the CLIENT so the frozen turn list
   * stops showing the row (the host keeps its turn delta untouched — that snapshot
   * is what the whole turn view is built on).
   *
   * Fail-closed on a missing turn: hiding is a claim about "this turn", and with no
   * turn recorded the panel would have to guess which one to hide. Not hiding is
   * the safe answer (the row stays, exactly as before this feature).
   */
  if (clearsTurn && context.turn !== undefined) {
    markTurnReverted(context.sessionId, context.turn, tab.fullPath)
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

/**
 * Coordinates for "undo everything this session did to this file".
 *
 * Handed over by the change panel, which is the only surface that knows both the
 * file and the session it belongs to. `mode` comes from the HOST
 * (`RemoteChangedFile.revert`), never from the client: only git can say whether a
 * creation has a copy to fall back on.
 */
export interface RevertFileTarget {
  sessionId: string
  bindingId: string
  alias: string
  root: string
  path: string
  display: string
  mode: 'patch' | 'delete'
  /**
   * Which comparison the patch must come from.
   *
   * `turn` = "undo what THIS turn did to this file" (restore the previous turn's
   * close); absent = the session baseline (unchanged default). The patch is
   * re-fetched from the host rather than taken from the panel's poll, so the
   * same argument decides WHICH host read to make.
   */
  scope?: 'session' | 'turn'
  /**
   * For `scope: 'turn'`: which turn the row came from.
   *
   * Used after a successful revert to hide that row from the turn list (the host's
   * frozen delta keeps listing it, by design). **Fail-closed**: when it is omitted
   * the row is NOT hidden — hiding is a claim about one specific turn, and guessing
   * it (e.g. from "the latest turn seen") could hide a row in a turn the user never
   * reverted. The only caller (the dock) always knows it.
   */
  turn?: number
}

/**
 * Revert one file's WHOLE session change set (the panel row's action).
 *
 * Three things make this a separate path from `undoChange`, and each one is
 * load-bearing:
 *
 * 1. **It works without an open tab.** The panel lists files nobody opened, so
 *    the coordinates cannot come from `undoContext()` (which describes the tab on
 *    screen). They arrive with the call and are validated by the SAME rules
 *    (`resolveUndoTarget`: session agreement, binding identity, path under the
 *    ledger root) — a row from another conversation, or from a sibling binding
 *    that happens to share the alias, is refused rather than guessed.
 * 2. **It is ONE remote write.** The host serves the file as a single patch, which
 *    is exactly what `git apply -R` needs to restore the session baseline; a loop
 *    of per-hunk applies would shift every later hunk and report a conflict
 *    halfway through, leaving the file half reverted.
 * 3. **A creation is not a patch.** `mode: 'delete'` (a tracked addition, where
 *    git still holds the bytes) deletes the file behind an explicit confirmation;
 *    an untracked creation never reaches here, because the host offers no mode
 *    for it.
 *
 * The order of the gates is the one `undoChange` established: an unsaved buffer
 * refuses first (a remote write must never overwrite what the user has not
 * saved), then the offline check, then the coordinates, then the patch.
 *
 * @returns whether the remote was actually written.
 */
export async function revertFileChanges(target: RevertFileTarget): Promise<boolean> {
  const tab = state.tabs.find(item => item.kind === 'file' && item.fullPath === target.path)
  if (tab?.dirty === true) {
    info(t('changes.undoDirty'))
    return false
  }
  if (connectionStateOf(target.alias) === 'error') {
    info(t('connection.actionFailed'))
    return false
  }
  const origin = {
    sessionId: target.sessionId,
    bindingId: target.bindingId,
    alias: target.alias,
    root: target.root,
    display: target.display,
    ...(target.scope === 'turn' ? { scope: 'turn' as const } : {}),
  }
  /**
   * The session check inside `resolveUndoTarget` is trivially true here (the panel
   * passed both ids), and that is fine: the panel can only hand over a row from the
   * summary it fetched FOR this session (`data.id === sessionId`). What this call
   * really answers is the part the panel cannot know: is that binding still the
   * same one (id + alias), and does this path still sit under the ledger root the
   * patch was computed against?
   */
  const resolved = resolveUndoTarget({
    origin,
    tabPath: target.path,
    panelSessionId: target.sessionId,
    bindings: remoteOpenBindings().bindings,
  })
  if (!resolved.ok) {
    info(t('changes.undoNoContext'))
    return false
  }
  try {
    if (target.mode === 'patch') {
      // Fresh from the host: the panel's numbers may be a poll old, and the patch
      // must describe the file as it is NOW.
      const diff = target.scope === 'turn'
        ? await api.changes.turnDiff(target.sessionId, target.path)
        : await api.changes.diff(target.sessionId, target.path)
      if (target.scope === 'turn' && diff !== null && (diff.kind === 'stale' || diff.kind === 'unavailable')) {
        // The turn's comparison is gone (the file moved on, or the host dropped
        // the hunks): nothing was written, and saying which is better than a
        // generic refusal the user cannot act on.
        info(t('changes.turnMarksStale'))
        return false
      }
      const patch = diff !== null && diff.kind === 'text' ? (diff.patch ?? '') : ''
      if (patch.trim() === '') {
        info(t('changes.undoMissing'))
        return false
      }
      await applyHunk(target.alias, target.root, patch, 'revert')
    } else {
      const ok = await confirmDialog({
        title: t('changes.revertCreationTitle'),
        text: t('changes.revertCreationText').replace('{path}', target.display),
        danger: true,
        okText: t('changes.revertCreationOk'),
      })
      if (!ok) return false
      await api.fileOp.rm(target.alias, target.path, false)
    }
  } catch (error) {
    if (isConnectionFailure(error)) {
      info(t('connection.actionFailed'))
      return false
    }
    const detail = error instanceof Error ? error.message.trim() : String(error).trim()
    /**
     * A refused reverse patch means "the surroundings moved" — one of several
     * causes, each with a different fix, so the patch path classifies git's own
     * stderr (`changes/apply-failure.ts`). A failed delete has no such reading
     * (it is one `rm`), so it keeps its own wording instead of pretending the
     * patch context drifted.
     */
    const label = target.mode === 'delete' ? t('changes.revertFailed') : (applyFailureText(detail, t) ?? t('changes.undoConflict'))
    info(target.mode === 'delete' && detail !== '' ? `${label} · ${detail}` : label)
    return false
  }
  /**
   * The write SUCCEEDED, so nothing below may be reported as a failure: the
   * remote file has already changed. Refreshing the tab and the list is best
   * effort — a read that fails here leaves a stale panel, not a lost revert.
   */
  /*
   * Turn scope: the whole file's turn change is gone, so record it for the panel
   * to hide. The host is NOT told (its turn delta stays frozen — see
   * `changes/turn-reverted.ts`); the session-cumulative view is untouched.
   * Fail-closed like `undoChange`: no recorded turn ⇒ no hide, never a guess.
   */
  if (target.scope === 'turn' && target.turn !== undefined) {
    markTurnReverted(target.sessionId, target.turn, target.path)
  }
  try {
    // Re-read the tab: the write took a round trip, and it may have been closed
    // (or replaced) meanwhile.
    const live = state.tabs.find(item => item.id === (tab?.id ?? ''))
    if (target.mode === 'delete') {
      // The file is gone; a tab showing it would keep a buffer that cannot be
      // saved anywhere sensible.
      if (live !== undefined) closeTab(live.id)
    } else if (live !== undefined) {
      await reloadTab(live.id)
      await refreshChangeSet(live.id, resolved.origin)
    }
  } catch {
    // Deliberately swallowed: see above.
  }
  void api.changes.list(target.sessionId, true).catch(() => undefined)
  info(target.mode === 'delete' ? t('changes.deletedCreation') : t('changes.revertedFile'))
  return true
}

/**
 * Re-read one tab's change marks from the provenance recorded for it.
 *
 * Used after a successful save: typing invalidates the painted marks by design
 * (see `change-marks.ts`), and without this the file would keep its "positions
 * stale" badge until the user clicked the row again. A tab nobody attached marks
 * to has no provenance, so this is a no-op for every file opened from the tree.
 */
function refreshChangeSetForTab(tabId: string): void {
  const origin = changeOriginForTab(tabId)
  if (origin === undefined) return
  void refreshChangeSet(tabId, origin)
}

/** Mount-time hook: boot the store for a given ctx. */
export function useBootstrap(ctx: Context): void {
  useEffect(() => {
    bootstrap(ctx)
  }, [ctx])
}
