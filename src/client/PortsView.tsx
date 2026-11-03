/**
 * Ports view: the `ssh -L` tunnels this client owns, plus a way to make more.
 *
 * Why a panel instead of a hidden command: a forward the panel does not show is
 * invisible state. The listener lives in the HOST process, so closing the
 * sidebar, switching hosts or reloading the page must not look like "the tunnel
 * is gone" while it still holds a local port. The list is therefore the Host's
 * own answer (a local-only read, polled), the rules the user created are
 * remembered by the BROWSER, and a reload restores them — the listener belongs
 * to the Host, the memory of why it exists belongs here.
 *
 * Two costs shape the polling: the forward list is a local JSON read (cheap, so
 * every 4 s while visible), whereas the listening-port probe runs a remote
 * command (`ss`/`netstat`) and is therefore rare: on mount, on an explicit
 * refresh, and once every 30 s.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  RemoteForwardState,
  RemoteHostSummary,
  RemoteListenPort,
  RemoteListenPortsResult,
} from '../protocol.ts'
import { RemoteApiError, api } from './api.ts'
import { optionStyle } from './ui.tsx'
import {
  IconButton,
  IconCopy,
  IconRefresh,
  IconStop,
  copyText,
  toast,
} from './vsc/kit.tsx'

const ALIAS_KEY = 'dsh-remote-vs.ports.alias'
const RULES_KEY = 'dsh-remote-vs.portForwards'

/** Local forward list: one loopback JSON call into the Host, no SSH. */
const FORWARDS_POLL_MS = 4_000
/** Listening ports: one remote exec, so this stays deliberately rare. */
const LISTEN_POLL_MS = 30_000
/**
 * The remote target a rule dials by default.
 *
 * `ssh -L` connects to the remote host first and then dials the target FROM
 * there, so the remote host's own loopback is where its services listen. The
 * same reasoning makes this the target for a one-click "forward this listening
 * port": a discovered `0.0.0.0` / `::` / `*` bind address is not a dialable
 * address at all.
 */
const DEFAULT_REMOTE_HOST = '127.0.0.1'

/**
 * The remote address one discovered listener should be dialed at.
 *
 * A wildcard bind (`0.0.0.0` / `::` / `*`) is not a dialable address, and the
 * remote host's own loopback is what every such listener accepts; a socket
 * bound to a CONCRETE address (a specific interface address) must be dialed at
 * that address, because the loopback would simply not be listening there.
 */
function reachableHost(addr: string): string {
  const bare = addr.startsWith('[') && addr.endsWith(']') ? addr.slice(1, -1) : addr
  // A v4 wildcard is reachable on the remote loopback; a v6 wildcard is NOT the
  // same address — a V6ONLY listener does not accept 127.0.0.1, so `::` is
  // dialed at `::1` (still loopback, still reachable for a dual-stack bind).
  if (bare === '' || bare === '*' || bare === '0.0.0.0') return DEFAULT_REMOTE_HOST
  if (bare === '::') return '::1'
  if (bare === '127.0.0.1') return DEFAULT_REMOTE_HOST
  return bare
}

/** True for an integer port in range; `allowAuto` admits the 0 "assign one" case. */
function isPort(value: unknown, allowAuto = false): value is number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return false
  if (value > 65535) return false
  return value >= (allowAuto ? 0 : 1)
}

