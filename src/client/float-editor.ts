/**
 * Pure geometry and surface rules for the floating editor.
 *
 * Kept free of React and of the DOM on purpose: the drag / resize / zoom maths
 * is the part that is easy to get subtly wrong (negative sizes, a window that
 * escapes the viewport, a stale stored rect from a larger screen), and this
 * module is what `scripts/check-float-editor.mjs` drives directly. The window
 * component is then only wiring.
 *
 * The SURFACE rule lives here too: the plugin has exactly one live editor, and
 * which mount owns it is a three-way decision (centre conversation view,
 * sidebar fallback, floating window). Encoding it as a pure function keeps the
 * invariant testable and out of three separate `=== 'center'` comparisons.
 */

/** Where the editor pane is mounted right now. */
export type EditorSurface = 'center' | 'sidebar' | 'float'

/** The persisted layout of the floating window, in viewport pixels. */
export interface FloatRect {
  x: number
  y: number
  width: number
  height: number
}

/** Viewport size the geometry is clamped to. */
export interface FloatViewport {
  width: number
  height: number
}

/** A resize grip: the compass directions of the eight handles. */
export type FloatResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** Smallest window the editor can be squeezed into and stay usable. */
export const FLOAT_MIN_WIDTH = 360
export const FLOAT_MIN_HEIGHT = 220
/** Height of the title bar; a minimized window keeps exactly this much. */
export const FLOAT_TITLEBAR_HEIGHT = 34
/** Gap a maximized window keeps from the viewport edges. */
export const FLOAT_VIEWPORT_EDGE = 8

/** Editor font-size range for Ctrl+wheel zoom (px). */
export const FLOAT_FONT_MIN = 9
export const FLOAT_FONT_MAX = 28
export const FLOAT_FONT_DEFAULT = 13

/** Diameter of the minimized ball, in pixels. */
export const FLOAT_BALL_SIZE = 44
/**
 * How far a pointer may travel and still count as a CLICK: the minimized window
 * is a single 44px ball, so "click restores / drag moves" has to be decided
 * from one pointer gesture.
 */
export const FLOAT_BALL_CLICK_SLOP = 4

/** A point in viewport coordinates (the minimized ball's origin). */
export interface FloatPoint {
  x: number
  y: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** True when the stored value is a usable finite number (not NaN/Infinity). */
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** The effective editor surface: floating wins, otherwise the base mount. */
export function effectiveEditorSurface(base: 'center' | 'sidebar', floatOpen: boolean): EditorSurface {
  return floatOpen ? 'float' : base
}

/**
 * The rect a fresh floating window opens at: about two thirds of the frame,
 * centred, with a hard size cap so a 4K monitor does not produce a 2600px
 * editor for a 40-column file.
 */
export function defaultFloatRect(viewport: FloatViewport): FloatRect {
  const maxWidth = Math.max(FLOAT_MIN_WIDTH, viewport.width - FLOAT_VIEWPORT_EDGE * 2)
  const maxHeight = Math.max(FLOAT_MIN_HEIGHT, viewport.height - FLOAT_VIEWPORT_EDGE * 2)
  const width = Math.min(maxWidth, Math.max(FLOAT_MIN_WIDTH, Math.round(viewport.width * 0.62)), 1180)
  const height = Math.min(maxHeight, Math.max(FLOAT_MIN_HEIGHT, Math.round(viewport.height * 0.7)), 860)
  const x = Math.round((viewport.width - width) / 2)
  const y = Math.round((viewport.height - height) / 2) - 12
  return clampFloatRect({ x, y, width, height }, viewport)
}

/**
 * Bring a rect back inside the viewport and to a legal size.
 *
 * Used on every drag step, on restore, and whenever the browser window is
 * resized: a rect persisted on a 2560px screen must not open a window whose
 * title bar is off-screen on a 1366px laptop.
 */
export function clampFloatRect(rect: FloatRect, viewport: FloatViewport): FloatRect {
  const width = clamp(rect.width, FLOAT_MIN_WIDTH, Math.max(FLOAT_MIN_WIDTH, viewport.width))
  const height = clamp(rect.height, FLOAT_MIN_HEIGHT, Math.max(FLOAT_MIN_HEIGHT, viewport.height))
  const x = clamp(rect.x, 0, Math.max(0, viewport.width - width))
  const y = clamp(rect.y, 0, Math.max(0, viewport.height - height))
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}

/** Move the window by a pointer delta, staying inside the viewport. */
export function dragFloatRect(start: FloatRect, dx: number, dy: number, viewport: FloatViewport): FloatRect {
  return clampFloatRect({ ...start, x: start.x + dx, y: start.y + dy }, viewport)
}

/**
 * Resize from one grip.
 *
 * Each axis is adjusted from the edge that MOVED (west/north resize changes the
 * origin too), then clamped: the minimum size is anchored at the opposite edge
 * (so dragging the north grip past the bottom stops instead of flipping the
 * rect) and no edge may leave the viewport.
 */
export function resizeFloatRect(
  start: FloatRect,
  handle: FloatResizeHandle,
  dx: number,
  dy: number,
  viewport: FloatViewport,
): FloatRect {
  let left = start.x
  let top = start.y
  let right = start.x + start.width
  let bottom = start.y + start.height
  if (handle.includes('e')) right += dx
  if (handle.includes('w')) left += dx
  if (handle.includes('s')) bottom += dy
  if (handle.includes('n')) top += dy

  // Minimum size, anchored at the edge that did NOT move.
  if (right - left < FLOAT_MIN_WIDTH) {
    if (handle.includes('w')) left = right - FLOAT_MIN_WIDTH
    else right = left + FLOAT_MIN_WIDTH
  }
  if (bottom - top < FLOAT_MIN_HEIGHT) {
    if (handle.includes('n')) top = bottom - FLOAT_MIN_HEIGHT
    else bottom = top + FLOAT_MIN_HEIGHT
  }

  // Viewport clamp: keep the rect (and every edge) on screen.
  left = clamp(left, 0, Math.max(0, viewport.width - FLOAT_MIN_WIDTH))
  top = clamp(top, 0, Math.max(0, viewport.height - FLOAT_MIN_HEIGHT))
  right = clamp(right, left + FLOAT_MIN_WIDTH, viewport.width)
  bottom = clamp(bottom, top + FLOAT_MIN_HEIGHT, viewport.height)
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
  }
}

