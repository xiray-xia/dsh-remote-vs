/**
 * History view: the commit graph with branch lanes and merge curves (lane
 * layout ported from the previous Git view), plus click-to-expand changed
 * files and a per-file diff of that commit.
 *
 * Loading is a SINGLE capped call (`api.git.log(..., GIT_LOG_MAX)`); a deep
 * repository shows the newest GIT_LOG_MAX commits and is filtered client-side.
 * The docstring here used to promise scroll-triggered paging that does not
 * exist, which is worse than no comment: a reader trusts it.
 *
 * Each repository's last answer is kept in memory (`./panel-cache.ts`), so a
 * switch back to a workspace repaints its commit list at once and the log is
 * re-read behind it — the tab used to blank on every switch, and worse, kept the
 * PREVIOUS repository's rows until the new log arrived.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { GitCommit, GitCommitFile } from '../../protocol.ts'
import { GIT_LOG_MAX } from '../../git-format.ts'
import { api } from '../api.ts'
import { gitReadSettleMs, useExplorer } from '../store.tsx'
import { checkoutCommit, loadCommitFiles } from './actions.ts'
import { ReadQueue } from './read-queue.ts'
import { readHistorySnapshot, repoCacheKey, writeHistorySnapshot } from './panel-cache.ts'
import {
  IconButton,
  IconChevronDown,
  IconChevronRight,
  IconRefresh,
  MiniSpinner,
  confirmDialog,
  FileIcon,
  gitStatusClass,
  relTime,
  toast,
} from '../vsc/kit.tsx'

const ROW_H = 22
const LANE_W = 13
const PAD_X = 9
const LANE_COLORS = ['#e2b714', '#4ec9b0', '#58a6ff', '#d2a8ff', '#ff7b72', '#79c0ff', '#7ee787', '#ffa657']

/**
 * One log read per repository at a time.
 *
 * Same contracts as the git status queue (`./read-queue.ts`): the automatic
 * read on entering the tab `join`s one in flight, and the ⟳ button asks for a
 * `fresh` one. Without it, flipping tabs while a log read runs could start a
 * second `git log` of the same repository and let the slower answer repaint.
 */
const logReads = new ReadQueue()

/**
 * Ref badge decoration for one `%D` entry. Extracted from a pair of nested
 * ternaries (forbidden by this project's review checklist) that were doing two
 * different jobs — CSS modifier and display text — inside one JSX expression.
 */
function refBadgeClass(ref: string): string {
  if (ref.startsWith('HEAD ->')) return ' head'
  if (ref.startsWith('tag:')) return ' tag'
  return ''
}

function refBadgeLabel(ref: string): string {
  if (ref.startsWith('HEAD -> ')) return ref.slice('HEAD -> '.length)
  return ref.replace(/^tag: /, '')
}

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
  const [expanded, setExpanded] = useState<string | undefined>(undefined)
  const [files, setFiles] = useState<Record<string, GitCommitFile[]>>({})
  const [filter, setFilter] = useState('')
  const head = store.head?.branch ?? ''
  /**
   * Ticket for the log request. The panel stays mounted across binding
   * switches, so two `git log` calls can overlap; without this the slower one
   * lands last and the tab lists the OTHER workspace's commits, with checkout
   * buttons that act on the currently bound repository.
   */
  const loadSeq = useRef(0)

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

  const visible = useMemo(() => {
    if (filter.trim() === '') return rows
    const needle = filter.trim().toLowerCase()
    return rows.filter(commit =>
      commit.subject.toLowerCase().includes(needle)
      || commit.author.toLowerCase().includes(needle)
      || commit.hash.startsWith(needle))
  }, [rows, filter])

  const graph = useMemo(() => layoutLanes(visible), [visible])

  const toggleCommit = async (hash: string): Promise<void> => {
    if (expanded === hash) {
      setExpanded(undefined)
      return
    }
    setExpanded(hash)
    if (files[hash] !== undefined || repoRoot === undefined) return
    try {
      const rows = await loadCommitFiles(alias, repoRoot, hash)
      setFiles(prev => ({ ...prev, [hash]: rows }))
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), true)
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
          value={filter}
          spellCheck={false}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {error !== undefined && <div className="rvs-banner error">{error}</div>}
      <div className="rvs-scroll">
        {loading && rows.length === 0 && <div className="rvs-empty"><MiniSpinner /> {t('common.loading')}</div>}
        {!loading && rows.length === 0 && error === undefined && <div className="rvs-empty">{t('scm.logEmpty')}</div>}
        {graph.rows.map((row, index) => {
          const commit = row.commit
          const isOpen = expanded === commit.hash
          const changed = files[commit.hash]
          return (
            <div key={commit.hash}>
              <button
                type="button"
                className={`rvs-commit-item${isOpen ? ' selected' : ''}`}
                title={`${commit.hash}\n${commit.author} <${commit.email}>\n${commit.subject}`}
                onClick={() => { void toggleCommit(commit.hash) }}
              >
                <span className="rvs-node-icon" style={{ width: 12 }}>
                  {isOpen ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
                </span>
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
              {isOpen && (
                <div className="rvs-detail">
                  <div className="rvs-detail-meta">
                    {commit.author} &lt;{commit.email}&gt; · {relTime(commit.date, lang)} · {commit.hash.slice(0, 10)}
                  </div>
                  {changed === undefined
                    ? <div className="rvs-empty" style={{ padding: 8 }}><MiniSpinner /> {t('common.loading')}</div>
                    : changed.length === 0
                      ? <div className="rvs-empty" style={{ padding: 8 }}>{t('scm.logEmpty')}</div>
                      : changed.slice(0, 200).map(file => (
                        <div
                          key={`${file.status}:${file.path}`}
                          className="rvs-file-row"
                          title={file.origPath === undefined ? file.path : `${file.origPath} → ${file.path}`}
                          onClick={() => { store.openCommitFile(commit.hash, file.path) }}
                        >
                          <span className="rvs-node-icon"><FileIcon path={file.path} size={13} /></span>
                          <span className="rvs-file-path">
                            {file.origPath === undefined ? file.path : `${file.origPath} → ${file.path}`}
                          </span>
                          <span className={`rvs-file-status rvs-letter-${gitStatusClass(file.status)}`}>{file.status[0]}</span>
                        </div>
                      ))}
                  <div className="rvs-commit-row">
                    <button
                      type="button"
                      className="rvs-chip"
                      onClick={() => {
                        void (async () => {
                          const ok = await confirmDialog({
                            title: t('scm.checkoutCommitTitle'),
                            text: t('scm.checkoutCommitText').replace('{hash}', commit.hash.slice(0, 10)),
                            okText: t('scm.checkout'),
                          })
                          if (!ok || repoRoot === undefined) return
                          try {
                            await checkoutCommit(alias, repoRoot, commit.hash)
                            await store.afterWrite()
                            toast(t('scm.checkedOut'))
                          } catch (caught) {
                            toast(caught instanceof Error ? caught.message : String(caught), true)
                          }
                        })()
                      }}
                    >
                      {t('scm.checkout')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
        {visible.length >= GIT_LOG_MAX && (
          <div className="rvs-empty">{t('scm.logCapped').replace('{n}', String(GIT_LOG_MAX))}</div>
        )}
      </div>
    </div>
  )
}