/** Parse one port typed into the form; `undefined` for anything invalid. */
function parsePort(text: string): number | undefined {
  const trimmed = text.trim()
  // Digits only: `parseInt` would happily turn "80abc" into 80.
  if (!/^\d{1,5}$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  return isPort(value) ? value : undefined
}

function errorText(error: unknown): string {
  return error instanceof RemoteApiError ? error.message : String(error)
}

/**
 * `addr:port`, bracketing an IPv6 literal.
 *
 * The Host's parser strips the brackets from `[::]:22` (the conventional
 * spelling for display), so joining naively would print `:::22` — which reads
 * as a malformed address rather than as "port 22 on every v6 interface".
 */
function hostPort(addr: string, port: number): string {
  return addr.includes(':') ? `[${addr}]:${port}` : `${addr}:${port}`
}

function readAlias(): string {
  try {
    return localStorage.getItem(ALIAS_KEY) ?? ''
  } catch {
    return ''
  }
}

/** One saved rule: what the user asked for, not what the OS granted. */
interface StoredRule {
  remoteHost: string
  remotePort: number
  /** 0 means "let the OS assign one", exactly as the request carried it. */
  localPort: number
}

type StoredRules = Record<string, StoredRule[]>

/**
 * Read the remembered rules, discarding anything that is not a valid rule.
 *
 * localStorage is shared with older builds and with the user's devtools, so a
 * malformed entry must cost that entry — never the whole list, and never a
 * `POST` built from garbage.
 */
function readRules(): StoredRules {
  let parsed: unknown
  try {
    const raw = localStorage.getItem(RULES_KEY)
    if (raw === null) return {}
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const out: StoredRules = {}
  for (const [alias, rows] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(rows)) continue
    const rules: StoredRule[] = []
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue
      const { remoteHost, remotePort, localPort } = row as {
        remoteHost?: unknown
        remotePort?: unknown
        localPort?: unknown
      }
      if (typeof remoteHost !== 'string' || remoteHost === '') continue
      if (!isPort(remotePort) || !isPort(localPort, true)) continue
      rules.push({ remoteHost, remotePort, localPort })
    }
    if (rules.length > 0) out[alias] = rules
  }
  return out
}

function writeRules(rules: StoredRules): void {
  try {
    localStorage.setItem(RULES_KEY, JSON.stringify(rules))
  } catch {
    // Private mode: the tunnels still work for this session, they just do not
    // survive a reload — which is the honest degraded behaviour.
  }
}

/** Remember one rule so the next mount can restore it. */
function rememberRule(alias: string, rule: StoredRule): void {
  const all = readRules()
  const rows = all[alias] ?? []
  const duplicate = rows.some(row =>
    row.remoteHost === rule.remoteHost
    && row.remotePort === rule.remotePort
    && row.localPort === rule.localPort)
  if (duplicate) return
  all[alias] = [...rows, rule]
  writeRules(all)
}

/**
 * Drop the saved rule behind one live forward.
 *
 * The id cannot be recomputed here for an auto-assigned port: the request said
 * "any", the Host answered with a number, so the saved rule's `localPort` is 0
 * while `forward.localPort` is real. Match the exact rule first, then the
 * auto-assign one, and remove exactly ONE line — a user may legitimately hold
 * two rules for the same remote port on two different local ports.
 */
function forgetRule(alias: string, forward: RemoteForwardState): void {
  const all = readRules()
  const rows = all[alias] ?? []
  const sameTarget = (row: StoredRule): boolean =>
    row.remoteHost === forward.remoteHost && row.remotePort === forward.remotePort
  const exact = rows.findIndex(row => sameTarget(row) && row.localPort === forward.localPort)
  const auto = rows.findIndex(row => sameTarget(row) && row.localPort === 0)
  const index = exact >= 0 ? exact : auto
  if (index < 0) return
  const next = rows.filter((_row, at) => at !== index)
  if (next.length === 0) delete all[alias]
  else all[alias] = next
  writeRules(all)
}

/**
 * Drop one SAVED rule that never became a live forward.
 *
 * A restore can fail for reasons that do not go away by themselves (a fixed
 * local port now taken by another app, the per-alias rule ceiling): such a rule
 * has no live row to press "stop" on, so without this the banner would retry it
 * — and reappear — on every mount with no way out.
 */
function forgetStoredRule(alias: string, rule: StoredRule): void {
  const all = readRules()
  const rows = all[alias] ?? []
  const index = rows.findIndex(row =>
    row.remoteHost === rule.remoteHost
    && row.remotePort === rule.remotePort
    && row.localPort === rule.localPort)
  if (index < 0) return
  const next = rows.filter((_row, at) => at !== index)
  if (next.length === 0) delete all[alias]
  else all[alias] = next
  writeRules(all)
}

