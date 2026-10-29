/**
 * History view: the commit graph with branch lanes and merge curves (lane
 * layout ported from the previous Git view), plus a COMMIT PANE below it —
 * the selected commit's 提交详情 / 内容 / 差异 tabs (see `./CommitPane.tsx`).
 *
 * The pane replaced the old per-row inline expansion: a commit is a subject
 * with three answers, not a disclosure widget, and the pane keeps the graph
 * readable while one commit is open. Clicking a row selects (the pane opens on
 * 提交详情), clicking a changed file shows its patch in 差异, and a commit's
 * per-file two-sided diff still opens in the editor through `openCommitFile`.
 *
 * Loading is a SINGLE capped call (`api.git.log(..., GIT_LOG_MAX)`); a deep
 * repository shows the newest GIT_LOG_MAX commits and is filtered client-side.
 *
 * Each repository's last answer is kept in memory (`./panel-cache.ts`), so a
 * switch back to a workspace repaints its commit list at once and the log is
 * re-read behind it — the tab used to blank on every switch, and worse, kept the
 * PREVIOUS repository's rows until the new log arrived.
 *
 * Per-commit reads are cached separately (message + files, and the lazy patch),
 * keyed by repository AND hash, so switching repositories can never show one
 * host's commit body under another host's graph.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { GitCommit, GitCommitFile } from '../../protocol.ts'
import { GIT_LOG_MAX } from '../../git-format.ts'
import { api } from '../api.ts'
import { gitReadSettleMs, useExplorer } from '../store.tsx'
import { checkoutCommit, joinRemote, loadCommitFiles, loadCommitMessage, loadCommitPatch } from './actions.ts'
import { CommitPane } from './CommitPane.tsx'
import { isHistoryTab, needsPatchLoad, refBadgeClass, refBadgeLabel, type HistoryTab } from './commit-model.ts'
import { ReadQueue } from './read-queue.ts'
import { readHistorySnapshot, repoCacheKey, writeHistorySnapshot } from './panel-cache.ts'
import {
  ContextMenu,
  IconButton,
  IconRefresh,
  MiniSpinner,
  confirmDialog,
  copyText,
  relTime,
  toast,
  useContextMenu,
} from '../vsc/kit.tsx'

const ROW_H = 22
const LANE_W = 13
const PAD_X = 9
const LANE_COLORS = ['#e2b714', '#4ec9b0', '#58a6ff', '#d2a8ff', '#ff7b72', '#79c0ff', '#7ee787', '#ffa657']

/** Persisted pane geometry / view: one profile-wide preference, like the split. */
const PANE_HEIGHT_KEY = 'dsh-remote-vs.historyPane'
const PANE_TAB_KEY = 'dsh-remote-vs.historyTab'
const PANE_MIN_HEIGHT = 180

/**
 * Restore a persisted height, clamped to THIS window.
 *
 * A height saved on a tall window was previously replayed verbatim on a short
 * one, and the percentage `max-height` in CSS can be powerless when the flex
 * column's height is indefinite — the graph then collapsed to nothing. Clamp
 * against the viewport at read time (the drag path clamps against the column).
 */
function readPaneHeight(): number {
  try {
    const saved = Number(localStorage.getItem(PANE_HEIGHT_KEY))
    const viewportCap = typeof window === 'undefined'
      ? 900
      : Math.round(window.innerHeight * 0.7)
    const cap = Math.max(PANE_MIN_HEIGHT, viewportCap)
    if (Number.isFinite(saved) && saved >= PANE_MIN_HEIGHT) return Math.round(Math.min(saved, cap))
  } catch {
    // Ignore.
  }
  return 300
}

function readPaneTab(): HistoryTab | undefined {
  try {
    const saved = localStorage.getItem(PANE_TAB_KEY)
    if (isHistoryTab(saved)) return saved
  } catch {
    // Ignore.
  }
  return undefined
}

