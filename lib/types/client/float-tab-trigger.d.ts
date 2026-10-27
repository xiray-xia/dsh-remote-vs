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
/**
 * Install the double-click trigger.
 *
 * @param label - the tab's visible label (the same localized string the view
 *   registered with); matched against the tab's trimmed text.
 * @param onTrigger - called once per recognised double-click.
 * @returns disposer removing the listener.
 */
export declare function installFloatTabTrigger(label: string, onTrigger: () => void): () => void;
