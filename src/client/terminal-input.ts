/**
 * One registry for "type this into that terminal's command line".
 *
 * The snippet panel lives in the terminal's HEADER while the xterm instance is
 * owned by a child component, so the panel needs an imperative handle without
 * lifting xterm state into React (a re-render per keystroke would be absurd).
 * Each mounted `XTerm` registers a paste function under its tab id and removes
 * it on unmount; the panel asks for the ACTIVE tab.
 *
 * Deliberately NOT exported as a React hook: callers are event handlers inside
 * a portal, not render code.
 */

/** Registered terminals: tab id → "paste this text, do not press Enter". */
const pasters = new Map<string, (text: string) => void>()

/** Register one mounted terminal; returns the unregister. */
export function registerTerminalPaste(tabId: string, paste: (text: string) => void): () => void {
  pasters.set(tabId, paste)
  return () => {
    // Only remove OUR entry: a remount (reconnect) registers again under the
    // same id and its cleanup must not delete the newcomer.
    if (pasters.get(tabId) === paste) pasters.delete(tabId)
  }
}

/**
 * Insert one command into the given terminal without sending it.
 *
 * @returns false when that tab has no mounted terminal any more (a closed tab, a
 *   panel that is not rendered) — the caller says so instead of pretending.
 */
export function pasteIntoTerminal(tabId: string | undefined, text: string): boolean {
  if (tabId === undefined || text === '') return false
  const paste = pasters.get(tabId)
  if (paste === undefined) return false
  paste(text)
  return true
}

/** How many terminals are registered (diagnostics; also handy for the gate). */
export function registeredTerminalCount(): number {
  return pasters.size
}