/** Bounded cache insert (Map keeps insertion order: the first key is oldest). */
function cacheSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.set(key, value)
  while (map.size > max) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The tab strip's choice plus whether the USER made it (first click lands on 提交详情). */
interface TabChoice {
  id: HistoryTab
  touched: boolean
}

/**
 * One log read per repository at a time.
 *
 * Same contracts as the git status queue (`./read-queue.ts`): the automatic
 * read on entering the tab `join`s one in flight, and the ⟳ button asks for a
 * `fresh` one. Without it, flipping tabs while a log read runs could start a
 * second `git log` of the same repository and let the slower answer repaint.
 */
const logReads = new ReadQueue()

interface GraphRow {
  commit: GitCommit
  lane: number
  before: (string | null)[]
  after: (string | null)[]
  merges: { lane: number; fresh: boolean }[]
  cleared: number[]
}

/** Assign one lane per commit line; extra parents open or ride lanes. */
function layoutLanes(commits: GitCommit[]): { rows: GraphRow[]; laneCount: number } {
  const lanes: (string | null)[] = []
  const rows: GraphRow[] = []
  for (const commit of commits) {
    let i = lanes.indexOf(commit.hash)
    if (i === -1) {
      const free = lanes.indexOf(null)
      if (free === -1) {
        lanes.push(commit.hash)
        i = lanes.length - 1
      } else {
        lanes[free] = commit.hash
        i = free
      }
    }
    const before = [...lanes]
    const merges: GraphRow['merges'] = []
    const cleared: number[] = []
    const parents = commit.parents
    if (parents.length === 0) {
      lanes[i] = null
    } else {
      lanes[i] = parents[0] as string
      for (let k = 0; k < lanes.length; k++) {
        if (k !== i && lanes[k] === parents[0]) {
          lanes[k] = null
          cleared.push(k)
        }
      }
      for (let p = 1; p < parents.length; p++) {
        const parentHash = parents[p] as string
        const j = lanes.indexOf(parentHash)
        if (j === -1) {
          const free = lanes.indexOf(null)
          if (free === -1) {
            lanes.push(parentHash)
            merges.push({ lane: lanes.length - 1, fresh: true })
          } else {
            lanes[free] = parentHash
            merges.push({ lane: free, fresh: true })
          }
        } else {
          merges.push({ lane: j, fresh: false })
        }
      }
    }
    rows.push({ commit, lane: i, before, after: [...lanes], merges, cleared })
  }
  let used = 1
  for (const row of rows) {
    used = Math.max(used, row.lane + 1)
    row.before.forEach((hash, j) => { if (hash !== null) used = Math.max(used, j + 1) })
    row.after.forEach((hash, j) => { if (hash !== null) used = Math.max(used, j + 1) })
    for (const merge of row.merges) used = Math.max(used, merge.lane + 1)
  }
  return { rows, laneCount: used }
}

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length] as string
}

/** A stable empty list: the "this repository was never read" fallback. */
const EMPTY_COMMITS: GitCommit[] = []

/** What one commit's lazy detail reads produced (keyed by repo + hash). */
interface CommitDetail {
  /** The `${repoKey}|${hash}` the values belong to. */
  key: string
  body: string
  files?: GitCommitFile[]
  filesError?: string
}

interface CommitPatchState {
  key: string
  text?: string
  /** The remote read hit the byte cap (the pane says so). */
  truncated?: boolean
  error?: string
}

