/**
 * Remote environment doctor panel: one screen of evidence about the host the
 * workspace lives on, plus "copy all" as plain text.
 *
 * Rendered as a fixed overlay (like the input dialog) instead of joining the
 * host list: the list lives in the DSH Settings dialog, and pushing it around
 * while the first paint of a probe is still in flight would be worse than a
 * layer on top of it.
 *
 * The run lives here, not in `HostsView`: the panel is mounted for exactly the
 * lifetime of one report (the host row supplies `key={alias}`), so an unmount
 * closes the door on a late answer instead of writing into the list. A second
 * mount for the same alias joins the in-flight probe rather than spending
 * another channel slot.
 *
 * Three states, one of which is `unknown` — see `doctor.ts`: an unanswered
 * probe is never rendered as "not installed"; the hint line under the table
 * says what "unknown" means so nobody reads a blank as a pass.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from './api.ts'
import {
  DOCTOR_STATE_KEY,
  DOCTOR_TIMEOUT_MS,
  doctorFailure,
  doctorScript,
  formatDoctorReport,
  parseDoctor,
  type DoctorItem,
} from './doctor.ts'
import { Btn, Spinner } from './ui.tsx'

function StateBadge(props: { item: DoctorItem; t: (key: string) => string }): ReactNode {
  return (
    <span className={`rvs-doctor-badge ${props.item.state}`}>
      {props.t(DOCTOR_STATE_KEY[props.item.state])}
    </span>
  )
}

/**
 * One in-flight probe per alias.
 *
 * A StrictMode/replay remount (and a close→reopen that lands inside the 20 s
 * budget) would otherwise start a second remote exec: another channel slot, and
 * for a password host another authentication. Joining the running promise keeps
 * "one button press = at most one probe" true.
 */
const inFlight = new Map<string, Promise<DoctorItem[]>>()

function probeOnce(alias: string): Promise<DoctorItem[]> {
  const running = inFlight.get(alias)
  if (running !== undefined) return running
  const settled = api.exec(alias, doctorScript(), DOCTOR_TIMEOUT_MS).then(
    result => parseDoctor(result.stdout, result.stderr, result.exitCode),
    // The request itself failed (dead link, host refused the route). That is not
    // an answer about any tool: every row is unknown, with the reason.
    (e: unknown) => doctorFailure(e instanceof Error ? e.message : String(e)),
  )
  const tracked = settled.finally(() => {
    if (inFlight.get(alias) === tracked) inFlight.delete(alias)
  })
  inFlight.set(alias, tracked)
  return tracked
}

/**
 * Copy the report and say whether it worked.
 *
 * `copyText` in `kit.tsx` swallows both failures and resolves either way, so a
 * panel using it would claim "copied" on a plain-HTTP origin where the clipboard
 * API is blocked — a lie in the one action that exists to get evidence out. This
 * returns the real outcome; the button then says which happened.
 */
async function copyReport(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Fall through: the clipboard API is unavailable over plain HTTP origins.
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}

export function DoctorPanel(props: {
  t: (key: string) => string
  alias: string
  onClose: () => void
}): ReactNode {
  const t = props.t
  /** `undefined` = the probe is still running. */
  const [items, setItems] = useState<DoctorItem[] | undefined>(undefined)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const alive = useRef(true)
  // Re-armed on every setup: a StrictMode/replay remount runs setup → cleanup →
  // setup, and a flag that only ever got set to false would freeze the panel on
  // "loading" for good. Declared BEFORE the run effect so it is re-armed first.
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const run = useCallback((): void => {
    void probeOnce(props.alias).then((next) => {
      if (alive.current) setItems(next)
    })
  }, [props.alias])

  useEffect(() => {
    run()
  }, [run])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // CAPTURE phase + stop: the panel lives inside the DSH Settings dialog,
      // whose own Escape handler would otherwise close the whole dialog (and the
      // report) together with this layer.
      e.stopPropagation()
      props.onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [props.onClose])

  const copy = (): void => {
    if (items === undefined) return
    void copyReport(formatDoctorReport(props.alias, items, t)).then((ok) => {
      if (alive.current) setCopyState(ok ? 'copied' : 'failed')
    })
  }

  const copyLabel = copyState === 'copied'
    ? t('doctor.copied')
    : copyState === 'failed'
      ? t('doctor.copyFailed')
      : t('doctor.copy')
  const title = t('doctor.title').replace('{alias}', props.alias)
  const hasUnknown = items !== undefined && items.some(item => item.state === 'unknown')

  return (
    <div
      className="rvs-doctor"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={props.onClose}
    >
      <div className="rvs-doctor-card" onClick={(e) => e.stopPropagation()}>
        <div className="rvs-doctor-head">
          <span className="rvs-doctor-title">{title}</span>
          <span style={{ flex: 1 }} />
          <Btn onClick={copy} disabled={items === undefined}>{copyLabel}</Btn>
          <Btn onClick={props.onClose}>{t('doctor.close')}</Btn>
        </div>
        {items === undefined
          ? (
              <div className="rvs-doctor-body">
                <div className="rvs-doctor-loading"><Spinner /> {t('doctor.loading')}</div>
              </div>
            )
          : (
              <div className="rvs-doctor-body">
                <table className="rvs-doctor-table">
                  <thead>
                    <tr>
                      <th>{t('doctor.colItem')}</th>
                      <th>{t('doctor.colState')}</th>
                      <th>{t('doctor.colDetail')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map(item => (
                      <tr key={item.key}>
                        <td className="rvs-doctor-item">{t(item.label)}</td>
                        <td><StateBadge item={item} t={t} /></td>
                        <td className="rvs-doctor-detail" title={item.detail}>{item.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        {hasUnknown && <div className="rvs-doctor-hint">{t('doctor.unknownHint')}</div>}
      </div>
    </div>
  )
}
