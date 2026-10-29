/**
 * Live output panel for the long network verbs (fetch / pull / push / sync).
 *
 * The unary exec route can only answer after the fact, so a 20-minute Gerrit
 * push used to look like a frozen button. This panel is fed by the streaming
 * exec route: it shows the git/remote output while it runs, a running clock,
 * a stop button that really kills the remote process group, and keeps the full
 * (tail-capped) log for copying after the fact.
 *
 * Rendered through a PORTAL on `document.body`: the SCM panel lives inside the
 * sidebar's keep-alive slot, which the host hides with `display:none` when
 * another rail view is picked — and a `position: fixed` descendant of a hidden
 * ancestor disappears with it, taking the only cancel affordance of a running
 * push along. The portal keeps the panel (and its stop button) reachable.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  IconButton,
  IconChevronDown,
  IconChevronUp,
  IconClose,
  IconCopy,
  IconStop,
  MiniSpinner,
  copyText,
  toast,
} from '../vsc/kit.tsx'
import { formatElapsed } from '../exec-output.ts'

export type ExecPanelStatus = 'running' | 'done' | 'error' | 'cancelled'

export interface ExecPanelState {
  title: string
  output: string
  status: ExecPanelStatus
  /** Wall-clock start, so the timer survives re-renders. */
  startedAt: number
  elapsedMs: number
  /** One-line footer: exit code / duration / error. */
  exitText?: string
}

export interface ExecPanelProps {
  state: ExecPanelState
  onCancel: () => void
  onClose: () => void
  t: (key: string) => string
}

/** Status chip text: the running state also carries the clock. The exit-code
 *  detail belongs to the footer only, or it would be printed twice. */
function statusText(state: ExecPanelState, t: (key: string) => string): string {
  if (state.status === 'running') return `${t('exec.running')} · ${formatElapsed(state.elapsedMs)}`
  if (state.status === 'cancelled') return t('exec.cancelled')
  return `${state.status === 'done' ? t('exec.done') : t('exec.failed')} · ${formatElapsed(state.elapsedMs)}`
}

function panelBody(state: ExecPanelState, t: (key: string) => string): string {
  if (state.output !== '') return state.output
  return state.status === 'running' ? t('exec.waiting') : t('exec.noOutput')
}

export function ExecPanel(props: ExecPanelProps): ReactNode {
  const { state, t } = props
  /** Collapsed keeps the header (clock + stop) but gives the page its space back. */
  const [collapsed, setCollapsed] = useState(false)
  const bodyRef = useRef<HTMLPreElement>(null)
  /** Follow the tail while streaming, until the user scrolls up to read. */
  const followRef = useRef(true)
  useEffect(() => {
    const element = bodyRef.current
    if (element === null || collapsed || !followRef.current) return
    element.scrollTop = element.scrollHeight
  }, [state.output, state.status, collapsed])
  const onScroll = (): void => {
    const element = bodyRef.current
    if (element === null) return
    followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
  }
  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="rvs-execpanel" role="dialog" aria-label={state.title}>
      <div className="rvs-execpanel-head">
        <span className="rvs-execpanel-title" title={state.title}>{state.title}</span>
        <span className={`rvs-execpanel-status ${state.status}`}>{statusText(state, t)}</span>
        <span className="rvs-execpanel-spacer" />
        {state.status === 'running' && !collapsed && <MiniSpinner />}
        <IconButton
          title={t('exec.copy')}
          onClick={() => { void copyText(state.output).then(() => toast(t('exec.copied'))) }}
        >
          <IconCopy size={13} />
        </IconButton>
        <IconButton
          title={collapsed ? t('exec.expand') : t('exec.collapse')}
          onClick={() => { setCollapsed(value => !value) }}
        >
          {collapsed ? <IconChevronUp size={11} /> : <IconChevronDown size={11} />}
        </IconButton>
        {state.status === 'running'
          ? (
            <IconButton title={`${t('exec.cancel')} — ${t('exec.cancelHint')}`} danger onClick={props.onCancel}>
              <IconStop size={12} />
            </IconButton>
            )
          : (
            <IconButton title={t('common.close')} onClick={props.onClose}>
              <IconClose size={11} />
            </IconButton>
            )}
      </div>
      {collapsed ? null : (
        <pre ref={bodyRef} className="rvs-execpanel-body" aria-label={t('exec.log')} onScroll={onScroll}>
          {panelBody(state, t)}
        </pre>
      )}
      {state.exitText !== undefined && <div className="rvs-execpanel-foot">{state.exitText}</div>}
    </div>,
    document.body,
  )
}
