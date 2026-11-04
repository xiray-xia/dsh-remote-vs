/**
 * Sidebar monitor: live CPU / memory / disk / network / temperature for one
 * host (or every host at once).
 *
 * Costs are shaped by the plugin's channel budget: the panel polls only while
 * it is the visible view AND the page is visible (5 s), the Host reuses a
 * sample for a few seconds, and a per-alias in-flight set means a manual
 * refresh cannot open a second channel for a host that is already sampling.
 * The first sample is honest about deltas: CPU% and the network rate read
 * "unknown" until a second sample exists.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RemoteHostMetrics, RemoteHostSummary, RemoteMetricsState } from '../protocol.ts'
import { RemoteApiError, api } from './api.ts'
import {
  appendMetrics,
  combineDomain,
  emptyHistory,
  formatAgeShort,
  formatCapacity,
  formatPercent,
  formatRate,
  formatTemperature,
  formatUptime,
  metricTone,
  placeholderMetrics,
  sparklinePath,
  type MetricHistory,
} from './metrics-model.ts'
import { useExplorer } from './store.tsx'
import { optionStyle } from './ui.tsx'
import { IconButton, IconRefresh, MiniSpinner, Segmented } from './vsc/kit.tsx'

/** Visible-panel poll cadence. The Host's own reuse window is shorter (3 s). */
export const MONITOR_POLL_MS = 5_000

const SCOPE_KEY = 'dsh-remote-vs.monitor.scope'
const INTERVAL_KEY = 'dsh-remote-vs.monitor.interval'

/**
 * The refresh-interval setting.
 *
 * `MONITOR_POLL_MS` stays the default and the documented cadence; the other
 * choices exist for slow links / many hosts. The value is validated against
 * this list on read, so a hand-edited localStorage value cannot turn the poll
 * into a 1 ms loop.
 */
export const INTERVAL_CHOICES = [5_000, 10_000, 30_000] as const

function readIntervalMs(): number {
  try {
    const saved = Number(localStorage.getItem(INTERVAL_KEY))
    if (INTERVAL_CHOICES.includes(saved as (typeof INTERVAL_CHOICES)[number])) return saved
  } catch {
    // Private mode: the default stands.
  }
  return MONITOR_POLL_MS
}

function saveIntervalMs(value: number): void {
  try {
    localStorage.setItem(INTERVAL_KEY, String(value))
  } catch {
    // Ignore.
  }
}

/**
 * One scope pick: the workspace's host, one named host, or every host.
 *
 * Persisted as a string so a reload comes back to the same subject; the
 * `host:` prefix keeps an alias literally named "all" unambiguous.
 */
type MonitorScope = 'current' | 'all' | `host:${string}`

function readScope(): MonitorScope {
  try {
    const saved = localStorage.getItem(SCOPE_KEY)
    if (saved === 'current' || saved === 'all') return saved
    if (saved !== null && saved.startsWith('host:') && saved.length > 'host:'.length) {
      return saved as MonitorScope
    }
  } catch {
    // Private mode: the pick simply does not survive a reload.
  }
  return 'current'
}

function saveScope(scope: MonitorScope): void {
  try {
    localStorage.setItem(SCOPE_KEY, scope)
  } catch {
    // Ignore.
  }
}

function currentHostAlias(hosts: RemoteHostSummary[], workspaceAlias: string): string {
  if (workspaceAlias !== '' && hosts.some(host => host.alias === workspaceAlias)) return workspaceAlias
  return hosts[0]?.alias ?? ''
}

/** The aliases one scope samples; an unknown stored host falls back to current. */
function resolveAliases(scope: MonitorScope, hosts: RemoteHostSummary[], workspaceAlias: string): string[] {
  if (scope === 'all') return hosts.map(host => host.alias)
  if (scope.startsWith('host:')) {
    const alias = scope.slice('host:'.length)
    if (hosts.some(host => host.alias === alias)) return [alias]
  }
  const current = currentHostAlias(hosts, workspaceAlias)
  return current === '' ? [] : [current]
}

