/**
 * Git view: remote repo status + branch filter + SVG commit graph (lane
 * layout with merge curves) + commit detail. All data rides the exec route
 * (see git-format.ts); no host changes required.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { GitBranch, GitCommit, GitShow, GitStatus, RemoteWorkspaceBinding } from '../protocol.ts'
import { GIT_LOG_MAX } from '../git-format.ts'
import { RemoteApiError, api } from './api.ts'
import { Btn, Notice, Row, Spinner, optionStyle, selectStyle } from './ui.tsx'

function err(e: unknown): string {
  return e instanceof RemoteApiError ? e.message : String(e)
}

const WS_STORE = 'dsh-remote-vs.git.ws'
const ROW_H = 26
const LANE_W = 13
const PAD_X = 10
const LANE_COLORS = ['#4d6bfe', '#e8b84b', '#7ee2a8', '#e06c9f', '#41c4e0', '#b48cf2']

interface GraphRow {
  commit: GitCommit
  lane: number
  before: (string | null)[]
  after: (string | null)[]
  /** Extra-parent merge edges: target lane + whether the lane starts here. */
  merges: { lane: number; fresh: boolean }[]
  /** Lanes joining into the dot from above (first-parent dedupe). */
  cleared: number[]
}

/** Assign one lane per commit line; extra parents open/ride lanes. */
function layoutLanes(commits: GitCommit[]): { rows: GraphRow[]; laneCount: number } {
  const lanes: (string | null)[] = []
  const rows: GraphRow[] = []
  for (const c of commits) {
    let i = lanes.indexOf(c.hash)
    if (i === -1) {
      const free = lanes.indexOf(null)
      if (free === -1) {
        lanes.push(c.hash)
        i = lanes.length - 1
      } else {
        lanes[free] = c.hash
        i = free
      }
    }
    const before = [...lanes]
    const merges: GraphRow['merges'] = []
    const cleared: number[] = []
    const parents = c.parents
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
        const ph = parents[p] as string
        const j = lanes.indexOf(ph)
        if (j === -1) {
          const free = lanes.indexOf(null)
          let nj: number
          if (free === -1) {
            lanes.push(ph)
            nj = lanes.length - 1
          } else {
            lanes[free] = ph
            nj = free
          }
          merges.push({ lane: nj, fresh: true })
        } else {
          merges.push({ lane: j, fresh: false })
        }
      }
    }
    rows.push({ commit: c, lane: i, before, after: [...lanes], merges, cleared })
  }
  let laneCount = 1
  for (const r of rows) {
    laneCount = Math.max(laneCount, r.lane + 1, r.after.length, r.before.length)
    for (const m of r.merges) laneCount = Math.max(laneCount, m.lane + 1)
  }
  // Trim dead trailing lanes for width.
  let used = 0
  for (const r of rows) {
    used = Math.max(used, r.lane + 1)
    r.before.forEach((h, j) => { if (h !== null) used = Math.max(used, j + 1) })
    r.after.forEach((h, j) => { if (h !== null) used = Math.max(used, j + 1) })
    for (const m of r.merges) used = Math.max(used, m.lane + 1)
  }
  return { rows, laneCount: Math.max(1, used) }
}

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length] as string
}

function RefBadges(props: { refs: string[] }): ReactNode {
  if (props.refs.length === 0) return null
  return (
    <>
      {props.refs.map((ref) => {
        const isHead = ref.startsWith('HEAD -> ')
        const isTag = ref.startsWith('tag: ')
        const label = isHead ? ref.slice('HEAD -> '.length) : ref
        return (
          <span
            key={ref}
            style={{
              fontSize: 11,
              padding: '0 5px',
              borderRadius: 8,
              marginRight: 4,
              whiteSpace: 'nowrap',
              background: isHead ? 'rgba(77,107,254,.3)' : isTag ? 'rgba(232,184,75,.25)' : 'rgba(127,127,127,.2)',
              border: `1px solid ${isHead ? 'rgba(77,107,254,.7)' : 'rgba(127,127,127,.35)'}`,
            }}
          >
            {label}
          </span>
        )
      })}
    </>
  )
}

