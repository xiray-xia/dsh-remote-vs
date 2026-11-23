/**
 * Handoff for the ONE live editor buffer when its mount is replaced.
 *
 * The plugin mounts exactly one `EditorPane` at a time (centre conversation
 * view, sidebar fallback, or the floating window), and `CodeEditor` reads its
 * `initial` text once on mount. So moving the editor between surfaces is
 * effectively a remount: without a handoff the buffer typed since the last
 * load is gone and the tab's stored text is the pre-edit one.
 *
 * This module is the handoff, and it is module-level for the same reason the
 * store is: `EditorPane` is unmounted before the replacement mounts, so no
 * React state survives the swap.
 *
 * Two things travel, and they are captured SEPARATELY because their costs
 * differ by orders of magnitude:
 *   - the buffer text (the store copies it onto the tab before the surface
 *     flips, so the replacement mounts with it as `initial`) — materializes the
 *     whole document, so it is taken only when the tab may differ from disk;
 *   - scroll + caret (kept here and read back by the replacement, which is how
 *     a tab switch already restored its position — same storage, now shared by
 *     every surface instead of one component's `useRef`) — cheap, taken on
 *     every switch.
 */
import type { CodeEditorHandle, CodeEditorViewState } from './CodeEditor.tsx'

interface LiveEditorRegistration {
  tabId: string
  getHandle: () => CodeEditorHandle | null
}

let registration: LiveEditorRegistration | undefined

/** Scroll + caret per tab id, surviving an unmount (see the header). */
const viewStates = new Map<string, CodeEditorViewState>()

/**
 * Register the editor that is on screen right now.
 *
 * The caller passes a getter, not a handle: `editorRef.current` is `null`
 * during the first render and is cleared before the parent's cleanup runs, so
 * a snapshot taken later must read through the getter.
 * @returns disposer; only the registration that is still current is cleared.
 */
export function registerLiveEditor(
  tabId: string,
  getHandle: () => CodeEditorHandle | null,
): () => void {
  const entry: LiveEditorRegistration = { tabId, getHandle }
  registration = entry
  return () => {
    if (registration === entry) registration = undefined
  }
}

/**
 * Snapshot the live position (scroll + caret) without touching the document.
 *
 * Cheap, so the store can call it on EVERY switch: a surface flip remounts the
 * very same tab, and the replacement's render happens before the old view's
 * unmount report — the position has to be in the map before that render.
 */
export function captureLiveEditorPosition(): void {
  const entry = registration
  if (entry === undefined) return
  const handle = entry.getHandle()
  if (handle === null) return
  const viewState = handle.getViewState()
  if (viewState !== undefined) viewStates.set(entry.tabId, viewState)
}

/**
 * Whether the live buffer differs from its disk baseline.
 *
 * The store uses this to skip the O(document) text copy on clean tabs (see
 * `captureLiveBuffer`): the boolean is cheap, `getContent()` materializes the
 * whole file as a string.
 */
export function isLiveEditorDirty(): boolean {
  return registration?.getHandle()?.isDirty() === true
}

/**
 * Copy the live buffer's text, for a switch that would otherwise lose it.
 *
 * Called from the store BEFORE the tab switch / surface flip: at that moment
 * the editor is still mounted and its CodeMirror view still owns the edits.
 * @returns undefined when no file editor is live (a diff tab, or a view that
 *   was never the selected one) — there is nothing to carry over then.
 */
export function captureLiveEditorText(): { tabId: string; text: string } | undefined {
  const entry = registration
  if (entry === undefined) return undefined
  const handle = entry.getHandle()
  if (handle === null) return undefined
  try {
    return { tabId: entry.tabId, text: handle.getContent() }
  } catch {
    // A destroyed view is one race away from throwing; the switch must never
    // be blocked by the handoff itself.
    return undefined
  }
}

/**
 * Whether one tab's file editor is the one registered right now.
 *
 * The save path asks this before it clears a tab's dirty flag: if an editor IS
 * mounted for that tab, the flag belongs to the live buffer and only the
 * editor may clear it (see `markLiveEditorSaved`).
 */
export function isLiveEditorFor(tabId: string): boolean {
  return registration?.tabId === tabId
}

/**
 * Advance the registered editor's dirty baseline to the bytes a save wrote.
 *
 * Routed through the MODULE-LEVEL registration rather than a React ref on
 * purpose: the pane can be remounted while the remote write is in flight (a
 * surface flip, a dock, a tab switch), and the ref the save started with is
 * then detached — that is exactly how a tab ended up reported clean while its
 * live buffer was newer than the file. The registration always names the editor
 * mounted NOW, so the correction lands on whichever instance is on screen, and
 * it is skipped (never misapplied) when that editor shows another tab: that tab
 * heals on its next mount from `savedText` (see `CodeEditor`).
 * @returns true when an editor for this tab took the new baseline.
 */
export function markLiveEditorSaved(tabId: string, savedText: string): boolean {
  const entry = registration
  if (entry === undefined || entry.tabId !== tabId) return false
  entry.getHandle()?.markSaved(savedText, tabId)
  return true
}

/** Remember one tab's scroll + caret (reported by the editor, see EditorPane). */
export function rememberEditorViewState(tabId: string, state: CodeEditorViewState): void {
  viewStates.set(tabId, state)
}

/** The stored position for one tab, or undefined when it was never seen. */
export function editorViewStateOf(tabId: string): CodeEditorViewState | undefined {
  return viewStates.get(tabId)
}

/**
 * Drop positions of tabs that no longer exist.
 *
 * The map used to live in a component with the same cleanup: without it a
 * long session accumulated one state object per file ever opened.
 */
export function pruneEditorViewStates(liveIds: ReadonlySet<string>): void {
  for (const id of [...viewStates.keys()]) {
    if (!liveIds.has(id)) viewStates.delete(id)
  }
}
