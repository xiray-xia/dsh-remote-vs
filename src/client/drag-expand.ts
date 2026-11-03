/**
 * Spring-loaded directory expansion during a drag.
 *
 * A file manager opens a folder when a dragged item RESTS on it for a moment
 * ("spring-loaded folder", macOS Finder / VS Code behaviour): without it the
 * user has to remember the target path, drop, then find the file again inside
 * the freshly opened tree. The editor's drop path already lands a drop on the
 * row under the pointer (`RemoteExplorer` `dropDirFromEvent`), so opening the
 * row mid-drag is what makes the gesture a single movement instead of two.
 *
 * Why this is a module of its own with an INJECTED scheduler
 * ---------------------------------------------------------
 * The rule that matters is timing, and timing is exactly what a jsdom/node gate
 * cannot observe through `window.setTimeout` without waiting real seconds. The
 * scheduler seam lets `scripts/check-drag-expand.mjs` drive a fake clock and
 * pin every transition; the view passes `window`'s functions in. Nothing here
 * touches the DOM, React or a browser global.
 *
 * Why ONE candidate
 * -----------------
 * There is one pointer and one drag. Keeping a set would let two directories
 * open from a single path if `dragleave` were ever missed, and the second open
 * would move the row the user is aiming at.
 */

/**
 * How long the pointer must rest on a closed directory before it opens, in ms.
 *
 * Long enough that a drag ACROSS the tree does not flash every folder open on
 * the way; short enough that a deliberate pause feels like the folder was
 * waiting. 650 ms is a common file-manager value (Finder uses ~0.5 s) and sits
 * well above `PREFETCH_HOVER_MS` (150 ms), so the listing warm-up still starts
 * first and the expand usually paints from the warmed cache.
 */
export const DRAG_EXPAND_DELAY_MS = 650

/**
 * The timer functions the expander needs.
 *
 * Injected rather than imported so the gate can run on a fake clock; the view
 * passes `window.setTimeout` / `window.clearTimeout` (they return numbers in a
 * browser, which is why the handle is a number).
 */
export interface DragExpandScheduler {
  set(callback: () => void, ms: number): number
  clear(handle: number): void
}

/** The handle the view talks to (one per mounted tree). */
export interface DragExpander {
  /**
   * The pointer is resting on `dir`: open it after the delay.
   *
   * Idempotent for the same directory on purpose. `dragover` fires repeatedly
   * (every few hundred ms at least) while a drag stays still, and restarting
   * the countdown on every event would mean it never completes.
   */
  hover(dir: string): void
  /**
   * The pointer left `dir`.
   *
   * Cancels only when `dir` is the current candidate: React delivers a leave
   * for rows the pointer merely passed through, and one late leave from a row
   * the pointer already left must not cancel the timer armed on the row it now
   * rests on.
   */
  leave(dir: string): void
  /** Cancel any pending open (drop, dragend, binding change, unmount). */
  reset(): void
  /** The directory a countdown is running for, or undefined. Test seam. */
  pending(): string | undefined
}

/**
 * Build one expander.
 *
 * @param onExpand - called ONCE per rest, after the delay, with the directory
 *   that was still hovered when the timer fired.
 * @param scheduler - timer implementation (see {@link DragExpandScheduler}).
 * @param delayMs - rest time; defaults to {@link DRAG_EXPAND_DELAY_MS}.
 */
export function createDragExpander(
  onExpand: (dir: string) => void,
  scheduler: DragExpandScheduler,
  delayMs: number = DRAG_EXPAND_DELAY_MS,
): DragExpander {
  /** The directory a timer is running for; undefined = idle. */
  let candidate: string | undefined
  /** The pending timer handle, or undefined when idle. */
  let timer: number | undefined

  const clear = (): void => {
    if (timer !== undefined) {
      scheduler.clear(timer)
      timer = undefined
    }
  }

  return {
    hover(dir: string): void {
      // A second dragover for the row already counting down: keep the original
      // deadline (see the interface docstring).
      if (candidate === dir && timer !== undefined) return
      clear()
      candidate = dir
      timer = scheduler.set(() => {
        // A leave (or a different hover) may have replaced the candidate while
        // the callback sat in the queue; only the CURRENT one may open.
        if (candidate !== dir) return
        candidate = undefined
        timer = undefined
        onExpand(dir)
      }, delayMs)
    },
    leave(dir: string): void {
      if (candidate !== dir) return
      clear()
      candidate = undefined
    },
    reset(): void {
      clear()
      candidate = undefined
    },
    pending(): string | undefined {
      return candidate
    },
  }
}