function formatDate(unixSeconds: number): string {
  if (unixSeconds <= 0) return ''
  const d = new Date(unixSeconds * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function GitView(props: { t: (k: string) => string; workspaces: RemoteWorkspaceBinding[] }): ReactNode {
  const t = props.t
  const [wsId, setWsId] = useState<string>(() => {
    try {
      return localStorage.getItem(WS_STORE) ?? ''
    } catch {
      return ''
    }
  })
  const [status, setStatus] = useState<GitStatus | undefined>(undefined)
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [filter, setFilter] = useState<string>('')
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [lanes, setLanes] = useState<{ rows: GraphRow[]; laneCount: number }>({ rows: [], laneCount: 1 })
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [detail, setDetail] = useState<GitShow | undefined>(undefined)
  const [detailLoading, setDetailLoading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const workspace = props.workspaces.find((w) => w.id === wsId) ?? props.workspaces[0]

  useEffect(() => {
    try {
      if (workspace !== undefined) localStorage.setItem(WS_STORE, workspace.id)
    } catch {
      // Ignore.
    }
  }, [workspace])

  const refresh = useCallback(() => {
    if (workspace === undefined) return
    setLoading(true)
    setError(undefined)
    setNotice(undefined)
    setSelected(undefined)
    setDetail(undefined)
    const { alias, remotePath } = workspace
    api.git.status(alias, remotePath).then(
      (st) => {
        setStatus(st)
        return Promise.all([
          api.git.branches(alias, remotePath, st.branch),
          api.git.log(alias, remotePath, GIT_LOG_MAX, filter !== '' ? filter : undefined),
        ])
      },
      (e: unknown) => {
        setLoading(false)
        setStatus(undefined)
        setBranches([])
        setCommits([])
        setLanes({ rows: [], laneCount: 1 })
        setError(err(e))
        return null
      },
    ).then((pair) => {
      if (pair === null) return
      const [br, log] = pair
      setLoading(false)
      setBranches(br)
      setCommits(log)
      setLanes(layoutLanes(log))
      if (log.length >= GIT_LOG_MAX) setNotice(`showing latest ${GIT_LOG_MAX} commits`)
    }, (e: unknown) => {
      setLoading(false)
      setError(err(e))
    })
  }, [workspace, filter])

  useEffect(() => {
    refresh()
  }, [refresh])

  const openDetail = (hash: string): void => {
    if (workspace === undefined) return
    if (selected === hash) {
      setSelected(undefined)
      setDetail(undefined)
      return
    }
    setSelected(hash)
    setDetail(undefined)
    setDetailLoading(true)
    api.git.show(workspace.alias, workspace.remotePath, hash).then(
      (d) => {
        setDetailLoading(false)
        setDetail(d)
      },
      (e: unknown) => {
        setDetailLoading(false)
        setError(err(e))
      },
    )
  }

  const x = (lane: number): number => PAD_X + lane * LANE_W
  const y = (row: number): number => row * ROW_H + ROW_H / 2

  if (workspace === undefined) {
    return <div style={{ opacity: 0.7 }}>{t('git.selectWorkspace')} —</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ flex: 'none' }}>
        <Row>
          <span style={{ fontSize: 12, opacity: 0.75 }}>{t('git.selectWorkspace')}</span>
          <select
            value={workspace.id}
            onChange={(e) => { setWsId(e.target.value); setFilter('') }}
            style={{ ...selectStyle, flex: 1 }}
          >
            {props.workspaces.map((w) => <option key={w.id} value={w.id} style={optionStyle}>{w.name} ({w.alias}:{w.remotePath})</option>)}
          </select>
          <Btn onClick={refresh} disabled={loading}>{loading ? <><Spinner /> {t('git.refresh')}</> : t('git.refresh')}</Btn>
        </Row>
        {notice !== undefined && <Notice kind="info">{notice}</Notice>}
        {error !== undefined && <Notice kind="error">{error}{'\n'}{t('git.hint')}</Notice>}
        {status !== undefined && (
          <div style={{ fontSize: 12, marginTop: 6, opacity: 0.9 }}>
            <span style={{ marginRight: 8 }}>⎇ <strong>{status.detached ? 'HEAD (detached)' : status.branch}</strong></span>
            {(status.ahead > 0 || status.behind > 0) && <span style={{ marginRight: 8 }}>↑{status.ahead} ↓{status.behind}</span>}
            <span style={{ marginRight: 8 }}>+{status.staged.length} ~{status.unstaged.length} ?{status.untracked.length}</span>
            {status.truncated && <span style={{ opacity: 0.6 }}>(truncated)</span>}
          </div>
        )}
        {branches.length > 0 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
            <button
              key=""
              type="button"
              onClick={() => setFilter('')}
              style={{
                fontSize: 12, padding: '1px 8px', borderRadius: 10, cursor: 'pointer', color: 'inherit',
                background: filter === '' ? 'rgba(77,107,254,.3)' : 'rgba(127,127,127,.12)',
                border: '1px solid rgba(127,127,127,.35)',
              }}
            >
              all
            </button>
            {branches.map((b) => (
              <button
                key={b.name}
                type="button"
                onClick={() => setFilter(filter === b.name ? '' : b.name)}
                title={b.upstream !== '' ? `↑ ${b.upstream} · ${b.short}` : b.short}
                style={{
                  fontSize: 12, padding: '1px 8px', borderRadius: 10, cursor: 'pointer', color: 'inherit',
                  background: filter === b.name ? 'rgba(77,107,254,.3)' : b.head ? 'rgba(77,107,254,.15)' : 'rgba(127,127,127,.12)',
                  border: `1px solid ${b.head ? 'rgba(77,107,254,.6)' : 'rgba(127,127,127,.35)'}`,
                }}
              >
                {b.head ? '● ' : ''}{b.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 120, overflow: 'auto', marginTop: 8, borderTop: '1px solid rgba(127,127,127,.25)', paddingTop: 4 }}>
        {loading && <div style={{ fontSize: 12, opacity: 0.7 }}>{t('common.loading')}</div>}
        {!loading && commits.length === 0 && error === undefined && (
          <div style={{ fontSize: 12, opacity: 0.7 }}>no commits</div>
        )}
        {lanes.rows.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'stretch' }}>
            <svg
              width={PAD_X * 2 + (lanes.laneCount - 1) * LANE_W}
              height={lanes.rows.length * ROW_H}
              style={{ flex: 'none', display: 'block' }}
            >
              {lanes.rows.map((row, r) => {
                const cy = y(r)
                const segs: ReactNode[] = []
                const before = row.before
                const after = row.after
                const width = Math.max(before.length, after.length)
                for (let j = 0; j < width; j++) {
                  const b = before[j] ?? null
                  const a = after[j] ?? null
                  if (b !== null && a !== null && b === a) {
                    segs.push(<line key={`v${r}-${j}`} x1={x(j)} y1={cy - ROW_H / 2} x2={x(j)} y2={cy + ROW_H / 2} stroke={laneColor(j)} strokeWidth={2} />)
                  }
                }
                if (r > 0 && before[row.lane] !== null && before[row.lane] !== undefined) {
                  segs.push(<line key={`i${r}`} x1={x(row.lane)} y1={cy - ROW_H / 2} x2={x(row.lane)} y2={cy} stroke={laneColor(row.lane)} strokeWidth={2} />)
                }
                if (after[row.lane] !== null && after[row.lane] !== undefined) {
                  segs.push(<line key={`o${r}`} x1={x(row.lane)} y1={cy} x2={x(row.lane)} y2={cy + ROW_H / 2} stroke={laneColor(row.lane)} strokeWidth={2} />)
                }
                for (const k of row.cleared) {
                  segs.push(
                    <path
                      key={`c${r}-${k}`}
                      d={`M ${x(k)} ${cy - ROW_H / 2} Q ${x(k)} ${cy} ${x(row.lane)} ${cy}`}
                      fill="none"
                      stroke={laneColor(k)}
                      strokeWidth={2}
                    />,
                  )
                }
                for (const m of row.merges) {
                  if (m.fresh) {
                    segs.push(
                      <path
                        key={`m${r}-${m.lane}`}
                        d={`M ${x(row.lane)} ${cy} Q ${x(row.lane)} ${cy + ROW_H / 2} ${x(m.lane)} ${cy + ROW_H / 2}`}
                        fill="none"
                        stroke={laneColor(m.lane)}
                        strokeWidth={2}
                      />,
                    )
                  } else {
                    const mx = (x(row.lane) + x(m.lane)) / 2
                    segs.push(
                      <path
                        key={`m${r}-${m.lane}`}
                        d={`M ${x(row.lane)} ${cy} Q ${mx} ${cy + 9} ${x(m.lane)} ${cy}`}
                        fill="none"
                        stroke={laneColor(m.lane)}
                        strokeWidth={2}
                      />,
                    )
                  }
                }
                segs.push(<circle key={`d${r}`} cx={x(row.lane)} cy={cy} r={3.6} fill={laneColor(row.lane)} stroke="rgba(0,0,0,.4)" strokeWidth={1} />)
                return <g key={r}>{segs}</g>
              })}
            </svg>
            <div style={{ flex: 1, minWidth: 0 }}>
              {lanes.rows.map((row, r) => {
                const c = row.commit
                const isSel = selected === c.hash
                return (
                  <div
                    key={c.hash}
                    onClick={() => openDetail(c.hash)}
                    title={`${c.hash}\n${c.author} <${c.email}>\n${formatDate(c.date)}`}
                    style={{
                      height: ROW_H,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      paddingRight: 6,
                      cursor: 'pointer',
                      fontSize: 12,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      background: isSel ? 'rgba(77,107,254,.2)' : r % 2 === 1 ? 'rgba(127,127,127,.06)' : undefined,
                      borderRadius: 4,
                    }}
                  >
                    <code style={{ opacity: 0.6, flex: 'none' }}>{c.hash.slice(0, 7)}</code>
                    <span style={{ flex: 'none' }}><RefBadges refs={c.refs} /></span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.subject}</span>
                    <span style={{ marginLeft: 'auto', opacity: 0.55, flex: 'none', fontSize: 11 }}>
                      {c.author} · {formatDate(c.date)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
      {(selected !== undefined || detailLoading) && (
        <div style={{ flex: 'none', maxHeight: '32%', overflow: 'auto', borderTop: '1px solid rgba(127,127,127,.25)', marginTop: 6, paddingTop: 6 }}>
          {detailLoading && <div style={{ fontSize: 12, opacity: 0.7 }}>{t('common.loading')}</div>}
          {detail !== undefined && (
            <>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{detail.subject}</div>
              <div style={{ fontSize: 11, opacity: 0.6 }}><code>{detail.hash}</code></div>
              {detail.body !== '' && (
                <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', margin: '6px 0' }}>{detail.body}</pre>
              )}
              <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.85, margin: 0 }}>{detail.stat}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}
