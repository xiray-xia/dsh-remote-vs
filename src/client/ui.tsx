/**
 * Shared presentational bits: theme-inheriting inline styles (transparent
 * surfaces, currentColor text, hairline borders) that read well in both
 * DSH light and dark themes without knowing token names.
 */
import type { CSSProperties, ReactNode } from 'react'

export const hairline: CSSProperties = { borderTop: '1px solid rgba(127,127,127,.25)' }

export const inputStyle: CSSProperties = {
  background: 'rgba(127,127,127,.12)',
  color: 'inherit',
  border: '1px solid rgba(127,127,127,.35)',
  borderRadius: 6,
  padding: '4px 8px',
  fontSize: 13,
  fontFamily: 'inherit',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
}

export const btnStyle: CSSProperties = {
  background: 'rgba(127,127,127,.15)',
  color: 'inherit',
  border: '1px solid rgba(127,127,127,.35)',
  borderRadius: 6,
  padding: '3px 10px',
  fontSize: 12,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

export const btnPrimaryStyle: CSSProperties = {
  ...btnStyle,
  background: 'rgba(77,107,254,.25)',
  borderColor: 'rgba(77,107,254,.6)',
}

export const btnDangerStyle: CSSProperties = {
  ...btnStyle,
  background: 'rgba(200,60,60,.15)',
  borderColor: 'rgba(200,60,60,.5)',
}

export function Btn(props: {
  onClick: () => void
  disabled?: boolean
  kind?: 'normal' | 'primary' | 'danger'
  title?: string
  children: ReactNode
}): ReactNode {
  const style = props.kind === 'primary' ? btnPrimaryStyle : props.kind === 'danger' ? btnDangerStyle : btnStyle
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled === true}
      title={props.title}
      style={{ ...style, opacity: props.disabled === true ? 0.5 : 1 }}
    >
      {props.children}
    </button>
  )
}

export function Notice(props: { kind: 'info' | 'error'; children: ReactNode }): ReactNode {
  return (
    <div
      style={{
        margin: '8px 0',
        padding: '6px 10px',
        borderRadius: 6,
        fontSize: 12,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        background: props.kind === 'error' ? 'rgba(200,60,60,.15)' : 'rgba(127,127,127,.15)',
      }}
    >
      {props.children}
    </div>
  )
}

export function Field(props: { label: string; children: ReactNode }): ReactNode {
  return (
    <label style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
      <span style={{ display: 'block', opacity: 0.75, marginBottom: 3 }}>{props.label}</span>
      {props.children}
    </label>
  )
}

export function Row(props: { children: ReactNode; gap?: number }): ReactNode {
  return <div style={{ display: 'flex', alignItems: 'center', gap: props.gap ?? 8, flexWrap: 'wrap' }}>{props.children}</div>
}
