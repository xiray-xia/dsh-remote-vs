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
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
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
  /** True once the frame has a resolved rect (body/zoom effects depend on it). */
  const rectReady = rect !== undefined

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
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
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
      setFontSize((previous) => {
        const next = stepFloatZoom(previous, event.deltaY)
        if (next === previous) return previous
        try {
          localStorage.setItem(FONT_KEY, String(next))
        } catch {
          // Private mode: zoom still works for this session.
        }
        window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
        return next
      })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [open, collapsed, rectReady])

  const beginDrag = (event: ReactPointerEvent, drag: DragState): void => {
    if (event.button !== 0) return
    event.preventDefault()
    dragRef.current = drag
    setDragging(true)
  }

  const toggleMaximize = (): void => {
    if (rect === undefined) return
    const next = readViewport()
    setViewport(next)
    if (maximized) {
      setMaximized(false)
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

  if (!open || rect === undefined) return null

  const frameStyle: CSSProperties = {
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: collapsed ? FLOAT_TITLEBAR_HEIGHT : rect.height,
    // The editor theme reads this (see `vsc/editor-theme.ts`); only this frame
    // sets it, so the main editor keeps its 13px unless the user docks a zoomed
    // window — which is the expected behaviour of a per-window zoom.
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
      {/*
        Hidden, not unmounted, while minimized: `EditorPane` owns the live
        CodeMirror buffer, and unmounting it would drop every unsaved edit
        (the tab's stored text is only the last load). Same rule the preview
        toggle follows.
      */}
      <div className="rvs-float-body" ref={bodyRef} style={{ display: collapsed ? 'none' : 'flex' }}>
        <EditorPane visible={!collapsed} />
      </div>
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