/** One rail icon: a screen with a pulse line. */
export function IconMonitor(props: { size?: number }): ReactNode {
  const size = props.size ?? 16
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.6" y="2.6" width="12.8" height="9" rx="1.4" />
      <path d="M5.2 7.6h1.6l1.1-2.2 1.4 4 1-1.8h1.5" />
      <path d="M5.6 14.2h4.8" />
    </svg>
  )
}

function IconPause(props: { size?: number }): ReactNode {
  const size = props.size ?? 14
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="4.2" y="3" width="2.4" height="10" rx="0.8" />
      <rect x="9.4" y="3" width="2.4" height="10" rx="0.8" />
    </svg>
  )
}

function IconPlay(props: { size?: number }): ReactNode {
  const size = props.size ?? 14
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M5 3.2v9.6c0 .5.6.8 1 .5l7-4.6a.6.6 0 0 0 0-1l-7-4.6c-.4-.3-1 0-1 .5Z" />
    </svg>
  )
}

/** Sliders: the panel's own settings (refresh interval). */
function IconSettings(props: { size?: number }): ReactNode {
  const size = props.size ?? 14
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M2.4 4.6h4.2M9.4 4.6h4.2" />
      <path d="M2.4 8h2.2M7.4 8h6.2" />
      <path d="M2.4 11.4h4.2M9.4 11.4h4.2" />
      <circle cx="8" cy="4.6" r="1.3" />
      <circle cx="6" cy="8" r="1.3" />
      <circle cx="8" cy="11.4" r="1.3" />
    </svg>
  )
}

/** One gauge tile: value + bar (the bar is absent when the value is unknown). */
function Gauge(props: {
  label: string
  value: string
  sub?: string | undefined
  percent: number | null
}): ReactNode {
  return (
    <div className="rvs-monitor-tile">
      <div className="rvs-monitor-tile-label">{props.label}</div>
      <div className="rvs-monitor-tile-value">{props.value}</div>
      {props.percent !== null && (
        <div className="rvs-monitor-bar" aria-hidden="true">
          <span
            className={`rvs-monitor-bar-fill ${metricTone(props.percent)}`}
            style={{ width: `${Math.max(0, Math.min(100, props.percent))}%` }}
          />
        </div>
      )}
      {props.sub !== undefined && <div className="rvs-monitor-tile-sub">{props.sub}</div>}
    </div>
  )
}

/** One small static fact (temperature, uptime, load, network). */
function Fact(props: { label: string; value: string; title?: string }): ReactNode {
  return (
    <div className="rvs-monitor-fact" title={props.title}>
      <div className="rvs-monitor-fact-label">{props.label}</div>
      <div className="rvs-monitor-fact-value">{props.value}</div>
    </div>
  )
}

/**
 * One sparkline card.
 *
 * The area under the line is a gradient of `currentColor`, so the same markup
 * follows the theme and the `.rvs-monitor-spark.cpu/.mem/...` class colours the
 * line without any inline palette.
 */
function Spark(props: {
  label: string
  values: readonly number[]
  valuesAlt?: readonly number[] | undefined
  tone: string
  empty: string
}): ReactNode {
  const rawId = useId()
  // Deliberately NOT `rvs-monitor-*`: that prefix is the panel's CSS class
  // namespace, and the gate checks that every such class has a rule. This id is
  // an SVG fragment reference, not a class.
  const gradientId = `rvs-grad-${rawId.replace(/[^A-Za-z0-9_-]/g, '')}`
  const altValues = props.valuesAlt ?? []
  // ONE y-domain for both series: independently auto-scaled RX/TX lines would
  // look identical even when one is 100× the other (a misleading chart). The
  // shared domain is the bug fix this argument exists for.
  const domain = altValues.length === 0 ? undefined : combineDomain(props.values, altValues)
  const path = sparklinePath(props.values, 100, 28, domain)
  const altPath = altValues.length === 0 ? '' : sparklinePath(altValues, 100, 28, domain)
  /**
   * A single sample is drawn as a DOT. Filling the area from a one-point path
   * (`M100,14L100,28L0,28Z`) used to paint a full-width wedge and imply a trend
   * that does not exist yet.
   */
  const singleSample = props.values.length < 2
  return (
    <div className={`rvs-monitor-spark ${props.tone}`}>
      <div className="rvs-monitor-spark-head">
        <span className="rvs-monitor-spark-label">{props.label}</span>
        {altValues.length > 0 && (
          <span className="rvs-monitor-spark-legend" aria-hidden="true">
            <span className="rvs-monitor-spark-key"><i className="rvs-monitor-spark-line rx" />↓</span>
            <span className="rvs-monitor-spark-key"><i className="rvs-monitor-spark-line tx" />↑</span>
          </span>
        )}
      </div>
      {path === '' ? (
        <div className="rvs-monitor-spark-empty">{props.empty}</div>
      ) : (
        <svg viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
          {singleSample ? (
            // cx=98 with r=2 stays inside the 0–100 viewBox: `cx=100` clipped
            // the dot to a half-visible sliver at the right edge.
            <circle cx="98" cy="14" r="2" fill="currentColor" />
          ) : (
            <>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={`${path}L100,28L0,28Z`} fill={`url(#${gradientId})`} />
              {altPath !== '' && (
                <path d={altPath} fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="3 3" opacity="0.6" vectorEffect="non-scaling-stroke" />
              )}
              <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </>
          )}
        </svg>
      )}
    </div>
  )
}

