/**
 * Remote process table shown on the monitor page.
 *
 * One bounded snapshot per selected host, polled only while the monitor page and
 * the browser tab are both visible. Killing is always confirmed and always goes
 * through the Host route (which validates the PID against its own snapshot), so
 * the browser never builds a shell command from a process row.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RemoteHostSummary, RemoteProcess, RemoteProcessesResult } from '../protocol.ts'
import { api, RemoteApiError } from './api.ts'
import { IconButton, IconRefresh, MiniSpinner, confirmDialog, toast } from './vsc/kit.tsx'

export const PROCESS_POLL_MS = 5_000

type SortKey = 'cpu' | 'mem' | 'pid'

function formatElapsed(seconds: number | null, t: (key: string) => string): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return t('proc.unknown')
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${Math.max(1, minutes)}m`
}

function percent(value: number): string {
  return `${value.toFixed(1)}%`
}

function sortRows(rows: readonly RemoteProcess[], key: SortKey): RemoteProcess[] {
  const copy = [...rows]
  if (key === 'pid') copy.sort((left, right) => left.pid - right.pid)
  else {
    const field = key === 'cpu' ? 'cpuPercent' : 'memPercent'
    copy.sort((left, right) => right[field] - left[field] || left.pid - right.pid)
  }
  return copy
}

export function ProcessesSection(props: {
  t: (key: string) => string
  hosts: RemoteHostSummary[]
  aliases: string[]
  visible: boolean
  paused: boolean
  intervalMs: number
}): ReactNode {
  const t = props.t
  const [alias, setAlias] = useState(props.aliases[0] ?? '')
  const [expanded, setExpanded] = useState(false)
  const [result, setResult] = useState<RemoteProcessesResult | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [filter, setFilter] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('cpu')
  const [killing, setKilling] = useState<number | undefined>(undefined)
  const inFlight = useRef<Set<string>>(new Set())
  const aliasRef = useRef(alias)
  aliasRef.current = alias
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // The scope can change from "all hosts" to one host, or disappear entirely.
  useEffect(() => {
    if (props.aliases.includes(alias)) return
    setAlias(props.aliases[0] ?? '')
    setResult(undefined)
    setError(undefined)
  }, [props.aliases, alias])

  const load = useCallback(async (force = false): Promise<void> => {
    const requested = alias
    if (requested === '' || inFlight.current.has(requested)) return
    inFlight.current.add(requested)
    setLoading(true)
    try {
      const next = await api.processes(requested, force)
      // The user may have switched hosts while this request was in flight: an
      // old host's table must never paint under (or be killed from) the new one.
      if (!alive.current || requested !== aliasRef.current) return
      setResult(next)
      setError(next.error)
    } catch (caught) {
      if (!alive.current) return
      setError(
        caught instanceof RemoteApiError && caught.status === 404
          ? t('proc.hostTooOld')
          : caught instanceof RemoteApiError ? caught.message : String(caught),
      )
    } finally {
      inFlight.current.delete(requested)
      if (alive.current && requested === aliasRef.current) setLoading(false)
    }
  }, [alias])

  useEffect(() => {
    if (!expanded || !props.visible || props.paused || alias === '') return
    const tick = (): void => {
      if (document.hidden) return
      void load()
    }
    tick()
    const timer = window.setInterval(tick, Math.max(2_000, props.intervalMs || PROCESS_POLL_MS))
    return () => window.clearInterval(timer)
  }, [expanded, props.visible, props.paused, alias, load, props.intervalMs])

  useEffect(() => {
    if (!expanded || !props.visible || props.paused) return
    const onVisible = (): void => {
      if (!document.hidden) void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [expanded, props.visible, props.paused, load])

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const source = result?.processes ?? []
    const filtered = needle === ''
      ? source
      : source.filter(row => row.command.toLowerCase().includes(needle)
        || row.user.toLowerCase().includes(needle)
        || String(row.pid).includes(needle))
    return sortRows(filtered, sortKey)
  }, [result, filter, sortKey])

  const kill = async (row: RemoteProcess): Promise<void> => {
    const ok = await confirmDialog({
      title: t('proc.killTitle'),
      text: t('proc.killText')
        .replace('{host}', alias)
        .replace('{pid}', String(row.pid))
        .replace('{command}', row.command.slice(0, 120)),
      danger: true,
      okText: t('proc.kill'),
      cancelText: t('common.cancel'),
    })
    if (!ok) return
    setKilling(row.pid)
    try {
      await api.killProcess(alias, row.pid, 'TERM')
      toast(t('proc.killSent').replace('{pid}', String(row.pid)))
      await load(true)
    } catch (caught) {
      toast(caught instanceof RemoteApiError ? caught.message : String(caught), true)
    } finally {
      if (alive.current) setKilling(undefined)
    }
  }

  const host = props.hosts.find(item => item.alias === alias)
  const toolUnknown = result !== undefined && result.tool === 'unknown'

  return (
    <section className="rvs-proc" aria-label={t('proc.title')}>
      <div className="rvs-proc-head">
        <button
          type="button"
          className="rvs-proc-toggle"
          aria-expanded={expanded}
          onClick={() => { setExpanded(value => !value) }}
          title={expanded ? t('proc.collapse') : t('proc.expand')}
        >
          <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        </button>
        <span className="rvs-proc-title">{t('proc.title')}</span>
        {props.aliases.length > 1 && (
          <select
            className="rvs-select rvs-proc-host"
            value={alias}
            onChange={(event) => { setAlias(event.target.value); setResult(undefined); setError(undefined) }}
            aria-label={t('proc.host')}
          >
            {props.aliases.map(item => <option key={item} value={item}>{item}</option>)}
          </select>
        )}
        {props.aliases.length === 1 && host !== undefined && (
          <span className="rvs-proc-host-label">{host.alias}</span>
        )}
        {expanded && (
          <>
            <input
              className="rvs-input rvs-proc-filter"
              value={filter}
              onChange={(event) => { setFilter(event.target.value) }}
              placeholder={t('proc.filter')}
              aria-label={t('proc.filter')}
            />
            <select
              className="rvs-select rvs-proc-sort"
              value={sortKey}
              onChange={(event) => { setSortKey(event.target.value as SortKey) }}
              aria-label={t('proc.sort')}
            >
              <option value="cpu">{t('proc.sortCpu')}</option>
              <option value="mem">{t('proc.sortMem')}</option>
              <option value="pid">{t('proc.sortPid')}</option>
            </select>
            <IconButton title={t('proc.refresh')} onClick={() => { void load(true) }} disabled={loading || alias === ''}>
              {loading ? <MiniSpinner /> : <IconRefresh size={13} />}
            </IconButton>
          </>
        )}
      </div>
      {!expanded && <div className="rvs-proc-collapsed">{t('proc.collapsedHint')}</div>}
      {expanded && error !== undefined && <div className="rvs-banner warn rvs-proc-banner">{toolUnknown ? t('proc.cannotEnumerate') : error}</div>}
      {expanded && result?.tool === 'none' && <div className="rvs-banner warn rvs-proc-banner">{t('proc.noPs')}</div>}
      {expanded && result?.truncated === true && (
        <div className="rvs-banner info rvs-proc-banner">{t('proc.truncated').replace('{count}', String(result.processes.length))}</div>
      )}
      {expanded && alias === '' && <div className="rvs-empty">{t('proc.noHost')}</div>}
      {expanded && alias !== '' && rows.length === 0 && !loading && error === undefined
        && result !== undefined && result.tool !== 'none' && result.tool !== 'unknown' && (
        <div className="rvs-empty">{t('proc.empty')}</div>
      )}
      {expanded && rows.length > 0 && (
        <div className="rvs-proc-table" role="table" aria-label={t('proc.title')}>
          <div className="rvs-proc-row rvs-proc-row-head" role="row">
            <span role="columnheader">PID</span>
            <span role="columnheader">USER</span>
            <span role="columnheader" title={t('proc.cpuHint')}>CPU</span>
            <span role="columnheader">MEM</span>
            <span role="columnheader">{t('proc.elapsed')}</span>
            <span role="columnheader">{t('proc.command')}</span>
            <span aria-hidden="true" />
          </div>
          {rows.map(row => (
            <div className="rvs-proc-row" role="row" key={row.pid}>
              <span role="cell" className="rvs-proc-pid">{row.pid}</span>
              <span role="cell" className="rvs-proc-user" title={row.user}>{row.user}</span>
              <span role="cell" className="rvs-proc-num">{percent(row.cpuPercent)}</span>
              <span role="cell" className="rvs-proc-num">{percent(row.memPercent)}</span>
              <span role="cell" className="rvs-proc-elapsed">{formatElapsed(row.elapsedSeconds, t)}</span>
              <span role="cell" className="rvs-proc-command" title={row.command}>{row.command}</span>
              <button
                type="button"
                className="rvs-proc-kill"
                title={t('proc.killTitle')}
                aria-label={t('proc.killTitle')}
                disabled={killing === row.pid}
                onClick={() => { void kill(row) }}
              >
                {killing === row.pid ? <MiniSpinner /> : t('proc.kill')}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
