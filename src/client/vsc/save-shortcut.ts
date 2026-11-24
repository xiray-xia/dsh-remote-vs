/**
 * The window-level Ctrl/Cmd+S shortcut.
 *
 * `CodeEditor` owns that keystroke only while its CodeMirror view has focus (the
 * editor's keymap), so after clicking the tab strip, the info row, the find box
 * or any sidebar panel the very same keystroke did nothing at all — silently,
 * while the UI advertises Ctrl+S as the save key (the save button's title and
 * the empty-pane hint). A missed save is invisible until the tab is closed.
 *
 * Two rules make a global listener safe here:
 *
 *  - BUBBLE phase plus `defaultPrevented`: CodeMirror handles its own keydown
 *    first and calls `preventDefault()` when a keymap binding matches (its event
 *    dispatch does exactly that), so this listener must step aside then — one
 *    press may never save twice.
 *  - the CALLER decides what "save" means: `resolve()` returns undefined when the
 *    surface on screen has nothing of ours to save (a diff tab is `DiffView`'s own
 *    contract, a themed dialog owns its input, a terminal owns its keys).
 *
 * Dependency-free on purpose (no React, no CodeMirror): the gate drives it with
 * real `KeyboardEvent`s in jsdom, so the rule is testable without mounting the
 * whole editor.
 */

/** The fields `isSaveShortcut` reads — a structural type keeps it testable. */
export interface SaveShortcutEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean | undefined
  defaultPrevented: boolean
  target: EventTarget | null
}

/**
 * Areas where Ctrl+S belongs to somebody else.
 *
 * A terminal (xterm) forwards keys to the remote shell and a themed dialog's
 * input is mid-edit; hijacking the key there would be a surprise, and for the
 * shell it would also steal a control character (`^S`).
 *
 * Exported so the plugin's OTHER window-level shortcut (Ctrl+P in `RemoteRoot`)
 * draws the same line instead of re-inventing a narrower one — it used to
 * exclude only `.xterm` and hijacked the host's chat composer.
 */
export const FOREIGN_TARGET = '.xterm, textarea, input, [contenteditable="true"]'

/**
 * Is this the save shortcut this module should act on?
 *
 * Pure: the caller passes the event's fields, so the gate can pin every rule
 * without a DOM.
 */
export function isSaveShortcut(event: SaveShortcutEvent): boolean {
  // Already handled by CodeMirror (or anything else): never save a second time.
  if (event.defaultPrevented) return false
  // An IME composition is typing, not a command; Alt-combinations are characters
  // on some platforms and are never our shortcut.
  if (event.isComposing === true || event.altKey) return false
  // Ctrl+Shift+S belongs to "Save As", which this plugin does not have yet:
  // claiming it would be a surprise the day it is added.
  if (event.shiftKey) return false
  if (!(event.ctrlKey || event.metaKey)) return false
  if (event.key.toLowerCase() !== 's') return false
  const target = typeof Element !== 'undefined' && event.target instanceof Element ? event.target : null
  if (target !== null && target.closest(FOREIGN_TARGET) !== null) return false
  return true
}

/** A registered save target: `undefined` = this surface has nothing to save. */
export type SaveShortcutResolver = () => (() => void) | undefined

/**
 * The registered surfaces, MOST RECENT LAST.
 *
 * One press must save ONCE. Several `EditorPane` instances can be mounted at the
 * same time (every native session tab keeps its `RemoteRoot` mounted; the
 * sidebar/centre/floating surfaces overlap briefly during a swap), and each used
 * to add its own window listener — one Ctrl+S then ran two `saveActive`s, which
 * the per-tab save queue (P2-D4) folded into two writes of the same content, two
 * toasts and two git refreshes. Dispatch walks this set newest-first and stops at
 * the first surface that can save, so the count is one no matter how many panes
 * are alive. `EditorPane` additionally only registers while it is VISIBLE, so the
 * surface that answers is the one on screen.
 */
