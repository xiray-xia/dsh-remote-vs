/**
 * Small inline input dialog (new file / folder / rename). Rendered as a
 * fixed overlay card; Enter confirms, Escape cancels.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Btn, inputStyle } from './ui.tsx'

export function InputDialog(props: {
  title: string
  label: string
  initial?: string
  placeholder?: string
  okText?: string
  onOk: (value: string) => void
  onCancel: () => void
}): ReactNode {
  const [value, setValue] = useState(props.initial ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const commit = (): void => {
    const trimmed = value.trim()
    if (trimmed === '') return
    props.onOk(trimmed)
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={props.onCancel}
    >
      <div
        style={{
          minWidth: 320,
          maxWidth: '90vw',
          background: 'Canvas',
          color: 'CanvasText',
          border: '1px solid rgba(127,127,127,.4)',
          borderRadius: 8,
          padding: 14,
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') props.onCancel()
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 8 }}>{props.title}</div>
        <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 4 }}>{props.label}</div>
        <input
          ref={inputRef}
          value={value}
          placeholder={props.placeholder}
          onChange={(e) => setValue(e.target.value)}
          style={inputStyle}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <Btn onClick={props.onCancel}>取消 / Cancel</Btn>
          <Btn kind="primary" onClick={commit}>{props.okText ?? '确定 / OK'}</Btn>
        </div>
      </div>
    </div>
  )
}
