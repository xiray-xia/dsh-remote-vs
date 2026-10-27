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
export type EditorSurface = 'center' | 'sidebar' | 'float';
/** The persisted layout of the floating window, in viewport pixels. */
export interface FloatRect {
    x: number;
    y: number;
    width: number;
    height: number;
}
/** Viewport size the geometry is clamped to. */
export interface FloatViewport {
    width: number;
    height: number;
}
/** A resize grip: the compass directions of the eight handles. */
export type FloatResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
/** Smallest window the editor can be squeezed into and stay usable. */
export declare const FLOAT_MIN_WIDTH = 360;
export declare const FLOAT_MIN_HEIGHT = 220;
/** Height of the title bar; a minimized window keeps exactly this much. */
export declare const FLOAT_TITLEBAR_HEIGHT = 34;
/** Gap a maximized window keeps from the viewport edges. */
export declare const FLOAT_VIEWPORT_EDGE = 8;
/** Editor font-size range for Ctrl+wheel zoom (px). */
export declare const FLOAT_FONT_MIN = 9;
export declare const FLOAT_FONT_MAX = 28;
export declare const FLOAT_FONT_DEFAULT = 13;
/** Diameter of the minimized ball, in pixels. */
export declare const FLOAT_BALL_SIZE = 44;
/**
 * How far a pointer may travel and still count as a CLICK: the minimized window
 * is a single 44px ball, so "click restores / drag moves" has to be decided
 * from one pointer gesture.
 */
export declare const FLOAT_BALL_CLICK_SLOP = 4;
/** A point in viewport coordinates (the minimized ball's origin). */
export interface FloatPoint {
    x: number;
    y: number;
}
/** The effective editor surface: floating wins, otherwise the base mount. */
export declare function effectiveEditorSurface(base: 'center' | 'sidebar', floatOpen: boolean): EditorSurface;
/**
 * The rect a fresh floating window opens at: about two thirds of the frame,
 * centred, with a hard size cap so a 4K monitor does not produce a 2600px
 * editor for a 40-column file.
 */
export declare function defaultFloatRect(viewport: FloatViewport): FloatRect;
/**
 * Bring a rect back inside the viewport and to a legal size.
 *
 * Used on every drag step, on restore, and whenever the browser window is
 * resized: a rect persisted on a 2560px screen must not open a window whose
 * title bar is off-screen on a 1366px laptop.
 */
export declare function clampFloatRect(rect: FloatRect, viewport: FloatViewport): FloatRect;
/** Move the window by a pointer delta, staying inside the viewport. */
export declare function dragFloatRect(start: FloatRect, dx: number, dy: number, viewport: FloatViewport): FloatRect;
/**
 * Resize from one grip.
 *
 * Each axis is adjusted from the edge that MOVED (west/north resize changes the
 * origin too), then clamped: the minimum size is anchored at the opposite edge
 * (so dragging the north grip past the bottom stops instead of flipping the
 * rect) and no edge may leave the viewport.
 */
export declare function resizeFloatRect(start: FloatRect, handle: FloatResizeHandle, dx: number, dy: number, viewport: FloatViewport): FloatRect;
/** The rect a maximized window occupies: the frame minus a small margin. */
export declare function maximizeFloatRect(viewport: FloatViewport): FloatRect;
/**
 * Parse a persisted rect.
 *
 * Anything malformed is discarded rather than repaired into a guess: the
 * caller then opens the default rect. Values that are merely STALE (a rect from
 * another screen) are legal input and get clamped.
 */
export declare function parseFloatRect(raw: string | null | undefined, viewport: FloatViewport): FloatRect | undefined;
/** Serialize a rect for localStorage. */
export declare function serializeFloatRect(rect: FloatRect): string;
/**
 * One Ctrl+wheel step: up (negative deltaY) grows the text, down shrinks it.
 * Values are whole pixels so the stored size stays stable across sessions.
 */
export declare function stepFloatZoom(current: number, deltaY: number): number;
/** Parse the persisted editor font size (fallback = the default 13px). */
export declare function parseFloatFontSize(raw: string | null | undefined): number;
/**
 * Where the minimized ball may sit: fully on screen, whatever position was
 * asked for (a ball restored on a smaller monitor must stay clickable).
 */
export declare function clampBallPosition(pos: FloatPoint, viewport: FloatViewport): FloatPoint;
/**
 * The ball's default spot when a window is minimized: its own top-left corner,
 * so the ball appears where the window was instead of jumping to a corner.
 */
export declare function ballFromRect(rect: FloatRect, viewport: FloatViewport): FloatPoint;
/**
 * Whether a finished gesture was a CLICK rather than a drag.
 *
 * The minimized window is one small target with two actions on the same
 * pointer: a press that never really moved restores the window, a real drag
 * moves the ball. Without this distinction every move-by-3px would also
 * restore, and every click would be a zero-distance drag.
 */
export declare function isBallClick(dx: number, dy: number): boolean;
/** Parse a persisted ball position (stale geometry is clamped, garbage dropped). */
export declare function parseBallPosition(raw: string | null | undefined, viewport: FloatViewport): FloatPoint | undefined;
/** Serialize a ball position for localStorage. */
export declare function serializeBallPosition(pos: FloatPoint): string;
