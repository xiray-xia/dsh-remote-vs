/**
 * Live DSH theme access (adapted from dsh-better-sidebar's theme.ts): the
 * app shell projects the resolved scheme onto body[data-ds-dark-theme] and
 * html { color-scheme }. Read the resolved scheme — never the OS media
 * query alone (the user may run a light OS with a dark DSH theme).
 */

/** Whether the app shell resolved to the dark scheme. */
export function isDarkScheme(): boolean {
  if (typeof document === 'undefined') return true
  const decided = document.documentElement.style.colorScheme !== ''
  if (decided) return document.body.hasAttribute('data-ds-dark-theme')
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
}

/**
 * The subscribers of the ONE scheme observer, plus that observer.
 *
 * It used to be created per subscription, and both consumers subscribe per
 * INSTANCE: every terminal tab (`XTerm`) and every code editor
 * (`editor-theme.ts`) added its own MutationObserver on the same body element.
 * A flip therefore ran N callbacks against N observers — and each xterm callback
 * repaints the whole terminal. Subscribing is now set membership.
 */
const schemeCallbacks = new Set<() => void>()
let schemeObserver: MutationObserver | undefined

/**
 * Subscribe to color-scheme flips (the presenter toggles the body
 * attribute). The callback fires after the attribute changed; re-read the
 * scheme inside it.
 * @returns the disposer.
 */
export function subscribeColorScheme(callback: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  if (schemeObserver === undefined) {
    schemeObserver = new MutationObserver(() => {
      // Iterate a copy: a callback may unsubscribe (or a sibling may subscribe)
      // while this runs, and mutating a Set mid-iteration is easy to get wrong.
      for (const listener of [...schemeCallbacks]) listener()
    })
    schemeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
  }
  schemeCallbacks.add(callback)
  return () => {
    schemeCallbacks.delete(callback)
    // Last one out takes the observer off `document.body`, so a plugin whose
    // panes are all gone leaves nothing behind.
    if (schemeCallbacks.size === 0 && schemeObserver !== undefined) {
      schemeObserver.disconnect()
      schemeObserver = undefined
    }
  }
}
