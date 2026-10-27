/**
 * The floating editor window: the plugin's ONE editor pane hosted in a
 * draggable, resizable frame above the app shell.
 *
 * It is mounted by the client entry into the host's frame-wide overlay slot
 * (`shell.overlay`) and reads the same module-level store as every other
 * surface, so tabs / previews / diffs / find / change marks / undo / @file are
 * not a re-implementation: this file only owns the FRAME (position, size,
 * z-order, drag + resize + zoom) and the handoff around the mount swap.
 *
 * The mount is exclusive: `EditorPane` must exist exactly once, so the centre
 * conversation view and the sidebar fallback render a placeholder while
 * `editorSurface === 'float'` (see `FloatingEditorPlaceholder`).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { EditorPane } from './EditorPane.tsx'
import { useBootstrap, useExplorer, setFloatEditorAvailable } from './store.tsx'
import { DialogHost, IconClose } from './vsc/kit.tsx'
import {
  FLOAT_FONT_DEFAULT,
  FLOAT_TITLEBAR_HEIGHT,
  clampFloatRect,
  defaultFloatRect,
  dragFloatRect,
  maximizeFloatRect,
  parseFloatFontSize,
  parseFloatRect,
  resizeFloatRect,
  serializeFloatRect,
  stepFloatZoom,
  type FloatRect,
  type FloatResizeHandle,
} from './float-editor.ts'

/** Where the last window rect is remembered (per browser/profile). */
const RECT_KEY = 'dsh-remote-vs.float.rect'
/** Where the last editor font size is remembered. */
const FONT_KEY = 'dsh-remote-vs.float.font'

/** The resize grips, in the order they are rendered. */
const RESIZE_HANDLES: readonly FloatResizeHandle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

type DragState =
  | { kind: 'move'; pointerX: number; pointerY: number; rect: FloatRect }
  | { kind: 'resize'; handle: FloatResizeHandle; pointerX: number; pointerY: number; rect: FloatRect }

function readViewport(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight }
}

function readStoredRect(): FloatRect {
  const viewport = readViewport()
  try {
    const stored = parseFloatRect(localStorage.getItem(RECT_KEY), viewport)
    if (stored !== undefined) return stored
  } catch {
    // Private mode: the default rect is fine.
  }
  return defaultFloatRect(viewport)
}

function readStoredFontSize(): number {
  try {
    return parseFloatFontSize(localStorage.getItem(FONT_KEY))
  } catch {
    return FLOAT_FONT_DEFAULT
  }
}

