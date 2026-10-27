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
  FLOAT_BALL_SIZE,
  FLOAT_FONT_DEFAULT,
  ballFromRect,
  clampBallPosition,
  clampFloatRect,
  defaultFloatRect,
  dragFloatRect,
  isBallClick,
  maximizeFloatRect,
  parseBallPosition,
  parseFloatFontSize,
  parseFloatRect,
  resizeFloatRect,
  serializeBallPosition,
  serializeFloatRect,
  stepFloatZoom,
  type FloatPoint,
  type FloatRect,
  type FloatResizeHandle,
} from './float-editor.ts'

/** Where the last window rect is remembered (per browser/profile). */
const RECT_KEY = 'dsh-remote-vs.float.rect'
/** Where the last editor font size is remembered. */
const FONT_KEY = 'dsh-remote-vs.float.font'
/** Where the minimized ball's spot is remembered. */
const BALL_KEY = 'dsh-remote-vs.float.ball'

/** The resize grips, in the order they are rendered. */
const RESIZE_HANDLES: readonly FloatResizeHandle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

type DragState =
  | { kind: 'move'; pointerX: number; pointerY: number; rect: FloatRect }
  | { kind: 'resize'; handle: FloatResizeHandle; pointerX: number; pointerY: number; rect: FloatRect }
  /** Dragging the minimized ball; `start` is its origin when the press began. */
  | { kind: 'ball'; pointerX: number; pointerY: number; start: FloatPoint }

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

/**
 * The ball's remembered spot, or undefined the first time.
 *
 * Read at open, not at minimize: the spot belongs to the feature (per browser
 * profile), and re-deriving it from the window corner on every minimize is what
 * made the "remembered" claim false. A stale spot from a bigger screen is
 * clamped by the parser, so it stays clickable.
 */
function readStoredBall(): FloatPoint | undefined {
  const viewport = readViewport()
  try {
    return parseBallPosition(localStorage.getItem(BALL_KEY), viewport)
  } catch {
    return undefined
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
  /** The minimized ball's origin; undefined until the first minimize. */
  const [ball, setBall] = useState<FloatPoint | undefined>(undefined)

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

  /** The geometry a drag/resize gesture points at right now (move AND finalize). */
  const resolveDrag = (drag: DragState, pointerX: number, pointerY: number): FloatRect | FloatPoint => {
    const dx = pointerX - drag.pointerX
    const dy = pointerY - drag.pointerY
    if (drag.kind === 'ball') return clampBallPosition({ x: drag.start.x + dx, y: drag.start.y + dy }, viewportRef.current)
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

  // First open: resolve the persisted frame, font size and ball spot.
  useEffect(() => {
    if (!open || rect !== undefined) return
    const next = readViewport()
    setViewport(next)
    setRect(readStoredRect())
    setFontSize(readStoredFontSize())
    setBall(readStoredBall())
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
  // is clamped back on screen (a rect from a larger monitor must stay reachable),
  // and a minimized ball is pulled back in so it can still be clicked.
  useEffect(() => {
    const onResize = (): void => {
      const next = readViewport()
      setViewport(next)
      setBall(prev => (prev === undefined ? prev : clampBallPosition(prev, next)))
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

  const persistBall = useCallback((next: FloatPoint): void => {
    try {
      localStorage.setItem(BALL_KEY, serializeBallPosition(next))
    } catch {
      // Private mode: the ball's spot simply is not remembered.
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
      const next = resolveDrag(drag, event.clientX, event.clientY)
      if (drag.kind === 'ball') setBall(next as FloatPoint)
      else setRect(next as FloatRect)
    }
    const onUp = (event: PointerEvent): void => {
      // The pointerup may arrive before React re-rendered the last move, so the
      // FINAL geometry is resolved from the event here instead of reading the
      // state (a persisted rect one move behind loses the last few pixels).
      const drag = dragRef.current
      dragRef.current = undefined
      setDragging(false)
      if (drag === undefined) return
      const final = resolveDrag(drag, event.clientX, event.clientY)
      if (drag.kind === 'ball') {
        // One small target, two actions: a press that never really moved
        // RESTORES the window, a real drag parks the ball where it was dropped.
        const dropped = final as FloatPoint
        setBall(dropped)
        persistBall(dropped)
        if (isBallClick(event.clientX - drag.pointerX, event.clientY - drag.pointerY)) {
          setCollapsed(false)
        }
        return
      }
      if (maximized) return
      const nextRect = final as FloatRect
      setRect(nextRect)
      persistRect(nextRect)
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
  }, [dragging, maximized, persistRect, persistBall])

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

  /**
   * Minimize to the floating ball.
   *
   * The ball appears at the window's own corner first (a minimize should not
   * teleport the affordance across the screen), and keeps wherever the user
   * drags it afterwards — persisted per browser profile.
   */
  const toggleCollapse = (): void => {
    if (!collapsed && rect !== undefined) {
      setBall(ball === undefined ? ballFromRect(rect, viewportRef.current) : clampBallPosition(ball, viewportRef.current))
    }
    setCollapsed(!collapsed)
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

  /**
   * A minimized window is a BALL, not a full-width bar: it keeps a title-bar
   * strip's worth of information (that the editor is out, which file, whether it
   * is dirty) in one small circle the user can park anywhere.
   */
  const ballPoint = clampBallPosition(ball ?? ballFromRect(rect, viewport), viewport)
  const frameStyle: CSSProperties = collapsed
    ? { left: ballPoint.x, top: ballPoint.y, width: FLOAT_BALL_SIZE, height: FLOAT_BALL_SIZE }
    : {
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        // The editor theme reads this (see `vsc/editor-theme.ts`); only this
        // frame sets it, so any other editor mount keeps the default 13px.
        // Docking always renders at the default size (the variable is
        // frame-scoped) — the zoom is a property of the floating window.
        ['--rvs-editor-font-size' as never]: `${fontSize}px`,
      }

  return (
    <div
      className={`rvs-root rvs-float-window${collapsed ? ' rvs-float-mini' : ''}${dragging ? ' dragging' : ''}`}
      style={frameStyle}
      data-rvs-float={collapsed ? 'collapsed' : 'open'}
      data-rvs-float-maximized={maximized ? 'true' : undefined}
      title={collapsed ? t('float.ballHint') : undefined}
      onPointerDown={collapsed
        ? (event) => {
            if (event.button !== 0) return
            // The whole ball is the drag handle; a press that does not move
            // restores the window on release (see the pointerup handler).
            beginDrag(event, { kind: 'ball', pointerX: event.clientX, pointerY: event.clientY, start: ballPoint })
          }
        : undefined}
    >
      {collapsed
        ? (
          <div
            className="rvs-float-ball"
            role="button"
            tabIndex={0}
            aria-label={t('float.ballHint')}
            title={t('float.ballHint')}
            // Keyboard access: the ball is the only affordance left, so it must
            // also restore without a pointer. Pointer clicks are decided in the
            // pointerup handler (click vs drag), never here — a drag that ends
            // on the ball must not also restore it.
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setCollapsed(false)
              }
            }}
          >
            <span className="rvs-float-ball-glyph" aria-hidden="true">▣</span>
            {activeTab !== undefined && activeTab.dirty && (
              <span className="rvs-float-ball-dot" title={t('editor.unsaved')} aria-hidden="true" />
            )}
          </div>
        )
        : (
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
              title={t('float.minimize')}
              aria-label={t('float.minimize')}
              onClick={toggleCollapse}
            >
              —
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
        )}
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
