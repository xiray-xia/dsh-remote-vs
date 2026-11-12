/**
 * Terminal clipboard chords and the paste fallback, as testable logic.
 *
 * Why this module exists
 * ----------------------
 * The terminal's copy/paste handling used to be an inline `attachCustomKeyEventHandler`
 * with three problems the UI tests could not see:
 *
 * 1. **Double paste on Ctrl+Shift+V.** The handler pasted through
 *    `navigator.clipboard.readText()` and returned `false`, but returning false only
 *    stops xterm's own handling — the browser still performed its default paste
 *    (Chrome maps Ctrl+Shift+V to "paste as plain text"), so both paths inserted the
 *    text. Handled chords must call `preventDefault()` themselves.
 * 2. **Ctrl+V depended entirely on the browser's native paste.** When the host page
 *    or a wrapper swallows the paste event (desktop shells, non-standard clipboard
 *    permissions), the terminal silently received nothing. It now falls back to the
 *    Clipboard API only when no paste event arrived shortly after the key press.
 * 3. **Right-click copied/pasted immediately with no visible affordance.** It is now
 *    a small menu (copy / paste / select all) so the action is discoverable and the
 *    copy item can be disabled when nothing is selected.
 *
 * The chord table and the fallback watcher are pure so a gate can pin all of it.
 */

/** What one key press asks the terminal to do. */
export type TerminalClipboardChord =
  /** Copy the current selection, then clear it (menu action). */
  | 'copy'
  /** Paste immediately through the Clipboard API. */
  | 'paste'
  /** Let the browser's native paste run; fall back to the Clipboard API when no paste event arrives. */
  | 'paste-native'
  /** Plain Ctrl+C: copy when a selection exists, otherwise stay SIGINT. */
  | 'copy-interrupt'

/** The keyboard state the chord table reads. */
export interface TerminalChordInput {
  key: string
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
}

/** True when the key is the letter (layout-aware `code` is not required: xterm gives `key`). */
function isLetter(input: TerminalChordInput, letter: string): boolean {
  return input.key.toLowerCase() === letter
}

/**
 * Map one keydown to a clipboard chord.
 *
 * Conventions: Ctrl+Shift+C / Ctrl+Insert / Cmd+C copy, Ctrl+Shift+V / Cmd+V /
 * Shift+Insert paste. Plain Ctrl+V is left to the browser first (`paste-native`),
 * and plain Ctrl+C always stays SIGINT.
 */
export function clipboardChordFor(input: TerminalChordInput): TerminalClipboardChord | undefined {
  const ctrl = input.ctrl,
    shift = input.shift,
    meta = input.meta,
    alt = input.alt
  if (alt) return undefined
  if (!meta && ctrl && shift && isLetter(input, 'c')) return 'copy'
  if (!meta && ctrl && !shift && input.key === 'Insert') return 'copy'
  if (meta && !ctrl && !shift && isLetter(input, 'c')) return 'copy'
  if (!meta && ctrl && shift && isLetter(input, 'v')) return 'paste'
  if (!meta && !ctrl && shift && input.key === 'Insert') return 'paste'
  if (meta && !ctrl && !shift && isLetter(input, 'v')) return 'paste'
  if (!meta && ctrl && !shift && isLetter(input, 'v')) return 'paste-native'
  // Plain Ctrl+C only means COPY when there is a selection; without one it must
  // stay SIGINT. The chord therefore only says "look at the selection".
  if (!meta && ctrl && !shift && isLetter(input, 'c')) return 'copy-interrupt'
  return undefined
}

/** Copy and paste chords take the key over; the native-paste chord must not. */
export function chordTakesKey(chord: TerminalClipboardChord): boolean {
  return chord !== 'paste-native'
}

/** Dependencies of {@link createPasteFallback}. */
export interface PasteFallbackDeps {
  /** Clipboard read; `undefined` when the browser denies it. */
  read: () => Promise<string | undefined>
  /** Insert text into the terminal. */
  paste: (text: string) => void
  /** Report a denied clipboard read (shown in the terminal). */
  onDenied: () => void
  /** Timer injection (tests use a fake clock). */
  schedule?: (run: () => void, ms: number) => unknown
}

/** How long to wait for a native paste event before falling back to the API. */
export const PASTE_FALLBACK_MS = 180

/**
 * Watches one Ctrl+V press: the browser's native paste wins when its event arrives,
 * otherwise the Clipboard API inserts the text after {@link PASTE_FALLBACK_MS}.
 *
 * The watcher is a single slot: arming again (a held/repeated key) replaces the
 * pending window instead of stacking pastes.
 */
export function createPasteFallback(deps: PasteFallbackDeps): {
  arm: () => void
  /** The terminal saw a native paste for this window: cancel the fallback. */
  observed: () => void
} {
  const schedule = deps.schedule
    ?? ((run, ms) => {
      const timer = setTimeout(run, ms)
      // Never keep a Host-alike or a page alive for a clipboard probe.
      ;(timer as unknown as { unref?: () => void }).unref?.()
      return timer
    })
  let pending: { cancelled: boolean } | undefined
  return {
    arm: () => {
      if (pending !== undefined) pending.cancelled = true
      const token = { cancelled: false }
      pending = token
      schedule(() => {
        if (token.cancelled) return
        token.cancelled = true
        if (pending === token) pending = undefined
        void deps.read().then((text) => {
          if (text === undefined) {
            deps.onDenied()
            return
          }
          deps.paste(text)
        })
      }, PASTE_FALLBACK_MS)
    },
    observed: () => {
      if (pending !== undefined) pending.cancelled = true
      pending = undefined
    },
  }
}

/** Menu entry state for the right-click menu. */
export function terminalMenuState(input: { hasSelection: boolean }): {
  copyDisabled: boolean
} {
  return { copyDisabled: !input.hasSelection }
}

// ------------------------------------------------- bracketed-paste sanitising

/** Start/end markers a terminal wraps around a bracketed paste. */
const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'

/**
 * Remove ONE bracketed-paste wrapper from an input chunk.
 *
 * xterm wraps `Terminal.paste()`/native pastes while the remote application has
 * bracketed paste enabled. When that mode is stale (an app that enabled it was
 * killed, or the shell never enabled it) the wrapper is displayed literally as
 * `^[[200~...^[[201~` and the text is not executed — a field screenshot showed
 * exactly that. The host-side input path strips one wrapper before forwarding,
 * so the PTY only ever receives the user's text. Apps that expect the wrapper
 * still accept raw text, like a classic terminal.
 */
export function stripBracketedPasteMarkers(data: string): string {
  if (data.length < PASTE_START.length) return data
  if (!data.startsWith(PASTE_START)) return data
  if (!data.endsWith(PASTE_END)) return data
  return data.slice(PASTE_START.length, data.length - PASTE_END.length)
}