/** The window frame plus the editor. `ctx` is only needed for the boot hook. */
export function FloatingEditorWindow(props: { ctx: Context }): ReactNode {
  useBootstrap(props.ctx)
  const store = useExplorer()
  const t = store.t
  const open = store.floatOpen
  const activeTab = store.activeTab

  const [rect, setRect] = useState<FloatRect | undefined>(undefined)
  const [viewport, setViewport] = useState(() => (typeof window === 'undefined' ? { width: 0, height: 0 } : readViewport()))
  const [fontSize, setFontSize] = useState(FLOAT_FONT_DEFAULT)
  const [maximized, setMaximized] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [dragging, setDragging] = useState(false)

  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  const dragRef = useRef<DragState | undefined>(undefined)
  /** The normal (non-maximized) rect, restored by the restore button. */
  const restoreRectRef = useRef<FloatRect | undefined>(undefined)
  const bodyRef = useRef<HTMLDivElement>(null)
  /** Latest font size, so the wheel handler never has to read stale state. */
  const fontRef = useRef(fontSize)
  fontRef.current = fontSize
  /** True once the frame has a resolved rect (body/zoom effects depend on it). */
  const rectReady = rect !== undefined
  /** Previous `open`, so "opened again" can reset the minimized state. */
  const wasOpenRef = useRef(open)

  /** The geometry a gesture points at right now (used for move AND finalize). */
  const resolveDrag = (drag: DragState, pointerX: number, pointerY: number): FloatRect => {
    const dx = pointerX - drag.pointerX
    const dy = pointerY - drag.pointerY
    return drag.kind === 'move'
      ? dragFloatRect(drag.rect, dx, dy, viewportRef.current)
      : resizeFloatRect(drag.rect, drag.handle, dx, dy, viewportRef.current)
  }

  /**
   * Runtime handshake with the store (see `setFloatEditorAvailable`): the menu
   * entry is enabled only once this component really mounted inside the host's
   * overlay slot. A host without that slot never reaches this effect.
   */
  useEffect(() => {
    setFloatEditorAvailable(true)
    return () => setFloatEditorAvailable(false)
  }, [])

  // First open: resolve the persisted frame (or the default one).
  useEffect(() => {
    if (!open || rect !== undefined) return
    const next = readViewport()
    setViewport(next)
    setRect(readStoredRect())
    setFontSize(readStoredFontSize())
  }, [open, rect])

  /**
   * A window that was minimized when it was docked must not come back as a
   * bare 34px title bar: "open in floating editor" would look broken. Every
   * fresh open starts expanded; a minimize made WHILE open is kept.
   */
  useEffect(() => {
    if (open && !wasOpenRef.current) setCollapsed(false)
    wasOpenRef.current = open
  }, [open])

  // The browser window changed size: a maximized frame follows it, a free one
  // is clamped back on screen (a rect from a larger monitor must stay reachable).
  useEffect(() => {
    const onResize = (): void => {
      const next = readViewport()
      setViewport(next)
      setRect(prev => {
        if (prev === undefined) return prev
        return maximized ? maximizeFloatRect(next) : clampFloatRect(prev, next)
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [maximized])

  const persistRect = useCallback((next: FloatRect): void => {
    try {
      localStorage.setItem(RECT_KEY, serializeFloatRect(next))
    } catch {
      // Private mode: the frame simply is not remembered.
    }
  }, [])

  /**
   * Drag / resize move on the WINDOW, not on the grip: the pointer regularly
   * leaves the 4px handle mid-gesture, and pointer capture on a grip that
   * re-renders is easy to lose. One listener pair per gesture is enough.
   */
  useEffect(() => {
    if (!dragging) return
    const onMove = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (drag === undefined) return
      // A pointerup lost outside the window (another app, an iframe) must not
      // leave the frame glued to the cursor: the same `buttons` guard the
      // sidebar divider uses.
      if ((event.buttons & 1) === 0) {
        dragRef.current = undefined
        setDragging(false)
        return
      }
      setRect(resolveDrag(drag, event.clientX, event.clientY))
    }
    const onUp = (event: PointerEvent): void => {
      // The pointerup may arrive before React re-rendered the last move, so the
      // FINAL geometry is resolved from the event here instead of reading the
      // state (a persisted rect one move behind loses the last few pixels).
      const drag = dragRef.current
      dragRef.current = undefined
      setDragging(false)
      if (drag === undefined || maximized) return
      const final = resolveDrag(drag, event.clientX, event.clientY)
      setRect(final)
      persistRect(final)
    }
    /**
     * A cancelled gesture must NOT be finalised from the event: Chromium
     * reports `clientX/clientY = 0` on pointercancel, which would clamp the
     * window to the top-left corner and PERSIST that. Keep the last painted
     * rect instead.
     */
    const onCancel = (): void => {
      dragRef.current = undefined
      setDragging(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [dragging, maximized, persistRect])

  /**
   * Ctrl/Cmd + wheel zooms the EDITOR TEXT, not the page.
   *
   * A native listener is required: React's `onWheel` is passive at the root, so
   * `preventDefault()` there would be ignored (the browser would page-zoom).
   * CodeMirror picks the new size up through its ResizeObserver; the dispatched
   * resize event is the belt for hosts where the observer does not fire.
   */
  useEffect(() => {
    const element = bodyRef.current
    if (element === null) return
    const onWheel = (event: WheelEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return
      event.preventDefault()
      const next = stepFloatZoom(fontRef.current, event.deltaY)
      if (next === fontRef.current) return
      // Side effects stay OUT of a state updater: an updater may run twice
      // (StrictMode/concurrent), which would double-dispatch the resize event.
      fontRef.current = next
      setFontSize(next)
      try {
        localStorage.setItem(FONT_KEY, String(next))
      } catch {
        // Private mode: zoom still works for this session.
      }
      window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [open, collapsed, rectReady])

  const beginDrag = (event: ReactPointerEvent, drag: DragState): void => {
    if (event.button !== 0) return
    event.preventDefault()
    // Pointer capture keeps the gesture alive over an `<iframe>` (an HTML
    // preview tab in the window) and over any element that would otherwise
    // swallow the pointer. The window-level listeners still do the maths.
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Older engine: the window-level listeners still see the events.
    }
    dragRef.current = drag
    setDragging(true)
  }

  const toggleMaximize = (): void => {
    if (rect === undefined) return
    const next = readViewport()
    setViewport(next)
    if (maximized) {
      setMaximized(false)
      // A restore always restores an expanded window (a minimized+maximized
      // frame would otherwise stay at 34px with maximized=false).
      setCollapsed(false)
      setRect(clampFloatRect(restoreRectRef.current ?? defaultFloatRect(next), next))
      return
    }
    restoreRectRef.current = rect
    setMaximized(true)
    setCollapsed(false)
    setRect(maximizeFloatRect(next))
  }

  const toggleCollapse = (): void => {
    setCollapsed(previous => !previous)
  }

  /**
   * The body subtree is memoised on `collapsed` alone so a drag/resize update
   * (one per pointermove) does not re-render the whole EditorPane through the
   * parent: the element identity stays stable while only the frame geometry
   * moves. The pane is still hidden, never unmounted, while minimized — it owns
   * the live CodeMirror buffer.
   *
   * HOOK ORDER: this must stay ABOVE the `!open || rect === undefined` early
   * return. Hooks cannot be skipped on a render, and the first open reaches
   * this line one render later than every previous render did — placing it
   * below the return throws "Rendered more hooks than during the previous
   * render" exactly when the feature is used (in production too; React's
   * error 310 is not dev-only).
   */
  const body = useMemo(() => (
    <div className="rvs-float-body" ref={bodyRef} style={{ display: collapsed ? 'none' : 'flex' }}>
      <EditorPane visible={!collapsed} />
    </div>
  ), [collapsed])

  if (!open || rect === undefined) return null

  const frameStyle: CSSProperties = {
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: collapsed ? FLOAT_TITLEBAR_HEIGHT : rect.height,
    // The editor theme reads this (see `vsc/editor-theme.ts`); only this frame
    // sets it, so any other editor mount keeps the default 13px. Docking always
    // renders at the default size (the variable is frame-scoped) — the zoom is
    // a property of the floating window.
    ['--rvs-editor-font-size' as never]: `${fontSize}px`,
  }

  return (
    <div
      className={`rvs-root rvs-float-window${dragging ? ' dragging' : ''}`}
      style={frameStyle}
      data-rvs-float={collapsed ? 'collapsed' : 'open'}
      data-rvs-float-maximized={maximized ? 'true' : undefined}
    >
      <div
        className="rvs-float-titlebar"
        onPointerDown={(event) => {
          if (rect === undefined || maximized) return
          if ((event.target as HTMLElement).closest('button') !== null) return
          beginDrag(event, { kind: 'move', pointerX: event.clientX, pointerY: event.clientY, rect })
        }}
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest('button') !== null) return
          toggleMaximize()
        }}
        title={t('float.dragHint')}
      >
        <span className="rvs-float-glyph" aria-hidden="true">▣</span>
        <span className="rvs-float-title">{t('float.title')}</span>
        {activeTab !== undefined && (
          <span className="rvs-float-file" title={activeTab.fullPath}>{activeTab.rel}</span>
        )}
        <span className="rvs-float-spacer" />
        <button
          type="button"
          className="rvs-float-btn"
          title={collapsed ? t('float.expand') : t('float.minimize')}
          aria-label={collapsed ? t('float.expand') : t('float.minimize')}
          onClick={toggleCollapse}
        >
          {collapsed ? '▣' : '—'}
        </button>
        <button
          type="button"
          className="rvs-float-btn"
          title={maximized ? t('float.restore') : t('float.maximize')}
          aria-label={maximized ? t('float.restore') : t('float.maximize')}
          onClick={toggleMaximize}
        >
          {maximized ? '❐' : '□'}
        </button>
        <button
          type="button"
          className="rvs-float-btn rvs-float-close"
          title={t('float.dock')}
          aria-label={t('float.dock')}
          onClick={() => { store.dockFloatingEditor() }}
        >
          <IconClose size={12} />
        </button>
      </div>
      {body}
      <DialogHost />
      {!collapsed && !maximized && RESIZE_HANDLES.map(handle => (
        <div
          key={handle}
          className={`rvs-float-resize rvs-float-resize-${handle}`}
          data-rvs-float-resize={handle}
          onPointerDown={(event) => {
            if (rect === undefined) return
            beginDrag(event, { kind: 'resize', handle, pointerX: event.clientX, pointerY: event.clientY, rect })
          }}
        />
      ))}
    </div>
  )
}
