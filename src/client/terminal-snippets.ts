/**
 * Common-command snippets: the little "常用指令" library above the terminal.
 *
 * A snippet is a NAME plus the COMMAND it stands for. Clicking one in the panel
 * pastes the command into the active terminal's command line WITHOUT pressing
 * Enter — the user reviews and runs it themselves, so a misclick cannot execute
 * `rm -rf`.
 *
 * Storage is per browser (localStorage), like the port-forward rules and the
 * editor preferences: this is a personal convenience list, not workspace state,
 * and the host is told nothing about it. The pure half is exported so the gate
 * can drive parsing / CRUD / ordering without a DOM, and the module-level store
 * (snapshot + subscribe) is what makes the popover and the Ctrl+B shortcut share
 * one list.
 */

/** One saved command. */
export interface TerminalSnippet {
  /** Stable identity (never reused, so drag/reorder cannot swap rows). */
  id: string
  /** Short label shown in the list. */
  name: string
  /** The command text pasted into the terminal (not executed). */
  command: string
}

/** localStorage key (one JSON array, so the list cannot half-update). */
export const SNIPPETS_KEY = 'dsh-remote-vs.term.snippets'

/** Hard caps: a snippet list is a convenience, not a dataset. */
export const SNIPPETS_MAX = 200
export const SNIPPET_NAME_MAX = 80
export const SNIPPET_COMMAND_MAX = 4000

/** A fresh identity for one snippet. */
export function createSnippetId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Normalize one user-entered snippet; `undefined` when it is unusable.
 *
 * Both fields are required (an unnamed command is unfindable, an empty command
 * does nothing) and both are trimmed — a leading/trailing newline in a pasted
 * command would otherwise send an empty line and RUN the command, which is
 * exactly what this feature promises not to do.
 */
export function sanitizeSnippetInput(input: { name?: string; command?: string }): { name: string; command: string } | undefined {
  const name = (input.name ?? '').trim().slice(0, SNIPPET_NAME_MAX)
  const command = (input.command ?? '').trim().slice(0, SNIPPET_COMMAND_MAX)
  if (name === '' || command === '') return undefined
  return { name, command }
}

/** Parse the persisted JSON; anything malformed is dropped, never repaired silently. */
export function parseSnippets(raw: string | null | undefined): TerminalSnippet[] {
  if (typeof raw !== 'string' || raw === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const list: TerminalSnippet[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const sanitized = sanitizeSnippetInput({
      name: typeof record.name === 'string' ? record.name : '',
      command: typeof record.command === 'string' ? record.command : '',
    })
    if (sanitized === undefined) continue
    // A duplicated id would make two rows share a React key and a drag target.
    let id = typeof record.id === 'string' && record.id !== '' ? record.id : createSnippetId()
    if (seen.has(id)) id = createSnippetId()
    seen.add(id)
    list.push({ id, ...sanitized })
    if (list.length >= SNIPPETS_MAX) break
  }
  return list
}

/** Serialize only the known fields. */
export function serializeSnippets(list: readonly TerminalSnippet[]): string {
  return JSON.stringify(list.map(item => ({ id: item.id, name: item.name, command: item.command })))
}

/** Append one snippet (newest last); returns the SAME array when it is invalid. */
export function addSnippet(
  list: readonly TerminalSnippet[],
  input: { name?: string; command?: string },
  id: string = createSnippetId(),
): SnippetList {
  const sanitized = sanitizeSnippetInput(input)
  if (sanitized === undefined) return list
  if (list.some(item => item.id === id)) id = createSnippetId()
  const next = [...list, { id, ...sanitized }]
  // The cap drops the OLDEST entry: the newest command is the one being used.
  return next.length > SNIPPETS_MAX ? next.slice(next.length - SNIPPETS_MAX) : next
}

/** Replace one snippet's fields; an invalid edit leaves the list untouched. */
export function updateSnippet(
  list: readonly TerminalSnippet[],
  id: string,
  input: { name?: string; command?: string },
): SnippetList {
  const index = list.findIndex(item => item.id === id)
  if (index < 0) return list
  const sanitized = sanitizeSnippetInput(input)
  if (sanitized === undefined) return list
  const current = list[index] as TerminalSnippet
  if (current.name === sanitized.name && current.command === sanitized.command) return list
  const next = [...list]
  next[index] = { id, ...sanitized }
  return next
}

/** Drop one snippet. */
export function removeSnippet(list: readonly TerminalSnippet[], id: string): SnippetList {
  const next = list.filter(item => item.id !== id)
  return next.length === list.length ? list : next
}

/**
 * Move one snippet to another index (drag & drop), clamping both ends.
 *
 * Returning the SAME list for a no-op keeps the store's "did it change" test
 * cheap and stops a drag that lands on its own row from re-rendering everything.
 */
export function moveSnippet(list: readonly TerminalSnippet[], from: number, to: number): SnippetList {
  if (list.length < 2) return list
  const source = Math.max(0, Math.min(list.length - 1, from))
  const target = Math.max(0, Math.min(list.length - 1, to))
  if (source === target) return list
  const next = [...list]
  const [moved] = next.splice(source, 1)
  if (moved === undefined) return list
  next.splice(target, 0, moved)
  return next
}

/** A list type that is either the caller's unchanged value or a new array. */
type SnippetList = readonly TerminalSnippet[]

// ----------------------------------------------------------------- store

const listeners = new Set<() => void>()
/** Lazy current list; undefined = localStorage not read yet. */
let current: readonly TerminalSnippet[] | undefined

function readFromStorage(): readonly TerminalSnippet[] {
  try {
    return parseSnippets(localStorage.getItem(SNIPPETS_KEY))
  } catch {
    // Private mode / storage disabled: the list works for this session only.
    return []
  }
}

function persist(list: readonly TerminalSnippet[]): void {
  try {
    localStorage.setItem(SNIPPETS_KEY, serializeSnippets(list))
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

/** Current list (identity-stable while unchanged, safe for useSyncExternalStore). */
export function snippetsSnapshot(): readonly TerminalSnippet[] {
  if (current === undefined) current = readFromStorage()
  return current
}

/** Subscribe to snippet changes; returns the unsubscribe. */
export function subscribeSnippets(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Apply one pure transition and persist it when it really changed.
 *
 * The updater must be pure and return either the same array (no change → no
 * notification, no write) or a new one; every CRUD helper above already does.
 */
export function updateSnippets(
  updater: (list: readonly TerminalSnippet[]) => readonly TerminalSnippet[],
): void {
  const before = snippetsSnapshot()
  const next = updater(before)
  if (next === before) return
  current = next
  persist(next)
  emit()
}

/** Reset the module store (the gate drives it directly; production never calls it). */
export function resetSnippetsForTests(list?: readonly TerminalSnippet[]): void {
  current = list ?? []
  listeners.clear()
}
