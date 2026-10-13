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
 * Subscribe to color-scheme flips (the presenter toggles the body
 * attribute). The callback fires after the attribute changed; re-read the
 * scheme inside it.
 * @returns the disposer.
 */
export function subscribeColorScheme(callback: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  const observer = new MutationObserver(() => {
    callback()
  })
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
  return () => {
    observer.disconnect()
  }
}