const resolvers = new Set<SaveShortcutResolver>()

/** True while the single window listener is installed. */
let listening = false

/**
 * The layers that own the keyboard while they are open.
 *
 * Mirrors the modal selector the host's own shortcut dispatcher trims commands
 * with (`[role="dialog"][aria-modal="true"], [role="menu"]` in
 * `@deepseek-ai/dsh-client-shortcuts`). These window listeners register nothing
 * with `ctx.shortcuts`, so no host mechanism keeps them from firing THROUGH a
 * dialog. Blanket on purpose: our own `.rvs-modal-mask`, QuickOpen and the
 * context menus are modal too, and a global shortcut must not pierce those
 * either. A caller that owns a layer and wants a toggle inside it (Ctrl+P
 * closes QuickOpen) skips this check while its own layer is up.
 *
 * `role="menu"` is the one exception to the blanket: it is what the host's
 * dispatcher treats as modal, but a NON-modal picker floats over the editor
 * while the editor is still the surface in use, so swallowing Ctrl+S there was
 * a real regression (audit NIT-5). Such a menu opts out with
 * `[data-rvs-nonmodal]` — the breadcrumb dropdown (`vsc/breadcrumb.tsx`) carries
 * it now, so no class-name bridge is needed.
 * RESIDUAL, deliberately conservative: any future non-modal menu that carries
 * neither marker still swallows Ctrl+S, and a modal layer that lacks
 * `aria-modal="true"` is not caught by the dialog branch. Failing safe matters
 * more here than a missed save: the alternative is writing a remote file
 * underneath a layer the user is answering.
 */
const MODAL_LAYER = '[role="dialog"][aria-modal="true"], '
  + '[role="menu"]:not([data-rvs-nonmodal])'

/**
 * Is a modal layer (host approval / settings, our own dialog, an open menu) on
 * screen right now?
 *
 * Called from the DOM listener entry points only: `isSaveShortcut` stays a pure
 * predicate on the event. Without it Ctrl+S silently saved the remote file
 * underneath a pending host approval dialog — a write the user never confirmed.
 */
export function isModalLayerOpen(): boolean {
  if (typeof document === 'undefined') return false
  return document.querySelector(MODAL_LAYER) !== null
}

function onKeyDown(event: KeyboardEvent): void {
  if (!isSaveShortcut(event)) return
  // A dialog or menu on screen owns the keyboard (see `isModalLayerOpen`).
  if (isModalLayerOpen()) return
  for (const resolve of [...resolvers].reverse()) {
    const save = resolve()
    if (save === undefined) continue
    // Claim the keystroke only when a surface actually acts on it: otherwise the
    // browser default ("save page") stays available exactly as before.
    event.preventDefault()
    save()
    return
  }
}

/**
 * Install the window-level save shortcut for one surface.
 *
 * Re-entrant by design: the FIRST call installs the one window listener, later
 * calls only register their resolver (no second listener), and the last disposer
 * removes it.
 *
 * @param resolve - What to save RIGHT NOW; return the save action, or undefined
 *   when this surface is not ours to save. Called once per candidate keypress, so
 *   it always sees the current state.
 * @returns the disposer (unregisters this resolver; removes the listener when the
 *   last surface is gone).
 */
export function installSaveShortcut(resolve: SaveShortcutResolver): () => void {
  if (typeof window === 'undefined') return () => {}
  resolvers.add(resolve)
  if (!listening) {
    listening = true
    // Bubble phase on purpose: CodeMirror runs first, and its `preventDefault()`
    // is what tells this listener to keep its hands off (see the header).
    window.addEventListener('keydown', onKeyDown)
  }
  return () => {
    resolvers.delete(resolve)
    if (resolvers.size === 0 && listening) {
      listening = false
      window.removeEventListener('keydown', onKeyDown)
    }
  }
}
