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
 * Two things travel:
 *   - the buffer text (the store copies it onto the tab before the surface
 *     flips, so the replacement mounts with it as `initial`);
 *   - scroll + caret (kept here and read back by the replacement, which is how
 *     a tab switch already restored its position — same storage, now shared by
 *     every surface instead of one component's `useRef`).
 */
import type { CodeEditorHandle, CodeEditorViewState } from './CodeEditor.tsx'

/** What was handed over when the live editor was snapshotted. */
export interface LiveEditorSnapshot {
  tabId: string
  text: string
  viewState: CodeEditorViewState | undefined
}

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
 * Snapshot the live buffer (text + position) before its mount goes away.
 *
 * Called from the store BEFORE flipping the surface: at that moment the editor
 * is still mounted and its CodeMirror view still owns the edits.
 * @returns undefined when no file editor is live (a diff tab, or a view that
 *   was never the selected one) — there is nothing to carry over then.
 */
export function captureLiveEditor(): LiveEditorSnapshot | undefined {
  const entry = registration
  if (entry === undefined) return undefined
  const handle = entry.getHandle()
  if (handle === null) return undefined
  let text: string
  try {
    text = handle.getContent()
  } catch {
    // A destroyed view is one race away from throwing; the surface flip must
    // never be blocked by the handoff itself.
    return undefined
  }
  const viewState = handle.getViewState()
  if (viewState !== undefined) viewStates.set(entry.tabId, viewState)
  return { tabId: entry.tabId, text, viewState }
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
