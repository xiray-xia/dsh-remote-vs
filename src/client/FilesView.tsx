/**
 * Files view: workspace file tree (lazy SFTP listings) + multi-open editor
 * tabs (CodeMirror) + new/rename/delete with inline dialogs.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { RemoteFileEntry, RemoteWorkspaceBinding } from '../protocol.ts'
import { RemoteApiError, api } from './api.ts'
import { CodeEditor, type CodeEditorHandle } from './CodeEditor.tsx'
import { InputDialog } from './Dialog.tsx'
import { Btn, Notice, Row, hairline, optionStyle, selectStyle } from './ui.tsx'

function err(e: unknown): string {
  return e instanceof RemoteApiError ? e.message : String(e)
}

function dirKey(alias: string, dir: string): string {
  return `${alias}:${dir}`
}

/** Join a remote dir with a user-supplied name; rejects escapes. */
function joinRemote(dir: string, name: string): string {
  const clean = name.replace(/\\/g, '/').trim().replace(/^\/+/, '')
  if (clean === '' || clean.split('/').some(seg => seg === '' || seg === '.' || seg === '..')) {
    throw new Error(`invalid name: ${name}`)
  }
  return (dir.endsWith('/') ? dir.slice(0, -1) : dir) + '/' + clean
}

interface OpenFile {
  key: string
  alias: string
  path: string
  loading: boolean
  binary: boolean
  truncated: boolean
  content: string
  dirty: boolean
  error?: string
}

const WS_STORE = 'dsh-remote-vs.files.ws'

