/**
 * Remote directory picker modal (native-picker-styled): path field + Go,
 * Home/Up shortcuts, scrollable directory list, pick-current-folder commit.
 * Directory-only listing over the files API; entering a symlink resolves
 * server-side (a link-to-file surfaces as a readable error).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { RemoteFileEntry } from '../protocol.ts'
import { RemoteApiError, api } from './api.ts'
import { Btn } from './ui.tsx'

export function RemoteDirectoryPicker(props: {
  t: (k: string) => string
  open: boolean
  title: string
  alias: string
  initialPath: string
  onPick: (path: string) => void
  onCancel: () => void
}): ReactNode {
  const t = props.t
  const [path, setPath] = useState(props.initialPath)
  const [draft, setDraft] = useState(props.initialPath)
  const [entries, setEntries] = useState<RemoteFileEntry[]>([])
  const [home, setHome] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const generation = useRef(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const cancelRef = useRef(props.onCancel)
  cancelRef.current = props.onCancel
  const openRef = useRef(props.open)
  openRef.current = props.open

  const browse = async (dir: string): Promise<void> => {
    const gen = ++generation.current
    setLoading(true)
    setError(undefined)
    try {
      const rows = await api.fileOp.list(props.alias, dir)
      if (gen !== generation.current) return
      setPath(dir)
      setDraft(dir)
      setEntries(rows.filter((r) => r.isDir || r.isSymlink))
    } catch (e) {
      if (gen === generation.current) setError(e instanceof RemoteApiError ? e.message : String(e))
    } finally {
      if (gen === generation.current) setLoading(false)
    }
  }

  useEffect(() => {
    if (!props.open) return
    generation.current += 1
    setEntries([])
    setError(undefined)
    const start = props.initialPath.trim() !== '' ? props.initialPath.trim() : undefined
    // Resolve $HOME once for the Home shortcut (failure falls back to /).
    api.exec(props.alias, 'printf %s "$HOME"', 15000).then(
      (r) => {
        const h = r.success ? r.stdout.trim() : ''
        if (h.startsWith('/')) setHome(h)
      },
      () => undefined,
    )
    void browse(start ?? '/')
    return () => {
      generation.current += 1
    }
    // Open-once per mount of the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.alias])

  /**
   * Keyboard/focus management for the modal.
   *
   * Opening focuses the path field; Escape works from ANY focus position (it
   * used to be an `onKeyDown` on the inner box, so it only fired while focus was
   * already inside — the usual state right after opening was "outside"); Tab is
   * trapped; closing puts focus back where it came from.
   */
  useEffect(() => {
    if (!props.open) return
    openerRef.current = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        cancelRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const box = boxRef.current
      if (box === null) return
      const items = Array.from(box.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ))
      if (items.length === 0) return
      const first = items[0] as HTMLElement
      const last = items[items.length - 1] as HTMLElement
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === null || !box.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('keydown', onKey)
      const opener = openerRef.current
      if (opener !== null && document.body.contains(opener)) opener.focus()
    }
  }, [props.open])

  if (!props.open) return null

  const parent = path !== '/' ? path.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/' : undefined
  const go = (): void => {
    const target = draft.trim()
    if (target !== '') void browse(target)
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,.45)' }}
      role="dialog"
      aria-modal="true"
      aria-label={props.title}
      onClick={props.onCancel}
    >
      <div
        ref={boxRef}
        style={{
          width: 'min(560px, calc(100vw - 32px))',
          maxHeight: 'min(640px, calc(100vh - 32px))',
          display: 'flex',
          flexDirection: 'column',
          background: 'Canvas',
          color: 'CanvasText',
          border: '1px solid rgba(127,127,127,.4)',
          borderRadius: 8,
          padding: 14,
          fontSize: 13,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 600, marginBottom: 8 }}>{props.title}</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') go()
            }}
            placeholder="/home/user/project"
            spellCheck={false}
            style={{ flex: 1, background: 'rgba(127,127,127,.12)', color: 'inherit', border: '1px solid rgba(127,127,127,.35)', borderRadius: 6, padding: '4px 8px', fontSize: 13, fontFamily: 'inherit', outline: 'none' }}
          />
          <Btn onClick={go} disabled={loading || draft.trim() === ''}>{t('dirPicker.go')}</Btn>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <Btn onClick={() => home !== '' && void browse(home)} disabled={loading || home === ''}>{t('dirPicker.home')}</Btn>
          <Btn onClick={() => parent !== undefined && void browse(parent)} disabled={loading || parent === undefined}>{t('dirPicker.up')}</Btn>
          <code style={{ fontSize: 12, opacity: 0.75, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{path}</code>
        </div>
        <div style={{ flex: 1, minHeight: 140, maxHeight: 320, overflowY: 'auto', border: '1px solid rgba(127,127,127,.3)', borderRadius: 6, padding: 4 }}>
          {entries.map((entry) => (
            <div
              key={entry.path}
              onClick={() => void browse(entry.path)}
              title={entry.path}
              style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '3px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(77,107,254,.18)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
              }}
            >
              <span>{entry.isSymlink ? '🔗' : '📁'}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
            </div>
          ))}
          {!loading && entries.length === 0 && error === undefined && (
            <div style={{ padding: 8, opacity: 0.6, fontSize: 12 }}>{t('dirPicker.empty')}</div>
          )}
          {loading && <div style={{ padding: 8, opacity: 0.6, fontSize: 12 }}>{t('common.loading')}</div>}
        </div>
        {error !== undefined && (
          <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 6, fontSize: 12, background: 'rgba(200,60,60,.15)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {error}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <Btn onClick={props.onCancel}>{t('hosts.cancel')}</Btn>
          <Btn kind="primary" onClick={() => props.onPick(path)} disabled={loading}>{t('dirPicker.select')}</Btn>
        </div>
      </div>
    </div>
  )
}