/** The rect a maximized window occupies: the frame minus a small margin. */
export function maximizeFloatRect(viewport: FloatViewport): FloatRect {
  const edge = FLOAT_VIEWPORT_EDGE
  return {
    x: edge,
    y: edge,
    width: Math.max(FLOAT_MIN_WIDTH, viewport.width - edge * 2),
    height: Math.max(FLOAT_MIN_HEIGHT, viewport.height - edge * 2),
  }
}

/**
 * Parse a persisted rect.
 *
 * Anything malformed is discarded rather than repaired into a guess: the
 * caller then opens the default rect. Values that are merely STALE (a rect from
 * another screen) are legal input and get clamped.
 */
export function parseFloatRect(raw: string | null | undefined, viewport: FloatViewport): FloatRect | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const candidate = parsed as Record<string, unknown>
  if (!finite(candidate.x) || !finite(candidate.y) || !finite(candidate.width) || !finite(candidate.height)) {
    return undefined
  }
  return clampFloatRect(
    { x: candidate.x, y: candidate.y, width: candidate.width, height: candidate.height },
    viewport,
  )
}

/** Serialize a rect for localStorage. */
export function serializeFloatRect(rect: FloatRect): string {
  return JSON.stringify({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
}

/**
 * One Ctrl+wheel step: up (negative deltaY) grows the text, down shrinks it.
 * Values are whole pixels so the stored size stays stable across sessions.
 */
export function stepFloatZoom(current: number, deltaY: number): number {
  if (!finite(current)) return FLOAT_FONT_DEFAULT
  if (deltaY === 0) return clamp(Math.round(current), FLOAT_FONT_MIN, FLOAT_FONT_MAX)
  const direction = deltaY < 0 ? 1 : -1
  return clamp(Math.round(current) + direction, FLOAT_FONT_MIN, FLOAT_FONT_MAX)
}

/** Parse the persisted editor font size (fallback = the default 13px). */
export function parseFloatFontSize(raw: string | null | undefined): number {
  if (typeof raw !== 'string') return FLOAT_FONT_DEFAULT
  const value = Number(raw)
  if (!finite(value)) return FLOAT_FONT_DEFAULT
  return clamp(Math.round(value), FLOAT_FONT_MIN, FLOAT_FONT_MAX)
}

/**
 * Where the minimized ball may sit: fully on screen, whatever position was
 * asked for (a ball restored on a smaller monitor must stay clickable).
 */
export function clampBallPosition(pos: FloatPoint, viewport: FloatViewport): FloatPoint {
  const maxX = Math.max(0, viewport.width - FLOAT_BALL_SIZE)
  const maxY = Math.max(0, viewport.height - FLOAT_BALL_SIZE)
  const x = finite(pos.x) ? pos.x : 0
  const y = finite(pos.y) ? pos.y : 0
  return { x: Math.round(clamp(x, 0, maxX)), y: Math.round(clamp(y, 0, maxY)) }
}

/**
 * The ball's default spot when a window is minimized: its own top-left corner,
 * so the ball appears where the window was instead of jumping to a corner.
 */
export function ballFromRect(rect: FloatRect, viewport: FloatViewport): FloatPoint {
  return clampBallPosition({ x: rect.x, y: rect.y }, viewport)
}

/**
 * Whether a finished gesture was a CLICK rather than a drag.
 *
 * The minimized window is one small target with two actions on the same
 * pointer: a press that never really moved restores the window, a real drag
 * moves the ball. Without this distinction every move-by-3px would also
 * restore, and every click would be a zero-distance drag.
 */
export function isBallClick(dx: number, dy: number): boolean {
  return Math.abs(dx) <= FLOAT_BALL_CLICK_SLOP && Math.abs(dy) <= FLOAT_BALL_CLICK_SLOP
}

/** Parse a persisted ball position (stale geometry is clamped, garbage dropped). */
export function parseBallPosition(raw: string | null | undefined, viewport: FloatViewport): FloatPoint | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const candidate = parsed as Record<string, unknown>
  if (!finite(candidate.x) || !finite(candidate.y)) return undefined
  return clampBallPosition({ x: candidate.x, y: candidate.y }, viewport)
}

/** Serialize a ball position for localStorage. */
export function serializeBallPosition(pos: FloatPoint): string {
  return JSON.stringify({ x: pos.x, y: pos.y })
}