export function FilesView(props: {
  t: (k: string) => string
  workspaces: RemoteWorkspaceBinding[]
  openWorkspaceId: string | undefined
  onWorkspaceOpened: () => void
  visible: boolean
}): ReactNode {
  const t = props.t
  const [wsId, setWsId] = useState<string>(() => {
    try {
      return localStorage.getItem(WS_STORE) ?? ''
    } catch {
      return ''
    }
  })
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [listings, setListings] = useState<Record<string, RemoteFileEntry[]>>({})
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<RemoteFileEntry | undefined>(undefined)
  const [open, setOpen] = useState<OpenFile[]>([])
  const [activeKey, setActiveKey] = useState<string | undefined>(undefined)
  const [dialog, setDialog] = useState<{ kind: 'file' | 'folder' | 'rename' } | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const editorRef = useRef<CodeEditorHandle>(null)
  // Tree/editor split ratio (tree share of the split area). Draggable divider.
  const [treeRatio, setTreeRatio] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem('dsh-remote-vs.treeRatio'))
      return Number.isFinite(saved) && saved > 0.12 && saved < 0.88 ? saved : 0.38
    } catch {
      return 0.38
    }
  })
  const treeRatioRef = useRef(treeRatio)
  const [dividerHot, setDividerHot] = useState(false)
  const [dragging, setDragging] = useState(false)
  const splitRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startY: number; startRatio: number } | undefined>(undefined)

  const workspace = props.workspaces.find((w) => w.id === wsId) ?? props.workspaces[0]
  const effectiveWsId = workspace?.id ?? ''

  // Deep link from the workspaces view ("open files").
  useEffect(() => {
    if (props.openWorkspaceId !== undefined && props.openWorkspaceId !== '') {
      setWsId(props.openWorkspaceId)
      props.onWorkspaceOpened()
    }
  }, [props.openWorkspaceId, props.onWorkspaceOpened])

  useEffect(() => {
    try {
      if (effectiveWsId !== '') localStorage.setItem(WS_STORE, effectiveWsId)
    } catch {
      // Private mode: ignore.
    }
  }, [effectiveWsId])

  const loadDir = useCallback(async (alias: string, dir: string, force = false): Promise<void> => {
    const key = dirKey(alias, dir)
    setListings((prev) => {
      if (!force && prev[key] !== undefined) return prev
      return prev
    })
    setLoadingDirs((prev) => {
      if (prev.has(key)) return prev
      const next = new Set(prev)
      next.add(key)
      return next
    })
    try {
      const entries = await api.fileOp.list(alias, dir)
      setListings((prev) => ({ ...prev, [key]: entries }))
      setError(undefined)
    } catch (e) {
      setError(err(e))
    } finally {
      setLoadingDirs((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }, [])

  // Load the workspace root on selection.
  useEffect(() => {
    if (workspace === undefined) return
    const key = dirKey(workspace.alias, workspace.remotePath)
    setExpanded((prev) => {
      if (prev.has(key)) return prev
      const next = new Set(prev)
      next.add(key)
      return next
    })
    void loadDir(workspace.alias, workspace.remotePath)
  }, [workspace?.alias, workspace?.remotePath, loadDir]) // eslint-disable-line react-hooks/exhaustive-deps

  // Warn on page unload with unsaved edits.
  useEffect(() => {
    const dirty = open.some((f) => f.dirty)
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (!dirty) return
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [open])

  const toggleDir = (alias: string, entry: RemoteFileEntry): void => {
    const key = dirKey(alias, entry.path)
    setSelected(entry)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
        void loadDir(alias, entry.path)
      }
      return next
    })
  }

  // Divider drag: pointer capture + left-button gate (no hover-follow), ratio
  // persisted on release.
  const onDividerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // Older engine: fall back to window listeners via buttons gate.
    }
    dragRef.current = { startY: e.clientY, startRatio: treeRatioRef.current }
    setDragging(true)
    setDividerHot(true)
  }
  const onDividerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === undefined) return
    if ((e.buttons & 1) === 0) {
      // Button released outside capture (safety net, no hover-follow).
      dragRef.current = undefined
      setDragging(false)
      setDividerHot(false)
      return
    }
    const total = splitRef.current?.clientHeight ?? 0
    if (total < 160) return
    const next = drag.startRatio + (e.clientY - drag.startY) / total
    const clamped = Math.min(0.85, Math.max(0.12, next))
    treeRatioRef.current = clamped
    setTreeRatio(clamped)
  }
  const onDividerEnd = (): void => {
    if (dragRef.current === undefined) return
    dragRef.current = undefined
    setDragging(false)
    setDividerHot(false)
    try {
      localStorage.setItem('dsh-remote-vs.treeRatio', String(treeRatioRef.current))
    } catch {
      // Private mode: ignore.
    }
  }

  const openFile = (alias: string, entry: RemoteFileEntry): void => {
    setSelected(entry)
    if (entry.isDir) {
      toggleDir(alias, entry)
      return
    }
    const key = dirKey(alias, entry.path)
    const existing = open.find((f) => f.key === key)
    if (existing !== undefined) {
      setActiveKey(key)
      return
    }
    const draft: OpenFile = { key, alias, path: entry.path, loading: true, binary: false, truncated: false, content: '', dirty: false }
    setOpen((prev) => [...prev, draft])
    setActiveKey(key)
    api.fileOp.read(alias, entry.path).then(
      (r) => {
        setOpen((prev) => prev.map((f) => (f.key === key
          ? { ...f, loading: false, binary: r.binary, truncated: r.truncated, content: r.binary ? '' : (r.text ?? '') }
          : f)))
      },
      (e: unknown) => {
        setOpen((prev) => prev.map((f) => (f.key === key ? { ...f, loading: false, error: err(e) } : f)))
      },
    )
  }

  const closeFile = (key: string): void => {
    const target = open.find((f) => f.key === key)
    if (target?.dirty === true && !window.confirm(t('editor.unsaved'))) return
    setOpen((prev) => prev.filter((f) => f.key !== key))
    if (activeKey === key) {
      const rest = open.filter((f) => f.key !== key)
      setActiveKey(rest[rest.length - 1]?.key)
    }
  }

  const saveActive = useCallback((): void => {
    const active = open.find((f) => f.key === activeKey)
    const handle = editorRef.current
    if (active === undefined || handle === null || active.binary || active.truncated || active.loading) return
    const content = handle.getContent()
    setNotice(undefined)
    setError(undefined)
    api.fileOp.write(active.alias, active.path, content).then(
      () => {
        handle.markSaved()
        setOpen((prev) => prev.map((f) => (f.key === active.key ? { ...f, content, dirty: false } : f)))
        setNotice(t('editor.saved'))
      },
      (e: unknown) => setError(err(e)),
    )
  }, [open, activeKey, t])

  const reloadContext = (): void => {
    if (workspace === undefined) return
    const base = selected !== undefined
      ? selected.isDir ? selected.path : selected.path.split('/').slice(0, -1).join('/') || '/'
      : workspace.remotePath
    void loadDir(workspace.alias, base, true)
  }

  const createEntry = (kind: 'file' | 'folder', name: string): void => {
    if (workspace === undefined) return
    const base = selected !== undefined
      ? selected.isDir ? selected.path : selected.path.split('/').slice(0, -1).join('/') || '/'
      : workspace.remotePath
    let target: string
    try {
      target = joinRemote(base, name)
    } catch (e) {
      setError(err(e))
      setDialog(undefined)
      return
    }
    setDialog(undefined)
    const task = kind === 'file' ? api.fileOp.write(workspace.alias, target, '') : api.fileOp.mkdir(workspace.alias, target)
    task.then(
      () => {
        setNotice(target)
        setError(undefined)
        void loadDir(workspace.alias, base, true)
        setExpanded((prev) => new Set(prev).add(dirKey(workspace.alias, base)))
      },
      (e: unknown) => setError(err(e)),
    )
  }

  const renameSelected = (name: string): void => {
    if (workspace === undefined || selected === undefined) return
    const parent = selected.path.split('/').slice(0, -1).join('/') || '/'
    let target: string
    try {
      target = joinRemote(parent, name)
    } catch (e) {
      setError(err(e))
      setDialog(undefined)
      return
    }
    setDialog(undefined)
    api.fileOp.rename(workspace.alias, selected.path, target).then(
      () => {
        setNotice(target)
        setError(undefined)
        setSelected(undefined)
        // Drop open tabs under the old path.
        setOpen((prev) => prev.filter((f) => !(f.alias === workspace.alias && (f.path === selected.path || f.path.startsWith(selected.path + '/')))))
        void loadDir(workspace.alias, parent, true)
      },
      (e: unknown) => setError(err(e)),
    )
  }

  const deleteSelected = (): void => {
    if (workspace === undefined || selected === undefined) return
    const message = selected.isDir ? t('files.deleteRecursive') : t('files.deleteConfirm')
    if (!window.confirm(`${message}\n${selected.path}`)) return
    api.fileOp.rm(workspace.alias, selected.path, selected.isDir).then(
      () => {
        setNotice(`deleted ${selected.path}`)
        setError(undefined)
        setOpen((prev) => prev.filter((f) => !(f.alias === workspace.alias && (f.path === selected.path || f.path.startsWith(selected.path + '/')))))
        const parent = selected.path.split('/').slice(0, -1).join('/') || '/'
        setSelected(undefined)
        void loadDir(workspace.alias, parent, true)
      },
      (e: unknown) => setError(err(e)),
    )
  }

  if (workspace === undefined) {
    return <div style={{ opacity: 0.7 }}>{t('files.selectWorkspace')} —</div>
  }

  const active = open.find((f) => f.key === activeKey)
  const filesOpen = open.length > 0
  const treePct = `${Math.round(treeRatio * 1000) / 10}%`
  const dividerActive = dividerHot || dragging

  const renderTree = (alias: string, dir: string, depth: number): ReactNode => {
    const key = dirKey(alias, dir)
    const rows = listings[key]
    if (loadingDirs.has(key) && rows === undefined) {
      return <div style={{ paddingLeft: depth * 14 + 8, opacity: 0.6, fontSize: 12 }}>{t('files.loading')}</div>
    }
    if (rows === undefined) return null
    return (
      <>
        {rows.map((entry) => {
          const rowKey = dirKey(alias, entry.path)
          const isOpen = expanded.has(rowKey)
          const isSelected = selected?.path === entry.path && selected !== undefined
          return (
            <div key={rowKey}>
              <div
                onClick={() => openFile(alias, entry)}
                title={entry.path}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '2px 6px 2px 8px',
                  paddingLeft: depth * 14 + 8,
                  cursor: 'pointer',
                  fontSize: 13,
                  background: isSelected ? 'rgba(77,107,254,.2)' : undefined,
                  borderRadius: 4,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                <span style={{ width: 12, opacity: entry.isDir ? 1 : 0 }}>{isOpen ? '▾' : '▸'}</span>
                <span>{entry.isDir ? '📁' : entry.isSymlink ? '🔗' : '📄'}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.name}</span>
              </div>
              {entry.isDir && isOpen && renderTree(alias, entry.path, depth + 1)}
            </div>
          )
        })}
      </>
    )
  }

  return (
    <div ref={splitRef} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ flex: 'none' }}>
      <Row>
        <span style={{ fontSize: 12, opacity: 0.75 }}>{t('files.selectWorkspace')}</span>
        <select
          value={effectiveWsId}
          onChange={(e) => { setWsId(e.target.value); setSelected(undefined) }}
          style={{ ...selectStyle, flex: 1 }}
        >
          {props.workspaces.map((w) => <option key={w.id} value={w.id} style={optionStyle}>{w.name} ({w.alias}:{w.remotePath})</option>)}
        </select>
      </Row>
      {notice !== undefined && <Notice kind="info">{notice}</Notice>}
      {error !== undefined && <Notice kind="error">{error}</Notice>}
      <div style={{ marginTop: 8 }}>
        <Row>
          <Btn onClick={() => setDialog({ kind: 'file' })}>{t('files.newFile')}</Btn>
          <Btn onClick={() => setDialog({ kind: 'folder' })}>{t('files.newFolder')}</Btn>
          <Btn onClick={() => selected !== undefined && setDialog({ kind: 'rename' })} disabled={selected === undefined}>✏️</Btn>
          <Btn kind="danger" onClick={deleteSelected} disabled={selected === undefined}>🗑</Btn>
          <Btn onClick={() => workspace !== undefined && void loadDir(workspace.alias, workspace.remotePath, true)}>{t('files.refresh')}</Btn>
        </Row>
      </div>
      </div>
      <div style={filesOpen
        ? { ...hairline, marginTop: 8, paddingTop: 6, flex: 'none', height: treePct, minHeight: 60, overflow: 'auto' }
        : { ...hairline, marginTop: 8, paddingTop: 6, flex: 1, minHeight: 120, overflow: 'auto' }}>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>
          <code>{workspace.alias}:{workspace.remotePath}</code>
        </div>
        {renderTree(workspace.alias, workspace.remotePath, 0)}
      </div>
      {filesOpen && (
        <div
          onPointerDown={onDividerDown}
          onPointerMove={onDividerMove}
          onPointerUp={onDividerEnd}
          onPointerCancel={onDividerEnd}
          onMouseEnter={() => setDividerHot(true)}
          onMouseLeave={() => { if (!dragging) setDividerHot(false) }}
          title="拖拽调整文件树 / 编辑器占比"
          style={{ flex: 'none', height: 10, marginTop: 2, cursor: 'row-resize', display: 'flex', alignItems: 'center', touchAction: 'none', userSelect: 'none' }}
        >
          <div style={{ height: dividerActive ? 3 : 1, flex: 1, borderRadius: 2, background: dividerActive ? 'rgba(77,107,254,.9)' : 'rgba(127,127,127,.35)' }} />
        </div>
      )}
      {filesOpen && (
        <div style={{ flex: 1, minHeight: 120, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6, flex: 'none' }}>
            {open.map((f) => (
              <span
                key={f.key}
                onClick={() => setActiveKey(f.key)}
                style={{
                  fontSize: 12,
                  padding: '2px 6px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  background: f.key === activeKey ? 'rgba(77,107,254,.25)' : 'rgba(127,127,127,.15)',
                }}
                title={f.path}
              >
                {f.path.split('/').pop()}{f.dirty ? ' ●' : ''}
                {' '}
                <span
                  onClick={(e) => { e.stopPropagation(); closeFile(f.key) }}
                  style={{ opacity: 0.6, cursor: 'pointer' }}
                  title={t('common.close')}
                >
                  ✕
                </span>
              </span>
            ))}
          </div>
          {active !== undefined && (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              {active.loading && <div style={{ fontSize: 12, opacity: 0.7 }}>{t('files.loading')}</div>}
              {active.error !== undefined && <Notice kind="error">{active.error}</Notice>}
              {active.binary && <Notice kind="info">{t('editor.binary')}</Notice>}
              {active.truncated && <Notice kind="info">{t('editor.truncated')}</Notice>}
              {!active.loading && !active.binary && active.error === undefined && (
                <>
                  <div style={{ flex: 'none' }}>
                  <Row>
                    <code style={{ fontSize: 11, opacity: 0.7, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{active.path}</code>
                    <span style={{ fontSize: 12, opacity: active.dirty ? 1 : 0.5 }}>{active.dirty ? t('editor.unsaved') : ''}</span>
                    <Btn kind="primary" onClick={saveActive} disabled={active.truncated || !active.dirty}>{t('editor.save')}</Btn>
                  </Row>
                  </div>
                  <div style={{ flex: 1, minHeight: 0, marginTop: 6, border: '1px solid rgba(127,127,127,.25)', borderRadius: 6, overflow: 'hidden' }}>
                    <CodeEditor
                      key={active.key}
                      ref={editorRef}
                      initial={active.content}
                      path={active.path}
                      readOnly={active.truncated}
                      visible={props.visible}
                      onSave={saveActive}
                      onDirty={(dirty) => setOpen((prev) => prev.map((f) => (f.key === active.key ? { ...f, dirty } : f)))}
                    />
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {dialog?.kind === 'file' && (
        <InputDialog title={t('files.newFile')} label={t('files.namePrompt')} onOk={(v) => createEntry('file', v)} onCancel={() => setDialog(undefined)} />
      )}
      {dialog?.kind === 'folder' && (
        <InputDialog title={t('files.newFolder')} label={t('files.namePrompt')} onOk={(v) => createEntry('folder', v)} onCancel={() => setDialog(undefined)} />
      )}
      {dialog?.kind === 'rename' && selected !== undefined && (
        <InputDialog
          title={t('files.renamePrompt')}
          label={selected.path}
          initial={selected.name}
          onOk={renameSelected}
          onCancel={() => setDialog(undefined)}
        />
      )}
    </div>
  )
}