/**
 * Merge freshly created forwards into the rendered list.
 *
 * The 4 s poll REPLACES the list with the Host's truth, so a just-started rule
 * is shown immediately here and every list read that started before it is
 * invalidated by the caller (see `adoptForward`); otherwise a poll that left
 * before the POST landed would briefly erase the row the user just created.
 */
function mergeForwards(
  previous: RemoteForwardState[] | undefined,
  added: readonly RemoteForwardState[],
): RemoteForwardState[] {
  const merged = [...(previous ?? [])]
  for (const forward of added) {
    const index = merged.findIndex(item => item.id === forward.id)
    if (index >= 0) merged[index] = forward
    else merged.push(forward)
  }
  return merged
}

/**
 * Rail icon: a plug. Kept here rather than in `vsc/kit.tsx` because it is the
 * only screen that draws one, and the shared icon set is a curated list.
 */
export function IconPlug(props: { size?: number }): ReactNode {
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
      <path d="M6 1.8v2.4M10 1.8v2.4" />
      <path d="M4 4.2h8v2a4 4 0 0 1-4 4 4 4 0 0 1-4-4Z" />
      <path d="M8 10.2v4" />
    </svg>
  )
}

/** Local "leaves the page" mark for the open-in-browser link. */
function IconExternal(props: { size?: number }): ReactNode {
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
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6.6 3.4H3.4v9.2h9.2V9.4" />
      <path d="M9.2 2.6h4.2v4.2M13.4 2.6 8 8" />
    </svg>
  )
}