export function HistoryPanel(): ReactNode {
  const store = useExplorer()
  const { t, lang, alias, repoRoot } = store
  const [commits, setCommits] = useState<GitCommit[]>([])
  /**
   * The repository `commits` belongs to.
   *
   * A state update lands one paint AFTER the repository changes, so without this
   * key the first frame after a switch would still show the PREVIOUS repository's
   * rows — whose checkout buttons would then point those hashes at the new
   * repository. The render-time arbitration below (`rows`) closes that frame.
   */
  const [commitsKey, setCommitsKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [filter, setFilter] = useState('')
  const [selectedHash, setSelectedHash] = useState<string | undefined>(undefined)
  const [focusPath, setFocusPath] = useState<string | undefined>(undefined)
  const [tabChoice, setTabChoice] = useState<TabChoice>(() => {
    const saved = readPaneTab()
    return { id: saved ?? 'details', touched: saved !== undefined }
  })
  const [paneHeight, setPaneHeight] = useState<number>(readPaneHeight)
  const [dragging, setDragging] = useState(false)
  /** Full-height mode: the graph makes room and the pane takes the panel. */
  const [paneExpanded, setPaneExpanded] = useState(false)
  const commitMenu = useContextMenu()
  const [detail, setDetail] = useState<CommitDetail>({ key: '', body: '' })
  const [patchState, setPatchState] = useState<CommitPatchState>({ key: '' })
  const [reloadSeq, setReloadSeq] = useState(0)
  /** The patch read for `detailKey` (a ref: it must not re-render on its own). */
  const patchFlight = useRef<string | undefined>(undefined)
  /** Monotonic ticket: only the LATEST read may paint (older ones only cache). */
  const patchTicket = useRef(0)
  /** Bumped after every patch settle so the lazy effect re-evaluates once. */
  const [patchTick, setPatchTick] = useState(0)
  const head = store.head?.branch ?? ''
  /**
   * Ticket for the log request. The panel stays mounted across binding
   * switches, so two `git log` calls can overlap; without this the slower one
   * lands last and the tab lists the OTHER workspace's commits, with checkout
   * buttons that act on the currently bound repository.
   */
  const loadSeq = useRef(0)
  /** Per-commit caches: message+files (bounded 20) and patch text+cap flag (bounded 4). */
  const detailCache = useRef(new Map<string, { body: string; files: GitCommitFile[] }>())
  const patchCache = useRef(new Map<string, { text: string; truncated: boolean }>())
  /** The commit object behind `selectedHash`, kept while the log no longer lists it. */
  const [selectedSnapshot, setSelectedSnapshot] = useState<GitCommit | undefined>(undefined)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startY: number; startHeight: number } | undefined>(undefined)
  const paneHeightRef = useRef(paneHeight)

  const repoKey = alias === '' || repoRoot === undefined ? '' : repoCacheKey(alias, repoRoot)
  /** The cached log of the repository being shown, when it was read before. */
  const cachedCommits = useMemo(
    () => (repoKey === '' ? undefined : readHistorySnapshot(repoKey)?.commits),
    [repoKey],
  )
  /** What THIS frame may show: rows of this repository, or none. */
  const rows = commitsKey === repoKey ? commits : (cachedCommits ?? EMPTY_COMMITS)

  const load = useCallback(async (mode: 'join' | 'fresh' = 'join'): Promise<void> => {
    if (alias === '' || repoRoot === undefined) {
      loadSeq.current += 1
      setCommitsKey('')
      setCommits(EMPTY_COMMITS)
      setLoading(false)
      return
    }
    const key = repoCacheKey(alias, repoRoot)
    const ticket = ++loadSeq.current
    // The cached log of THIS repository (when it was read before) replaces the
    // rows at once, so a switch back is instant instead of a blank tab; a
    // repository never read gets an empty list, never the previous one's.
    const cached = readHistorySnapshot(key)
    setCommitsKey(key)
    setCommits(cached?.commits ?? EMPTY_COMMITS)
    setLoading(true)
    setError(undefined)
    try {
      const list = await logReads.run(key, () => api.git.log(alias, repoRoot, GIT_LOG_MAX), mode, gitReadSettleMs())
      writeHistorySnapshot(key, { commits: list, at: Date.now() })
      if (loadSeq.current !== ticket) return
      setCommitsKey(key)
      setCommits(list)
    } catch (caught) {
      if (loadSeq.current !== ticket) return
      // A failed re-read keeps what is on screen (it was a real read) and says
      // why: blanking the tab would hide that anything went wrong.
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (loadSeq.current === ticket) setLoading(false)
    }
  }, [alias, repoRoot])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * The selected commit as the graph currently knows it, falling back to the
   * snapshot taken at selection time. Without the fallback a `git log` refresh
   * that drops the hash from the capped window silently unmounted the pane (the
   * commit was still cached and perfectly readable).
   */
  const selectedCommit = useMemo(() => {
    if (selectedHash === undefined) return undefined
    const live = rows.find(commit => commit.hash === selectedHash)
    if (live !== undefined) return live
    return selectedSnapshot !== undefined && selectedSnapshot.hash === selectedHash ? selectedSnapshot : undefined
  }, [rows, selectedHash, selectedSnapshot])
  /** Cache key of the selected commit ('' = nothing selected / no binding). */
  const detailKey = selectedCommit === undefined || repoKey === '' ? '' : `${repoKey}|${selectedCommit.hash}`

  // A repository switch drops the selection: the hash belongs to the old graph.
  useEffect(() => {
    setSelectedHash(undefined)
    setFocusPath(undefined)
  }, [repoKey])

  // Message + file list: what 提交详情 and 内容 need. The patch is NOT read here
  // (see the lazy effect below), so clicking through commits stays cheap.
  useEffect(() => {
    if (detailKey === '' || selectedCommit === undefined || alias === '' || repoRoot === undefined) {
      setDetail({ key: '', body: '' })
      return
    }
    const cached = detailCache.current.get(detailKey)
    if (cached !== undefined) {
      setDetail({ key: detailKey, body: cached.body, files: cached.files })
      return
    }
    let cancelled = false
    setDetail({ key: detailKey, body: '' })
    void (async () => {
      const [message, files] = await Promise.allSettled([
        loadCommitMessage(alias, repoRoot, selectedCommit.hash),
        loadCommitFiles(alias, repoRoot, selectedCommit.hash),
      ])
      if (cancelled) return
      const body = message.status === 'fulfilled' ? message.value.body : ''
      const fileRows = files.status === 'fulfilled' ? files.value : undefined
      const filesError = files.status === 'rejected' ? errorText(files.reason) : undefined
      if (fileRows !== undefined) cacheSet(detailCache.current, detailKey, { body, files: fileRows }, 20)
      setDetail({ key: detailKey, body, files: fileRows, filesError })
    })()
    return () => { cancelled = true }
  }, [detailKey, alias, repoRoot, selectedCommit, reloadSeq])

  // The patch is read only while 差异 is on screen, and cached per commit: a
  // reader of 提交详情 never pays a `git show --patch` round trip.
  //
  // `needsPatchLoad` (not `patchState.key === detailKey`) is the guard: a
  // superseded read used to leave the key marker WITHOUT data, and the old
  // equality check then treated that marker as "loaded" forever — the diff
  // stayed empty with "这个提交没有改动文件" after any quick tab/commit flip.
  // A request ticket (not a cleanup-cancelled promise) is what lets a read that
  // finishes after the tab moved on still fill the cache, while a superseded
  // selection can never paint its answer.
  useEffect(() => {
    if (selectedCommit === undefined || alias === '' || repoRoot === undefined) return
    if (!needsPatchLoad(patchState, detailKey, tabChoice.id)) return
    const cached = patchCache.current.get(detailKey)
    if (cached !== undefined) {
      // The cap flag travels WITH the text: a cache hit used to restore the
      // cut patch without its "truncated" notice (silent truncation again).
      setPatchState({ key: detailKey, text: cached.text, truncated: cached.truncated })
      return
    }
    if (patchFlight.current === detailKey) return
    const ticket = ++patchTicket.current
    patchFlight.current = detailKey
    setPatchState({ key: detailKey })
    void (async () => {
      try {
        const result = await loadCommitPatch(alias, repoRoot, selectedCommit.hash)
        cacheSet(patchCache.current, detailKey, { text: result.text, truncated: result.truncated }, 4)
        if (patchTicket.current !== ticket) return
        setPatchState({ key: detailKey, text: result.text, truncated: result.truncated })
      } catch (caught) {
        if (patchTicket.current !== ticket) return
        setPatchState({ key: detailKey, error: errorText(caught) })
      } finally {
        if (patchFlight.current === detailKey) patchFlight.current = undefined
        // Re-arm the effect after every settle: a superseded run must not leave
        // the CURRENT view on an empty marker with nothing scheduled.
        setPatchTick(value => value + 1)
      }
    })()
  }, [tabChoice.id, detailKey, alias, repoRoot, selectedCommit, patchState, reloadSeq, patchTick])

  const visible = useMemo(() => {
    if (filter.trim() === '') return rows
    const needle = filter.trim().toLowerCase()
    return rows.filter(commit =>
      commit.subject.toLowerCase().includes(needle)
      || commit.author.toLowerCase().includes(needle)
      || commit.hash.startsWith(needle))
  }, [rows, filter])

  const graph = useMemo(() => layoutLanes(visible), [visible])

  const selectCommit = (hash: string): void => {
    setSelectedHash(hash)
    setSelectedSnapshot(rows.find(commit => commit.hash === hash))
    setFocusPath(undefined)
    // The FIRST selection of a panel life lands on 提交详情; once the user has
    // picked a tab by hand (or restored one), selection keeps it.
    if (!tabChoice.touched) setTabChoice({ id: 'details', touched: false })
  }

  const chooseTab = useCallback((next: HistoryTab): void => {
    setTabChoice({ id: next, touched: true })
    try {
      localStorage.setItem(PANE_TAB_KEY, next)
    } catch {
      // Ignore.
    }
  }, [])

  const focusCommitFile = (path: string): void => {
    setFocusPath(path)
    chooseTab('diff')
  }

  const openCommitFile = (path: string, origPath?: string): void => {
    if (selectedCommit === undefined) return
    store.openCommitFile(selectedCommit.hash, path, origPath)
  }

  /** Remote directory of a repo-relative commit path ('' = repository root). */
  const commitFileDir = (path: string): string => {
    const slash = path.lastIndexOf('/')
    const dir = slash < 0 ? '' : path.slice(0, slash)
    return joinRemote(repoRoot ?? '', dir)
  }

  /** Right-click menu: show the changed file's folder in the explorer tree. */
  const revealCommitFile = (path: string): void => {
    if (repoRoot === undefined) return
    store.revealInExplorer(commitFileDir(path))
  }

  /** Right-click menu: a terminal tab that starts in the changed file's folder. */
  const openCommitFileTerminal = (path: string): void => {
    if (repoRoot === undefined) return
    store.openTerminalAt(commitFileDir(path))
  }

  /** Copy-absolute: repo-relative commit path → remote absolute path. */
  const commitFileAbsPath = (path: string): string => joinRemote(repoRoot ?? '', path)

  const closePane = (): void => {
    setSelectedHash(undefined)
    setSelectedSnapshot(undefined)
    setFocusPath(undefined)
    setPaneExpanded(false)
  }

  /** Up/Down move the graph selection (the list handles its own keys). */
  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    if (visible.length === 0) return
    event.preventDefault()
    const current = selectedHash === undefined ? -1 : visible.findIndex(commit => commit.hash === selectedHash)
    const direction = event.key === 'ArrowDown' ? 1 : -1
    let next: number
    if (current < 0) next = direction === 1 ? 0 : visible.length - 1
    else next = Math.min(visible.length - 1, Math.max(0, current + direction))
    const commit = visible[next]
    if (commit === undefined) return
    selectCommit(commit.hash)
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-hash="${commit.hash}"]`)?.focus()
  }

  /** Graph context menu: the commit actions that do not need the pane open. */
  const openCommitMenu = (event: React.MouseEvent, commit: GitCommit): void => {
    event.preventDefault()
    event.stopPropagation()
    if (commit.hash !== selectedHash) selectCommit(commit.hash)
    commitMenu.open(event.clientX, event.clientY, [
      {
        label: t('history.copyHash'),
        onSelect: () => { void copyText(commit.hash).then(() => toast(t('history.copiedHash'))) },
      },
      {
        label: t('history.copySubject'),
        onSelect: () => { void copyText(commit.subject).then(() => toast(t('history.copiedSubject'))) },
      },
      {
        label: t('scm.checkout'),
        separated: true,
        onSelect: () => { void checkoutCommitFlow(commit) },
      },
    ])
  }

  /** Drop the caches of the selected commit and re-read what the pane shows. */
  const reloadSelected = (): void => {
    if (detailKey !== '') {
      detailCache.current.delete(detailKey)
      patchCache.current.delete(detailKey)
    }
    setDetail({ key: '', body: '' })
    setPatchState({ key: '' })
    setReloadSeq(value => value + 1)
  }

  const checkoutCommitFlow = (commit: GitCommit): void => {
    if (repoRoot === undefined) return
    void (async () => {
      const ok = await confirmDialog({
        title: t('scm.checkoutCommitTitle'),
        text: t('scm.checkoutCommitText').replace('{hash}', commit.hash.slice(0, 10)),
        okText: t('scm.checkout'),
      })
      if (!ok) return
      try {
        await checkoutCommit(alias, repoRoot, commit.hash)
        await store.afterWrite()
        toast(t('scm.checkedOut'))
      } catch (caught) {
        toast(errorText(caught), true)
      }
    })()
  }

  const checkoutSelected = (): void => {
    if (selectedCommit !== undefined) checkoutCommitFlow(selectedCommit)
  }

  // ── Pane splitter: drag up grows the pane (same gesture as the editor split;
  //    the handle reuses `.rvs-vsplit-handle`'s row-resize styling). ─────────
  /**
   * The RENDERED height, not the persisted one: CSS caps the pane at 82% of
   * the column, so a height saved on a tall window is painted smaller than
   * `paneHeightRef` claims — seeding the drag from the persisted number made the
   * first part of every drag do nothing.
   */
  const renderedPaneHeight = (): number => {
    const element = containerRef.current?.querySelector<HTMLElement>('.rvs-hpane')
    return element?.offsetHeight ?? paneHeightRef.current
  }
  const onPaneDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Older engine: the button gate covers it.
    }
    const startHeight = renderedPaneHeight()
    paneHeightRef.current = startHeight
    dragRef.current = { startY: event.clientY, startHeight }
    setDragging(true)
  }
  const onPaneMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === undefined) return
    if ((event.buttons & 1) === 0) {
      dragRef.current = undefined
      setDragging(false)
      return
    }
    const total = containerRef.current?.clientHeight ?? 0
    if (total < 220) return
    const max = Math.max(PANE_MIN_HEIGHT + 60, total * 0.82)
    const next = Math.round(Math.max(PANE_MIN_HEIGHT, Math.min(max, drag.startHeight + (drag.startY - event.clientY))))
    paneHeightRef.current = next
    setPaneHeight(next)
  }
  const onPaneEnd = (): void => {
    if (dragRef.current === undefined) return
    dragRef.current = undefined
    setDragging(false)
    try {
      localStorage.setItem(PANE_HEIGHT_KEY, String(paneHeightRef.current))
    } catch {
      // Ignore.
    }
  }
  /** Keyboard resize (the splitter is a focusable separator): ↑ grows, ↓ shrinks. */
  const onPaneKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const total = containerRef.current?.clientHeight ?? 0
    const base = renderedPaneHeight()
    paneHeightRef.current = base
    const max = total < 220 ? base : Math.max(PANE_MIN_HEIGHT + 60, total * 0.82)
    const delta = event.key === 'ArrowUp' ? 24 : -24
    const next = Math.round(Math.max(PANE_MIN_HEIGHT, Math.min(max, base + delta)))
    paneHeightRef.current = next
    setPaneHeight(next)
    try {
      localStorage.setItem(PANE_HEIGHT_KEY, String(next))
    } catch {
      // Ignore.
    }
  }

  const x = (lane: number): number => PAD_X + lane * LANE_W
  const y = (row: number): number => row * ROW_H + ROW_H / 2

  return (
    <div className="rvs-pane grow">
      <div className="rvs-header">
        <span className="rvs-title">{t('tab.history')}</span>
        {head !== '' && <span className="rvs-pill">⑂ {store.head?.detached === true ? t('scm.detached') : head}</span>}
        {loading && <MiniSpinner />}
        <IconButton title={t('scm.refresh')} onClick={() => { void load('fresh') }} disabled={loading}>
          <IconRefresh size={14} />
        </IconButton>
      </div>
      <div className="rvs-search-row">
        <input
          className="rvs-input"
          placeholder={t('history.filter')}
          aria-label={t('history.filter')}
          value={filter}
          spellCheck={false}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {error !== undefined && <div className="rvs-banner error">{error}</div>}
      <div className="rvs-history-body" ref={containerRef}>
        <div className="rvs-scroll" hidden={paneExpanded} onKeyDown={onListKeyDown}>
          {loading && rows.length === 0 && <div className="rvs-empty"><MiniSpinner /> {t('common.loading')}</div>}
          {!loading && rows.length === 0 && error === undefined && <div className="rvs-empty">{t('scm.logEmpty')}</div>}
          {graph.rows.map((row, index) => {
            const commit = row.commit
            const isSelected = commit.hash === selectedHash
            return (
              <button
                key={commit.hash}
                type="button"
                data-hash={commit.hash}
                className={`rvs-commit-item${isSelected ? ' selected' : ''}`}
                title={`${commit.hash}\n${commit.author} <${commit.email}>\n${commit.subject}`}
                aria-current={isSelected ? 'true' : undefined}
                onClick={() => selectCommit(commit.hash)}
                onContextMenu={(event) => { openCommitMenu(event, commit) }}
              >
                <svg className="rvs-graph-svg" width={PAD_X * 2 + (graph.laneCount - 1) * LANE_W} height={ROW_H}>
                  {row.before.map((hash, lane) => {
                    const after = row.after[lane] ?? null
                    if (hash === null || after === null || hash !== after) return null
                    return (
                      <line
                        key={`v${lane}`}
                        x1={x(lane)}
                        y1={y(index) - ROW_H / 2}
                        x2={x(lane)}
                        y2={y(index) + ROW_H / 2}
                        stroke={laneColor(lane)}
                        strokeWidth="2"
                      />
                    )
                  })}
                  {index > 0 && row.before[row.lane] != null && (
                    <line x1={x(row.lane)} y1={y(index) - ROW_H / 2} x2={x(row.lane)} y2={y(index)} stroke={laneColor(row.lane)} strokeWidth="2" />
                  )}
                  {row.after[row.lane] != null && (
                    <line x1={x(row.lane)} y1={y(index)} x2={x(row.lane)} y2={y(index) + ROW_H / 2} stroke={laneColor(row.lane)} strokeWidth="2" />
                  )}
                  {row.cleared.map(lane => (
                    <path
                      key={`c${lane}`}
                      d={`M ${x(lane)} ${y(index) - ROW_H / 2} Q ${x(lane)} ${y(index)} ${x(row.lane)} ${y(index)}`}
                      fill="none"
                      stroke={laneColor(lane)}
                      strokeWidth="2"
                    />
                  ))}
                  {row.merges.map(merge => (
                    <path
                      key={`m${merge.lane}`}
                      d={merge.fresh
                        ? `M ${x(row.lane)} ${y(index)} Q ${x(row.lane)} ${y(index) + ROW_H / 2} ${x(merge.lane)} ${y(index) + ROW_H / 2}`
                        : `M ${x(row.lane)} ${y(index)} Q ${(x(row.lane) + x(merge.lane)) / 2} ${y(index) + 9} ${x(merge.lane)} ${y(index)}`}
                      fill="none"
                      stroke={laneColor(merge.lane)}
                      strokeWidth="2"
                    />
                  ))}
                  <circle cx={x(row.lane)} cy={y(index)} r="3.4" fill={laneColor(row.lane)} />
                </svg>
                {commit.refs.length > 0 && (
                  <span style={{ display: 'flex', gap: 3, flex: 'none' }}>
                    {commit.refs.slice(0, 2).map(ref => (
                      <span
                        key={ref}
                        className={`rvs-ref-badge${refBadgeClass(ref)}`}
                      >
                        {refBadgeLabel(ref)}
                      </span>
                    ))}
                  </span>
                )}
                <span className="rvs-commit-hash">{commit.hash.slice(0, 7)}</span>
                <span className="rvs-commit-msg">{commit.subject}</span>
                <span className="rvs-commit-date">{relTime(commit.date, lang)}</span>
              </button>
            )
          })}
          {visible.length >= GIT_LOG_MAX && (
            <div className="rvs-empty">{t('scm.logCapped').replace('{n}', String(GIT_LOG_MAX))}</div>
          )}
        </div>
        {selectedCommit !== undefined && (
          <>
            {paneExpanded ? null : (
              <div
                className="rvs-vsplit-handle"
                role="separator"
                aria-orientation="horizontal"
                aria-label={t('history.resizeHint')}
                aria-valuenow={paneHeight}
                tabIndex={0}
                data-dragging={dragging ? 'true' : 'false'}
                title={t('history.resizeHint')}
                onPointerDown={onPaneDown}
                onPointerMove={onPaneMove}
                onPointerUp={onPaneEnd}
                onPointerCancel={onPaneEnd}
                onKeyDown={onPaneKeyDown}
              />
            )}
            <div
              className={`rvs-hpane${paneExpanded ? ' expanded' : ''}`}
              style={paneExpanded ? undefined : { height: `${paneHeight}px` }}
            >
              <CommitPane
                commit={selectedCommit}
                tab={tabChoice.id}
                onTab={chooseTab}
                onClose={closePane}
                expanded={paneExpanded}
                onToggleExpand={() => { setPaneExpanded(value => !value) }}
                body={detail.key === detailKey ? detail.body : ''}
                files={detail.key === detailKey ? detail.files : undefined}
                filesError={detail.key === detailKey ? detail.filesError : undefined}
                patch={patchState.key === detailKey ? patchState.text : undefined}
                patchTruncated={patchState.key === detailKey && patchState.truncated === true}
                patchLoading={tabChoice.id === 'diff'
                  && (patchState.key !== detailKey || (patchState.text === undefined && patchState.error === undefined))}
                patchError={patchState.key === detailKey ? patchState.error : undefined}
                focusPath={focusPath}
                onFocusPath={focusCommitFile}
                onOpenFile={openCommitFile}
                onRevealFile={revealCommitFile}
                onOpenTerminal={openCommitFileTerminal}
                absPathOf={commitFileAbsPath}
                onCheckout={checkoutSelected}
                onReload={reloadSelected}
                t={t}
                lang={lang}
              />
            </div>
          </>
        )}
      </div>
      {commitMenu.menu !== undefined && (
        <ContextMenu
          x={commitMenu.menu.x}
          y={commitMenu.menu.y}
          entries={commitMenu.menu.entries}
          onClose={commitMenu.close}
        />
      )}
    </div>
  )
}
