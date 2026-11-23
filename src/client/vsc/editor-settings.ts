/**
 * Editor view preferences (word wrap + font size), shared by every surface that
 * shows the editor (the sidebar pane, the conversation-view tab, the floating
 * window).
 *
 * Module-level, React/DOM-free on purpose: those three surfaces are three
 * different React trees, so React state cannot carry "I made the font bigger in
 * the floating window, dock it and the sidebar must show the same size" — which
 * is the whole point (it is ONE editor, only its mount changes).
 *
 * The pure parse/serialize half is exported because the self-check harness
 * imports this module in Node: it must not read localStorage at module load
 * (private mode throws on `getItem`).
 */

/** One shared view preference set. */
export interface EditorSettings {
  /** Soft wrap the long lines. */
  wrap: boolean
  /** Editor type size in px (0.5 px steps are legal). */
  fontSize: number
}

/** localStorage key: ONE JSON object, so the two fields cannot drift apart. */
export const EDITOR_SETTINGS_KEY = 'dsh-remote-vs.editor.settings'

/** Legal font-size range, shared with the floating window's Ctrl+wheel zoom. */
export const FONT_MIN = 9
export const FONT_MAX = 28
export const FONT_STEP = 1

/** Defaults used before anything was stored (matches the theme's 13px fallback). */
export const DEFAULT_EDITOR_SETTINGS: EditorSettings = { wrap: false, fontSize: 13 }

/** Clamp any input to a legal font size; non-numbers answer undefined. */
export function parseFontSize(value: unknown): number | undefined {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN
  if (!Number.isFinite(numeric)) return undefined
  // Half-pixel steps are legal (historically 12.5px); 13.3333 noise snaps to the grid.
  const snapped = Math.round(numeric * 2) / 2
  return Math.min(FONT_MAX, Math.max(FONT_MIN, snapped))
}

/** One zoom step (-1 = smaller, +1 = bigger), already clamped. */
export function stepFontSize(size: number, direction: -1 | 1): number {
  const current = parseFontSize(size) ?? DEFAULT_EDITOR_SETTINGS.fontSize
  return parseFontSize(current + direction * FONT_STEP) ?? current
}

/**
 * Parse the persisted JSON.
 *
 * Anything damaged (not JSON, not an object, wrong field types) falls back to
 * the defaults: this data only affects presentation, and a dirty localStorage
 * entry must never keep the page from starting.
 */
export function parseEditorSettings(raw: string | null | undefined): EditorSettings {
  if (typeof raw !== 'string' || raw === '') return DEFAULT_EDITOR_SETTINGS
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return DEFAULT_EDITOR_SETTINGS
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_EDITOR_SETTINGS
  const record = parsed as Record<string, unknown>
  const fontSize = parseFontSize(record.fontSize) ?? DEFAULT_EDITOR_SETTINGS.fontSize
  const wrap = typeof record.wrap === 'boolean' ? record.wrap : DEFAULT_EDITOR_SETTINGS.wrap
  return { wrap, fontSize }
}

/** Serialize only the known fields (never whatever else the caller passed). */
export function serializeEditorSettings(settings: EditorSettings): string {
  return JSON.stringify({ wrap: settings.wrap, fontSize: settings.fontSize })
}

// ------------------------------------------------------------------ store

const listeners = new Set<() => void>()
/** Lazy current value; undefined = localStorage not read yet. */
let current: EditorSettings | undefined

function readFromStorage(): EditorSettings {
  try {
    return parseEditorSettings(localStorage.getItem(EDITOR_SETTINGS_KEY))
  } catch {
    // Private mode / storage disabled: the defaults still work this session.
    return DEFAULT_EDITOR_SETTINGS
  }
}

function persist(settings: EditorSettings): void {
  try {
    localStorage.setItem(EDITOR_SETTINGS_KEY, serializeEditorSettings(settings))
  } catch {
    // Same as above: failing to persist does not affect this session.
  }
}

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // One broken surface must not starve the others.
    }
  }
}

/** Current snapshot (identity-stable while unchanged, safe for useSyncExternalStore). */
export function editorSettingsSnapshot(): EditorSettings {
  if (current === undefined) current = readFromStorage()
  return current
}

/** Subscribe to preference changes; returns the unsubscribe. */
export function subscribeEditorSettings(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Change one preference and persist it.
 *
 * Illegal values (out-of-range size) are clamped BEFORE the "did it change"
 * comparison: without that, every click on a "+" already at the cap would
 * re-render all three surfaces for nothing.
 */
export function updateEditorSettings(patch: Partial<EditorSettings>): void {
  const before = editorSettingsSnapshot()
  const fontSize = patch.fontSize === undefined
    ? before.fontSize
    : parseFontSize(patch.fontSize) ?? before.fontSize
  const wrap = patch.wrap === undefined ? before.wrap : patch.wrap
  if (fontSize === before.fontSize && wrap === before.wrap) return
  const next: EditorSettings = { wrap, fontSize }
  current = next
  persist(next)
  emit()
}
