/**
 * Double-click on the shell's 「远程编辑器」 tab floats the editor.
 *
 * That tab belongs to the host's conversation-view header, not to us: the plugin
 * registers a VIEW into the shell's tab strip and never sees the tab row's DOM.
 * There is no public service for "the user double-clicked my tab" either, so the
 * only way to honour the gesture is a document-level `dblclick` listener that
 * recognises the tab the same way `reveal.ts` does for clicks — by its label,
 * skipping our own surfaces.
 *
 * Fail-safe by construction: a miss (another host build, a renamed tab, a
 * double-click somewhere else) simply does nothing. It never prevents the
 * default action, never throws, and does not steal double-clicks from the
 * plugin's own UI (`.rvs-root`) or from dialogs.
 */

/** Elements that behave like the shell's view tabs. */
const TAB_SELECTOR = 'button, [role="tab"], [role="button"]'

/**
 * Install the double-click trigger.
 *
 * @param label - the tab's visible label (the same localized string the view
 *   registered with); matched against the tab's trimmed text.
 * @param onTrigger - called once per recognised double-click.
 * @returns disposer removing the listener.
 */
export function installFloatTabTrigger(label: string, onTrigger: () => void): () => void {
  if (typeof document === 'undefined' || label === '') return () => {}
  const handler = (event: MouseEvent): void => {
    if (event.button !== 0) return
    const target = event.target
    if (!(target instanceof Element)) return
    // Our own surfaces (editor tabs, menus, the floating window) own their
    // double-clicks — the window's title bar uses one to maximize.
    if (target.closest('.rvs-root') !== null) return
    const tab = target.closest<HTMLElement>(TAB_SELECTOR)
    if (tab === null) return
    if ((tab.textContent ?? '').trim() !== label) return
    // A second click while the shell is mid-transition is harmless: the action
    // is idempotent (an already-floating editor is left alone).
    try {
      onTrigger()
    } catch {
      // Never let a listener break the shell's own double-click handling.
    }
  }
  // Capture phase: the shell's tab may stop propagation on its own handlers.
  document.addEventListener('dblclick', handler, true)
  return () => document.removeEventListener('dblclick', handler, true)
}