function stateLabelOf(state: RemoteMetricsState, t: (key: string) => string): string {
  if (state === 'ok') return t('monitor.stateOk')
  if (state === 'error') return t('monitor.stateError')
  return t('monitor.stateUnknown')
}

function hostLabelOf(alias: string, hosts: RemoteHostSummary[]): string {
  const host = hosts.find(item => item.alias === alias)
  return host === undefined ? alias : `${host.user}@${host.host}:${host.port}`
}

export function MonitorView(props: {
  t: (key: string) => string
  hosts: RemoteHostSummary[]
  visible: boolean
}): ReactNode {
  const t = props.t
  const store = useExplorer()
  const workspaceAlias = store.workspace?.alias ?? ''
  const [scope, setScope] = useState<MonitorScope>(readScope)
  const [intervalMs, setIntervalMs] = useState<number>(readIntervalMs)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [samples, setSamples] = useState<Record<string, RemoteHostMetrics>>({})
  const [histories, setHistories] = useState<Record<string, MetricHistory>>({})
  const [paused, setPaused] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  /** Aliases with a sample request in flight (a second interval tick is a no-op). */
  const inFlight = useRef<Set<string>>(new Set())
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const aliases = useMemo(
    () => resolveAliases(scope, props.hosts, workspaceAlias),
    [scope, props.hosts, workspaceAlias],
  )
  /** Stable identity for the effect: a store publish must not restart the timer. */
  const aliasesKey = aliases.join('|')
  const aliasesRef = useRef<string[]>(aliases)
  aliasesRef.current = aliases

  const currentAlias = currentHostAlias(props.hosts, workspaceAlias)
  const selectValue: string = useMemo(() => {
    if (scope === 'all') return 'all'
    if (scope.startsWith('host:')) {
      const alias = scope.slice('host:'.length)
      if (props.hosts.some(host => host.alias === alias)) return scope
    }
    return 'current'
  }, [scope, props.hosts])

  const load = useCallback(async (targets: string[], force: boolean): Promise<void> => {
    await Promise.all(targets.map(async (alias) => {
      if (inFlight.current.has(alias)) return
      inFlight.current.add(alias)
      try {
        const metrics = await api.hostMetrics(alias, force)
        if (!alive.current) return
        setSamples(previous => ({ ...previous, [alias]: metrics }))
        setHistories(previous => ({ ...previous, [alias]: appendMetrics(previous[alias] ?? emptyHistory(), metrics) }))
      } catch (error) {
        if (!alive.current) return
        const reason = error instanceof RemoteApiError ? error.message : String(error)
        setSamples(previous => ({ ...previous, [alias]: placeholderMetrics(alias, 'error', reason) }))
      } finally {
        inFlight.current.delete(alias)
      }
    }))
  }, [])

  // The ONLY polling site: visible panel + visible page. A parked rail panel
  // and a background tab both stop asking, so the monitor never becomes the
  // plugin's traffic source while the user is looking at files or the terminal.
  // `tick` is the single place that decides visibility, so both the immediate
  // sample and the interval sample share the same guard (and returning to the
  // tab samples at once instead of waiting out the interval).
  useEffect(() => {
    if (!props.visible || paused) return
    const targets = aliasesRef.current
    if (targets.length === 0) return
    const tick = (): void => {
      if (document.hidden) return
      void load(aliasesRef.current, false)
    }
    tick()
    const timer = window.setInterval(tick, intervalMs)
    const onVisibilityChange = (): void => {
      if (!document.hidden) tick()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.clearInterval(timer)
    }
  }, [props.visible, paused, aliasesKey, intervalMs, load])

  const refresh = useCallback((): void => {
    const targets = aliasesRef.current
    if (targets.length === 0) return
    setRefreshing(true)
    void load(targets, true).finally(() => {
      if (alive.current) setRefreshing(false)
    })
  }, [load])

  const choose = useCallback((next: string): void => {
    const value = next as MonitorScope
    setScope(value)
    saveScope(value)
  }, [])

  const chooseInterval = useCallback((next: string): void => {
    const value = Number(next)
    if (!INTERVAL_CHOICES.includes(value as (typeof INTERVAL_CHOICES)[number])) return
    setIntervalMs(value)
    saveIntervalMs(value)
  }, [])

  const unknown = t('monitor.unknown')
  const stateLabel = (state: RemoteMetricsState): string => stateLabelOf(state, t)
  const ageLabel = (metrics: RemoteHostMetrics): string => {
    const age = Date.now() - metrics.sampledAt
    if (age < 1_500) return t('monitor.justNow')
    return t('monitor.updatedAgo').replace('{age}', formatAgeShort(age))
  }

  const renderDetail = (alias: string): ReactNode => {
    const metrics = samples[alias]
    if (metrics === undefined) {
      return (
        <div className="rvs-empty">
          {props.visible ? (<><MiniSpinner /> {t('monitor.loading')}</>) : t('monitor.noData')}
        </div>
      )
    }
    const state = metrics.state
    const label = stateLabel(state)
    const history = histories[alias] ?? emptyHistory()
    const memPercent = metrics.memPercent
    const diskPercent = metrics.diskPercent
    const loadText = metrics.load1 === null || metrics.load5 === null || metrics.load15 === null
      ? unknown
      : [metrics.load1, metrics.load5, metrics.load15].map(value => value.toFixed(2)).join(' / ')
    const netText = metrics.netRxBps === null && metrics.netTxBps === null
      ? unknown
      : `${metrics.netRxBps === null ? unknown : formatRate(metrics.netRxBps)} ↓ / ${metrics.netTxBps === null ? unknown : formatRate(metrics.netTxBps)} ↑`
    return (
      <div className={`rvs-monitor-card ${state}`}>
        <div className="rvs-monitor-head">
          {/* The state word is right below this dot; announcing it twice is noise. */}
          <span className={`rvs-monitor-dot ${state}`} aria-hidden="true" />
          <span className="rvs-monitor-title" title={alias}>{alias}</span>
          <span className="rvs-monitor-conn" title={hostLabelOf(alias, props.hosts)}>{hostLabelOf(alias, props.hosts)}</span>
        </div>
        <div className="rvs-monitor-sub">
          <span className={`rvs-monitor-state ${state}`}>{label}</span>
          <span className="rvs-monitor-age">{ageLabel(metrics)}</span>
          {metrics.reason !== undefined && (
            <span className="rvs-monitor-reason" title={metrics.reason}>{t('monitor.reason').replace('{reason}', metrics.reason)}</span>
          )}
        </div>
        {state === 'ok' ? (
          <>
            <div className="rvs-monitor-grid">
              <Gauge
                label={t('monitor.cpu')}
                value={metrics.cpuPercent === null ? unknown : formatPercent(metrics.cpuPercent)}
                percent={metrics.cpuPercent}
                sub={metrics.cpuCores === null
                  ? (metrics.cpuPercent === null ? t('monitor.warming') : undefined)
                  : t('monitor.cores').replace('{count}', String(metrics.cpuCores))}
              />
              <Gauge
                label={t('monitor.ram')}
                value={memPercent === null ? unknown : formatPercent(memPercent)}
                percent={memPercent}
                sub={metrics.memUsedBytes === null || metrics.memTotalBytes === null
                  ? undefined
                  : formatCapacity(metrics.memUsedBytes, metrics.memTotalBytes)}
              />
              <Gauge
                label={t('monitor.disk')}
                value={diskPercent === null ? unknown : formatPercent(diskPercent)}
                percent={diskPercent}
                sub={metrics.diskUsedBytes === null || metrics.diskTotalBytes === null
                  ? undefined
                  : formatCapacity(metrics.diskUsedBytes, metrics.diskTotalBytes)}
              />
            </div>
            <div className="rvs-monitor-facts">
              <Fact label={t('monitor.temp')} value={metrics.temperatureC === null ? unknown : formatTemperature(metrics.temperatureC)} />
              <Fact label={t('monitor.uptime')} value={metrics.uptimeSeconds === null ? unknown : formatUptime(metrics.uptimeSeconds)} />
              <Fact label={t('monitor.load')} value={loadText} />
              <Fact
                label={t('monitor.net')}
                value={netText}
                title={metrics.netRxBps === null && metrics.netTxBps === null ? t('monitor.warming') : undefined}
              />
            </div>
            <div className="rvs-monitor-sparks">
              <Spark label={t('monitor.cpuHistory')} values={history.cpu} tone="cpu" empty={t('monitor.warming')} />
              <Spark label={t('monitor.memHistory')} values={history.mem} tone="mem" empty={t('monitor.warming')} />
              <Spark label={t('monitor.netHistory')} values={history.netRx} valuesAlt={history.netTx} tone="net" empty={t('monitor.warming')} />
              <Spark label={t('monitor.tempHistory')} values={history.temp} tone="temp" empty={t('monitor.unknown')} />
            </div>
            <div className="rvs-monitor-hint">
              {metrics.kernel === null
                ? t('monitor.linuxOnly')
                : `${metrics.kernel}${metrics.cpuModel === null ? '' : ` · ${metrics.cpuModel}`}${metrics.ip === null ? '' : ` · ${metrics.ip}`}`}
            </div>
          </>
        ) : (
          <div className="rvs-monitor-hint">{metrics.reason ?? t('monitor.noData')}</div>
        )}
      </div>
    )
  }

  const renderAll = (targets: string[]): ReactNode => {
    const okCount = targets.filter(alias => samples[alias]?.state === 'ok').length
    return (
      <div className="rvs-monitor-list">
        <div className="rvs-monitor-summary">
          {t('monitor.allSummary')
            .replace('{ok}', String(okCount))
            .replace('{total}', String(targets.length))}
        </div>
        {targets.map((alias) => {
          const metrics = samples[alias]
          const state: RemoteMetricsState = metrics?.state ?? 'unknown'
          const label = stateLabel(state)
          const cpuPercent = metrics?.cpuPercent ?? null
          const memPercent = metrics?.memPercent ?? null
          return (
            <button
              key={alias}
              type="button"
              className={`rvs-monitor-row ${state}`}
              onClick={() => choose(`host:${alias}`)}
              title={t('monitor.inspect')}
            >
              <span className="rvs-monitor-row-top">
                <span className={`rvs-monitor-dot ${state}`} role="img" aria-label={label} />
                <span className="rvs-monitor-row-name">{alias}</span>
                <span className="rvs-monitor-row-host">{hostLabelOf(alias, props.hosts)}</span>
                {metrics === undefined
                  ? <MiniSpinner />
                  : <span className="rvs-monitor-row-cpu">{cpuPercent === null ? unknown : formatPercent(cpuPercent)}</span>}
              </span>
              <span className="rvs-monitor-row-bars">
                <span
                  className="rvs-monitor-row-bar"
                  title={`${t('monitor.cpu')} ${cpuPercent === null ? unknown : formatPercent(cpuPercent)}`}
                >
                  <span className={`rvs-monitor-bar-fill ${metricTone(cpuPercent)}`} style={{ width: `${cpuPercent === null ? 0 : Math.max(0, Math.min(100, cpuPercent))}%` }} />
                </span>
                <span
                  className="rvs-monitor-row-bar"
                  title={`${t('monitor.ram')} ${memPercent === null ? unknown : formatPercent(memPercent)}`}
                >
                  <span className={`rvs-monitor-bar-fill ${metricTone(memPercent)}`} style={{ width: `${memPercent === null ? 0 : Math.max(0, Math.min(100, memPercent))}%` }} />
                </span>
              </span>
              <span className="rvs-monitor-row-facts">
                <span>{t('monitor.ram')} {memPercent === null ? unknown : formatPercent(memPercent)}</span>
                <span>{t('monitor.temp')} {metrics?.temperatureC === null || metrics?.temperatureC === undefined ? unknown : formatTemperature(metrics.temperatureC)}</span>
                <span>{t('monitor.uptime')} {metrics?.uptimeSeconds === null || metrics?.uptimeSeconds === undefined ? unknown : formatUptime(metrics.uptimeSeconds)}</span>
              </span>
            </button>
          )
        })}
        <div className="rvs-monitor-hint">{t('monitor.linuxOnly')}</div>
      </div>
    )
  }

  const single = aliases.length === 1 ? aliases[0] : undefined

  return (
    <div className="rvs-pane grow">
      <div className="rvs-header rvs-monitor-header">
        <span className="rvs-title">{t('tab.monitor')}</span>
        <select
          className="rvs-select"
          value={selectValue}
          onChange={(event) => choose(event.target.value)}
          disabled={props.hosts.length === 0}
          title={`${t('monitor.selectScope')}${currentAlias === '' ? '' : ` · ${currentAlias}`}`}
          style={{ flex: 1, minWidth: 90 }}
        >
          {/* No "(alias)" suffix: the card title already shows it, and the
              suffix is what got ellipsised in the 230px sidebar. The current
              host is in the select's title tooltip instead. */}
          <option value="current" style={optionStyle}>{t('monitor.scopeCurrent')}</option>
          {props.hosts.map(host => (
            <option key={host.alias} value={`host:${host.alias}`} style={optionStyle}>
              {host.alias}
            </option>
          ))}
          <option value="all" style={optionStyle}>{t('monitor.scopeAll')}</option>
        </select>
        <IconButton
          title={t('monitor.settings')}
          onClick={() => setSettingsOpen(open => !open)}
          className={settingsOpen ? 'active' : undefined}
        >
          <IconSettings />
        </IconButton>
        <IconButton
          title={paused ? t('monitor.resume') : t('monitor.pause')}
          onClick={() => setPaused(value => !value)}
        >
          {paused ? <IconPlay /> : <IconPause />}
        </IconButton>
        <IconButton
          title={t('monitor.refresh')}
          onClick={refresh}
          disabled={aliases.length === 0 || refreshing}
        >
          {refreshing ? <MiniSpinner /> : <IconRefresh size={14} />}
        </IconButton>
      </div>
      {settingsOpen && (
        <div className="rvs-monitor-settings">
          <div className="rvs-monitor-settings-head">
            <span className="rvs-monitor-settings-label">{t('monitor.interval')}</span>
            <span className="rvs-monitor-settings-hint">{t('monitor.intervalHint')}</span>
          </div>
          <Segmented
            value={String(intervalMs)}
            onChange={chooseInterval}
            options={[
              { id: '5000', label: t('monitor.interval5') },
              { id: '10000', label: t('monitor.interval10') },
              { id: '30000', label: t('monitor.interval30') },
            ]}
          />
        </div>
      )}
      <div className="rvs-monitor-body">
        {props.hosts.length === 0 && <div className="rvs-banner warn">{t('monitor.noHosts')}</div>}
        {props.hosts.length > 0 && aliases.length === 0 && <div className="rvs-empty">{t('monitor.noHost')}</div>}
        {paused && <div className="rvs-banner info">{t('monitor.paused')}</div>}
        {single !== undefined && renderDetail(single)}
        {single === undefined && aliases.length > 1 && renderAll(aliases)}
      </div>
    </div>
  )
}