export function PortsView(props: {
  t: (key: string) => string
  hosts: RemoteHostSummary[]
  visible: boolean
}): ReactNode {
  const t = props.t
  const [alias, setAlias] = useState<string>(readAlias)
  const [forwards, setForwards] = useState<RemoteForwardState[] | undefined>(undefined)
  const [forwardError, setForwardError] = useState<string | undefined>(undefined)
  const [listen, setListen] = useState<RemoteListenPortsResult | undefined>(undefined)
  const [listenError, setListenError] = useState<string | undefined>(undefined)
  /** Rules that failed to come back after a reload (shown, never silently dropped). */
  const [restoreFailed, setRestoreFailed] = useState<StoredRule[]>([])
  /** The form's own failure, or a one-click forward's — one banner, one place. */
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  /**
   * What is in flight, keyed ('form', 'refresh', a forward id or a discovered
   * row). A Set, not one string: a second action must neither hide the first
   * one's spinner nor re-enable its button when it settles.
   */
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const [remoteHost, setRemoteHost] = useState<string>(DEFAULT_REMOTE_HOST)
  const [remotePort, setRemotePort] = useState<string>('')
  const [localPort, setLocalPort] = useState<string>('')

  const markBusy = useCallback((key: string): void => {
    setBusy((previous) => {
      if (previous.has(key)) return previous
      const next = new Set(previous)
      next.add(key)
      return next
    })
  }, [])
  const clearBusy = useCallback((key: string): void => {
    setBusy((previous) => {
      if (!previous.has(key)) return previous
      const next = new Set(previous)
      next.delete(key)
      return next
    })
  }, [])

  const effectiveAlias = (alias !== '' && props.hosts.some(host => host.alias === alias))
    ? alias
    : (props.hosts[0]?.alias ?? '')

  /**
   * Async answers must not land after unmount, and a host switch must not let
   * the previous host's answer win a race against the new one. `alive` covers
   * the first; the two sequence refs below cover the second.
   */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const forwardSeq = useRef(0)
  const listenSeq = useRef(0)
  /**
   * The alias the panel is on NOW, for async code.
   *
   * The restore loop below is the one path that keeps working across a host
   * switch (each POST is already in flight); without this mirror it could adopt
   * another host's forward into the visible list. A ref, not the state, because
   * the loop must see the CURRENT pick, not the one captured when it started.
   */
  const aliasRef = useRef(effectiveAlias)
  aliasRef.current = effectiveAlias

  // Remember the host the user last looked at, exactly like the terminal panel.
  useEffect(() => {
    try {
      localStorage.setItem(ALIAS_KEY, effectiveAlias)
    } catch {
      // Ignore: the picker still works, the choice just does not survive.
    }
  }, [effectiveAlias])

  const reloadForwards = useCallback(async (host: string): Promise<void> => {
    if (host === '') return
    const seq = ++forwardSeq.current
    try {
      const list = await api.forwards(host)
      if (!alive.current || seq !== forwardSeq.current) return
      setForwards(list)
      setForwardError(undefined)
    } catch (error) {
      if (!alive.current || seq !== forwardSeq.current) return
      setForwardError(errorText(error))
    }
  }, [])

  const loadListen = useCallback(async (host: string): Promise<void> => {
    if (host === '') return
    const seq = ++listenSeq.current
    try {
      const result = await api.listenPorts(host)
      if (!alive.current || seq !== listenSeq.current) return
      setListen(result)
      setListenError(undefined)
    } catch (error) {
      if (!alive.current || seq !== listenSeq.current) return
      setListenError(errorText(error))
    }
  }, [])

  /**
   * A host switch starts from a blank slate.
   *
   * The previous host's forwards and ports are not this host's anything: showing
   * them under the new picker would invite the user to stop a tunnel they did
   * not see. They are re-fetched immediately by the effects below.
   */
  useEffect(() => {
    setForwards(undefined)
    setForwardError(undefined)
    setListen(undefined)
    setListenError(undefined)
    setRestoreFailed([])
    setActionError(undefined)
  }, [effectiveAlias])

  // Forward list: cheap local read, so it follows visibility every 4 s.
  useEffect(() => {
    if (!props.visible || effectiveAlias === '') return
    void reloadForwards(effectiveAlias)
    const timer = window.setInterval(() => {
      if (document.hidden) return
      void reloadForwards(effectiveAlias)
    }, FORWARDS_POLL_MS)
    return () => {
      // Invalidate a read that is still in flight, so it cannot land after the
      // panel stopped caring about this host.
      forwardSeq.current += 1
      window.clearInterval(timer)
    }
  }, [props.visible, effectiveAlias, reloadForwards])

  // Listening ports: one remote exec, so mount/refresh/30 s only.
  useEffect(() => {
    if (!props.visible || effectiveAlias === '') return
    void loadListen(effectiveAlias)
    const timer = window.setInterval(() => {
      if (document.hidden) return
      void loadListen(effectiveAlias)
    }, LISTEN_POLL_MS)
    return () => {
      listenSeq.current += 1
      window.clearInterval(timer)
    }
  }, [props.visible, effectiveAlias, loadListen])

  /**
   * Show a just-created forward at once.
   *
   * Bumping the sequence invalidates a list read that left before the POST
   * landed: without it the 4 s poll could resolve with a list that predates the
   * new rule and erase the row for a full interval.
   */
  const adoptForward = useCallback((forward: RemoteForwardState): void => {
    forwardSeq.current += 1
    // A forward created for a host the user has since left must not appear in
    // the new host's list (the restore loop is the only caller that can outlive
    // the switch).
    if (alive.current && forward.alias === aliasRef.current) {
      setForwards(previous => mergeForwards(previous, [forward]))
    }
  }, [])

  /**
   * Restore the remembered rules for one host, once per mount.
   *
   * Once per host per mount, not on every visibility flip: a forward that fails
   * (the remote port is closed) would otherwise be retried on every rail switch,
   * costing an SSH channel each time and re-raising the same banner. The rules
   * are posted IN ORDER because the Host is the one place that knows whether a
   * local port is free — a parallel burst would race for the same port.
   *
   * The live list is read FIRST: reloading the page does not restart the Host,
   * so tunnels from before the reload are usually still listening and must not be
   * reported as "could not be restored" (a duplicate start is rejected).
   */
  const restored = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!props.visible || effectiveAlias === '') return
    if (restored.current.has(effectiveAlias)) return
    restored.current.add(effectiveAlias)
    const rules = readRules()[effectiveAlias] ?? []
    if (rules.length === 0) return
    const host = effectiveAlias
    void (async () => {
      let live: RemoteForwardState[] = []
      try {
        live = await api.forwards(host)
        if (!alive.current || aliasRef.current !== host) return
        setForwards(previous => mergeForwards(previous, live))
      } catch {
        // "Cannot read the live list" is treated as "unknown": a duplicate start
        // is rejected by the Host and counted like any other restore failure.
      }
      const failed: StoredRule[] = []
      for (const rule of rules) {
        if (!alive.current || aliasRef.current !== host) return
        const already = live.some(item =>
          item.remoteHost === rule.remoteHost
          && item.remotePort === rule.remotePort
          && (rule.localPort === 0 || item.localPort === rule.localPort))
        if (already) continue
        try {
          const forward = await api.startForward({
            alias: host,
            remoteHost: rule.remoteHost,
            remotePort: rule.remotePort,
            localPort: rule.localPort,
          })
          adoptForward(forward)
        } catch {
          failed.push(rule)
        }
      }
      if (failed.length > 0 && alive.current && aliasRef.current === host) setRestoreFailed(failed)
    })()
  }, [props.visible, effectiveAlias, adoptForward])

  const refresh = async (): Promise<void> => {
    if (effectiveAlias === '') return
    markBusy('refresh')
    try {
      // Both loaders own their request token and error state, so a failure in
      // one never hides the answer of the other, and neither rejects.
      await Promise.all([reloadForwards(effectiveAlias), loadListen(effectiveAlias)])
    } finally {
      if (alive.current) clearBusy('refresh')
    }
  }

  const startManual = async (): Promise<void> => {
    if (effectiveAlias === '') return
    const targetPort = parsePort(remotePort)
    if (targetPort === undefined) {
      setActionError(t('ports.badPort'))
      return
    }
    const trimmedLocal = localPort.trim()
    const requestedLocal = trimmedLocal === '' ? 0 : parsePort(trimmedLocal)
    if (requestedLocal === undefined) {
      setActionError(t('ports.badPort'))
      return
    }
    const targetHost = remoteHost.trim() === '' ? DEFAULT_REMOTE_HOST : remoteHost.trim()
    markBusy('form')
    try {
      const forward = await api.startForward({
        alias: effectiveAlias,
        remoteHost: targetHost,
        remotePort: targetPort,
        localPort: requestedLocal,
      })
      adoptForward(forward)
      rememberRule(effectiveAlias, { remoteHost: targetHost, remotePort: targetPort, localPort: requestedLocal })
      setActionError(undefined)
      // The host is rarely changed between rules; the volatile ports are cleared
      // so a second rule never inherits the first one's numbers by accident.
      setRemotePort('')
      setLocalPort('')
    } catch (error) {
      if (alive.current) setActionError(errorText(error))
    } finally {
      if (alive.current) clearBusy('form')
    }
  }

  /** One-click forward of a discovered port; the local port is auto-assigned. */
  const forwardDiscovered = async (port: RemoteListenPort): Promise<void> => {
    if (effectiveAlias === '') return
    const remoteHost = reachableHost(port.addr)
    const busyId = `listen:${port.addr}:${port.port}`
    markBusy(busyId)
    try {
      const forward = await api.startForward({
        alias: effectiveAlias,
        remoteHost,
        remotePort: port.port,
        localPort: 0,
      })
      adoptForward(forward)
      rememberRule(effectiveAlias, { remoteHost, remotePort: port.port, localPort: 0 })
      setActionError(undefined)
    } catch (error) {
      if (alive.current) setActionError(errorText(error))
    } finally {
      if (alive.current) clearBusy(busyId)
    }
  }

  const stop = async (forward: RemoteForwardState): Promise<void> => {
    markBusy(forward.id)
    try {
      await api.stopForward(forward.id)
      // Drop the row here as well as on the next poll, and invalidate reads that
      // were taken while the forward was still alive.
      forwardSeq.current += 1
      if (alive.current) setForwards(previous => (previous ?? []).filter(item => item.id !== forward.id))
      forgetRule(forward.alias, forward)
      setActionError(undefined)
    } catch (error) {
      if (alive.current) setActionError(errorText(error))
    } finally {
      if (alive.current) clearBusy(forward.id)
    }
  }

  const stateLabel = (forward: RemoteForwardState): string =>
    forward.state === 'error' ? t('ports.stateError') : t('ports.stateListening')

  const renderForwards = (): ReactNode => {
    // No host, no list: the banner above already says what to do, and a spinner
    // that can never finish would contradict it.
    if (effectiveAlias === '') return null
    if (forwards === undefined) {
      // A failed FIRST load is explained by the banner; "loading" next to it
      // would be two answers to one question.
      if (forwardError !== undefined) return null
      return <div className="rvs-empty">{t('common.loading')}</div>
    }
    if (forwards.length === 0) return <div className="rvs-empty">{t('ports.emptyForwards')}</div>
    return forwards.map((forward) => {
      const label = stateLabel(forward)
      return (
        <div key={forward.id} className="rvs-ports-row">
          <div className="rvs-ports-line">
            <span className={`rvs-ports-dot ${forward.state}`} role="img" aria-label={label} title={label} />
            <span className="rvs-ports-addr" title={`${hostPort(forward.remoteHost, forward.remotePort)} → ${forward.localUrl}`}>
              {hostPort(forward.remoteHost, forward.remotePort)} → {forward.localUrl}
            </span>
          </div>
          {forward.lastError !== undefined && <div className="rvs-ports-err">{forward.lastError}</div>}
          <div className="rvs-ports-actions">
            <span className="rvs-ports-conn">
              {t('ports.connections').replace('{count}', String(forward.connections))}
            </span>
            <span style={{ flex: 1 }} />
            <IconButton title={t('ports.copyUrl')} onClick={() => { void copyText(forward.localUrl).then(() => toast(t('ports.copied'))) }}>
              <IconCopy size={13} />
            </IconButton>
            {/* A forward is only useful if it is reachable from the browser, so
                "open" is a normal link: no window.open, no opener hand-off. */}
            <a
              className="rvs-hbtn rvs-ports-open"
              href={forward.localUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={t('ports.open')}
              aria-label={t('ports.open')}
            >
              <IconExternal size={13} />
            </a>
            <IconButton
              title={t('ports.stop')}
              danger
              disabled={busy.has(forward.id)}
              onClick={() => { void stop(forward) }}
            >
              <IconStop size={13} />
            </IconButton>
          </div>
        </div>
      )
    })
  }

  /** The "what did the probe find" half of the listening section. */
  const listenBody = (result: RemoteListenPortsResult): ReactNode => {
    // `none`/`unknown` are "cannot enumerate", never "nothing is listening" —
    // a blank list would read as a clean bill of health the probe cannot give.
    if (result.tool === 'none') {
      return (
        <div className="rvs-empty">
          {t('ports.listenUnavailable')}
          {result.error !== undefined && <div className="rvs-ports-hint">{result.error}</div>}
        </div>
      )
    }
    if (result.tool === 'unknown') {
      return (
        <div className="rvs-empty">
          {t('ports.listenUnknown')}
          {result.error !== undefined && <div className="rvs-ports-hint">{result.error}</div>}
        </div>
      )
    }
    if (result.ports.length === 0) return <div className="rvs-empty">{t('ports.emptyListen')}</div>
    return (
      <>
        {result.ports.map((port) => {
          const busyId = `listen:${port.addr}:${port.port}`
          return (
            <div key={`${port.addr}:${port.port}`} className="rvs-ports-row">
              <div className="rvs-ports-line">
                <span className="rvs-ports-addr">{hostPort(port.addr, port.port)}</span>
                {port.process !== undefined && <span className="rvs-ports-proc" title={port.process}>{port.process}</span>}
              </div>
              <div className="rvs-ports-actions">
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  className="rvs-chip"
                  disabled={busy.has(busyId)}
                  onClick={() => { void forwardDiscovered(port) }}
                >
                  {t('ports.forward')}
                </button>
              </div>
            </div>
          )
        })}
        {result.error !== undefined && <div className="rvs-ports-hint">{result.error}</div>}
      </>
    )
  }

  const renderListen = (): ReactNode => {
    if (effectiveAlias === '') return null
    if (listen === undefined) {
      if (listenError !== undefined) return <div className="rvs-banner error">{listenError}</div>
      return <div className="rvs-empty">{t('common.loading')}</div>
    }
    return (
      <>
        {listenBody(listen)}
        {/* A stale list is still evidence, so a failed REFRESH is reported under
            it instead of replacing what the last probe actually saw. */}
        {listenError !== undefined && <div className="rvs-ports-hint">{listenError}</div>}
      </>
    )
  }

  return (
    <div className="rvs-pane grow">
      <div className="rvs-header">
        <span className="rvs-title">{t('tab.ports')}</span>
        <select
          className="rvs-select"
          value={effectiveAlias}
          onChange={(e) => setAlias(e.target.value)}
          disabled={props.hosts.length === 0}
          title={t('ports.selectHost')}
          style={{ flex: 1, minWidth: 90 }}
        >
          {props.hosts.map(host => (
            <option key={host.alias} value={host.alias} style={optionStyle}>
              {host.alias} ({host.user}@{host.host})
            </option>
          ))}
        </select>
        <IconButton
          title={t('ports.refresh')}
          onClick={() => { void refresh() }}
          disabled={effectiveAlias === '' || busy.has('refresh')}
        >
          <IconRefresh size={14} />
        </IconButton>
      </div>

      {props.hosts.length === 0 && <div className="rvs-banner warn">{t('ports.noHosts')}</div>}
      {forwardError !== undefined && <div className="rvs-banner error">{forwardError}</div>}
      {restoreFailed.length > 0 && (
        <div className="rvs-banner warn rvs-ports-restore">
          <span>{t('ports.restoreFailed').replace('{count}', String(restoreFailed.length))}</span>
          <button
            type="button"
            className="rvs-chip"
            onClick={() => {
              // These rules have no live row to stop from, so forgetting them is
              // the only way to stop the retry/banner cycle on every mount.
              for (const rule of restoreFailed) forgetStoredRule(effectiveAlias, rule)
              setRestoreFailed([])
            }}
          >
            {t('ports.forgetFailed')}
          </button>
        </div>
      )}

      <div className="rvs-ports-body">
        <form
          className="rvs-ports-form"
          onSubmit={(event) => {
            event.preventDefault()
            void startManual()
          }}
        >
          <div className="rvs-ports-hint">{t('ports.remoteHostHint')}</div>
          <label className="rvs-ports-field">
            <span className="rvs-ports-label">{t('ports.remoteHost')}</span>
            <input
              className="rvs-input rvs-ports-input"
              value={remoteHost}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setRemoteHost(e.target.value)}
            />
          </label>
          <label className="rvs-ports-field">
            <span className="rvs-ports-label">{t('ports.remotePort')}</span>
            <input
              className="rvs-input rvs-ports-input"
              value={remotePort}
              inputMode="numeric"
              spellCheck={false}
              autoComplete="off"
              placeholder="5432"
              onChange={(e) => setRemotePort(e.target.value)}
            />
          </label>
          <label className="rvs-ports-field">
            <span className="rvs-ports-label">{t('ports.localPort')}</span>
            <input
              className="rvs-input rvs-ports-input"
              value={localPort}
              inputMode="numeric"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setLocalPort(e.target.value)}
            />
          </label>
          <div className="rvs-ports-form-actions">
            <button
              type="submit"
              className="rvs-chip primary"
              disabled={effectiveAlias === '' || busy.has('form')}
            >
              {t('ports.add')}
            </button>
          </div>
        </form>

        {actionError !== undefined && <div className="rvs-banner error">{actionError}</div>}

        <div className="rvs-ports-section">
          <div className="rvs-ports-sec-head">
            {t('ports.active')}
            {forwards !== undefined && <span className="rvs-ports-count">{forwards.length}</span>}
          </div>
          {renderForwards()}
        </div>

        <div className="rvs-ports-section">
          <div className="rvs-ports-sec-head">{t('ports.listening')}</div>
          {renderListen()}
        </div>
      </div>
    </div>
  )
}
