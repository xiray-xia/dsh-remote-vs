/**
 * Live output panel for the long network verbs (fetch / pull / push / sync).
 *
 * The unary exec route can only answer after the fact, so a 20-minute Gerrit
 * push used to look like a frozen button. This panel is fed by the streaming
 * exec route: it shows the git/remote output while it runs, a running clock,
 * a cancel button that really stops the remote process group, and keeps the
 * full (tail-capped) log for copying after the fact.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { IconButton, IconClose, IconCopy, MiniSpinner, copyText, toast } from '../vsc/kit.tsx'
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

/** Status chip text: the running state also carries the clock. */
function statusText(state: ExecPanelState, t: (key: string) => string): string {
  if (state.status === 'running') return `${t('exec.running')} · ${formatElapsed(state.elapsedMs)}`
  if (state.status === 'cancelled') return t('exec.cancelled')
  const code = state.exitText === undefined ? '' : state.exitText
  return `${state.status === 'done' ? t('exec.done') : t('exec.failed')} · ${formatElapsed(state.elapsedMs)}${code === '' ? '' : ` · ${code}`}`
}

export function ExecPanel(props: ExecPanelProps): ReactNode {
  const { state, t } = props
  const bodyRef = useRef<HTMLPreElement>(null)
  /** Follow the tail while streaming, until the user scrolls up to read. */
  const followRef = useRef(true)
  useEffect(() => {
    const element = bodyRef.current
    if (element === null || !followRef.current) return
    element.scrollTop = element.scrollHeight
  }, [state.output, state.status])
  const onScroll = (): void => {
    const element = bodyRef.current
    if (element === null) return
    followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
  }
  return (
    <div className="rvs-execpanel" role="dialog" aria-label={state.title}>
      <div className="rvs-execpanel-head">
        <span className="rvs-execpanel-title" title={state.title}>{state.title}</span>
        <span className={`rvs-execpanel-status ${state.status}`}>{statusText(state, t)}</span>
        <span className="rvs-execpanel-spacer" />
        {state.status === 'running' && <MiniSpinner />}
        <IconButton
          title={t('exec.copy')}
          onClick={() => { void copyText(state.output).then(() => toast(t('exec.copied'))) }}
        >
          <IconCopy size={13} />
        </IconButton>
        {state.status === 'running'
          ? (
            <IconButton title={t('exec.cancel')} danger onClick={props.onCancel}>
              <IconClose size={11} />
            </IconButton>
            )
          : (
            <IconButton title={t('common.close')} onClick={props.onClose}>
              <IconClose size={11} />
            </IconButton>
            )}
      </div>
      <pre ref={bodyRef} className="rvs-execpanel-body" onScroll={onScroll}>
        {state.output === '' ? t('exec.waiting') : state.output}
      </pre>
      {state.exitText !== undefined && <div className="rvs-execpanel-foot">{state.exitText}</div>}
    </div>
  )
}
