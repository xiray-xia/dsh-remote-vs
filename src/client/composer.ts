/**
 * Remote `@file` insertion into the current session's composer draft: the
 * far-side twin of dsh-better-sidebar's `conversation-draft.ts` /
 * `selection-payload.ts` (logic vendored, see below). The stock local flow
 * projects explorer rows against the host-confirmed workspace root; remote
 * rows are POSIX absolutes on another machine, so they project against the
 * binding's `remotePath` instead — the same workspace-relative spelling the
 * P3 `TransparentFileReferences` router completes, and the `read` tool
 * consumes through the fs router.
 *
 * Vendored pieces (behavior-identical to better-sidebar 0.25.0):
 * - `spliceInsert` / `insertAtCaret` (whitespace-aware caret splice),
 * - `findComposerTextarea` / `probeComposerCaret` /
 *   `placeComposerCaretAfterInsert` (DOM caret probe; on DSH 0.2.1 the
 *   composer is a Lexical editor, so the probe misses and inserts append at
 *   the end — exactly what the local explorer does there),
 * - `appendToDraft` (draft read + `setDraft` write through
 *   `ctx.get('conversation')`, missing service degrades to a logged no-op),
 * - `mentionFor` / `directoryMention` (the `@` quoting grammar),
 * - `insertFileReference` (`slash/input-insert-reference`, verified present
 *   in DSH 0.2.1-alpha.2's dsh-client-ui-conversation contract),
 * - `SELECTION_LIMIT` / `buildRemoteSelectionInsert` (the fenced
 *   `rel:lines` payload shape).
 *
 * Remote adaptations (ours):
 * - `remoteRelativePath`: POSIX-only prefix strip against `remoteRoot`
 *   (case-sensitive; outside/traversal refuses with `undefined`, never an
 *   absolute mention — the local `workspaceRelativePath` policy).
 * - `insertRemoteReference`: the caller passes `remoteRoot` directly; there
 *   is no workspaces-membership lookup here because the binding gate lives
 *   in `use-remote-chat-target.ts` (current session must belong to the
 *   viewed binding, else the button is disabled — a remote-relative mention
 *   in a local session would name nothing).
 * - `sameLocalDir`: Windows-tolerant alias-dir comparison for that gate.
 *
 * No ctx reads at module scope (explicit `ctx` params only) so every
 * function degrades to a logged no-op when a web-core service is missing,
 * and the pure pieces stay unit-testable. DOM-only: no Node builtins (the
 * client purity gate forbids them).
 */
import type { Context } from '@deepseek-ai/cordis'

/** Structural slice of the web-core conversation service we touch. */
interface SessionInputLike {
  state: { getSnapshot(): { draft: string; draftRev?: number } }
  setDraft(text: string): void
}

interface ConversationLike {
  input: { for(actx: unknown): SessionInputLike }
}

function conversationOf(ctx: Context): ConversationLike | undefined {
  try {
    const raw = (ctx as unknown as { get(name: string): unknown }).get('conversation')
    if (typeof raw !== 'object' || raw === null) return undefined
    const input = (raw as { input?: unknown }).input as { for?: unknown } | undefined
    if (typeof input?.for !== 'function') return undefined
    return raw as ConversationLike
  } catch {
    return undefined
  }
}

function sessionScope(ctx: Context, sessionId: string): unknown {
  // Soft read ONLY: direct `ctx.sessions` property access goes through the
  // cordis proxy trap and throws `cannot get property "sessions" without
  // inject` (our client inject is ['slots', 'uiWorkspace'] by design).
  // `ctx.get` is explicitly "without the inject requirement".
  try {
    const sessions = (ctx as unknown as { get(name: string): unknown }).get('sessions') as
      | { scope?(id: string): unknown }
      | undefined
    return typeof sessions?.scope === 'function' ? sessions.scope(sessionId) : undefined
  } catch {
    return undefined
  }
}

/** A resolved composer caret/selection in draft coordinates. */
export interface DraftCaret {
  start: number
  end: number
}

/**
 * The spliced draft plus the caret index (in that draft) right after the
 * inserted text — the left-side separating space shifts the caret by one,
 * which naive `start + text.length` misses (it would land before the tail).
 */
interface SpliceResult {
  draft: string
  caretAfter: number
}

/**
 * Splice `text` into `draft` at `caret` (replacing any live selection) with
 * whitespace-aware joins and report the caret position right after the
 * inserted text. `caret === null` (position unknown) appends at the end,
 * exactly like the original behavior.
 */
function spliceInsert(draft: string, text: string, caret: DraftCaret | null): SpliceResult {
  if (caret === null || draft === '') {
    const next = draft.trim() === '' ? text : `${draft}${/\s$/.test(draft) ? '' : ' '}${text}`
    return { draft: next, caretAfter: next.length }
  }
  const prefix = draft.slice(0, caret.start)
  const suffix = draft.slice(caret.end)
  if (prefix === '' && suffix === '') return { draft: text, caretAfter: text.length }
  // One separating space, but never doubled against adjacent whitespace
  // (or the string edges) — mirrors how typing in the middle of a sentence
  // behaves.
  const left = prefix === '' || /\s$/.test(prefix) ? '' : ' '
  const right = suffix === '' || /^\s/.test(suffix) || /\s$/.test(text) ? '' : ' '
  return {
    draft: `${prefix}${left}${text}${right}${suffix}`,
    caretAfter: prefix.length + left.length + text.length,
  }
}

/**
 * The spliced draft string (see {@link spliceInsert}); pure string math —
 * unit-tested directly.
 */
export function insertAtCaret(draft: string, text: string, caret: DraftCaret | null): string {
  return spliceInsert(draft, text, caret).draft
}

/**
 * Locate the composer `<textarea>` in the conversation column: prefer the
 * `data-phase`-tagged textarea (the composer's marker), falling back to any
 * textarea in the column, then to a bare data-phase textarea (older host
 * layouts without the column attribute). Null in jsdom-less hosts — and on
 * DSH 0.2.1, whose composer is a Lexical contenteditable (the probe then
 * misses and callers append at the end, matching the local explorer).
 */
function findComposerTextarea(): HTMLTextAreaElement | null {
  if (typeof document === 'undefined') return null
  const column = document.querySelector('#root [data-slot="conversation"]')
  const find = (scope: ParentNode): HTMLTextAreaElement | null =>
    scope.querySelector('textarea[data-phase]') ?? scope.querySelector('textarea')
  return column !== null
    ? find(column)
    : document.querySelector<HTMLTextAreaElement>('textarea[data-phase]')
}

/**
 * Resolve the composer's live caret from its DOM `<textarea>`. The draft
 * store has no caret API, so the value-sync check (`el.value === draft`)
 * discards stale or wrong-composer reads — a caret must never be applied
 * against a draft it was not measured on.
 *
 * Returns null when the composer is missing, disabled/read-only, out of
 * sync with the store draft, or has no measurable selection (jsdom/odd
 * hosts report null selectionStart/End).
 */
export function probeComposerCaret(draft: string): DraftCaret | null {
  const el = findComposerTextarea()
  if (el === null || el.disabled || el.readOnly) return null
  if (el.value !== draft) return null
  let start = el.selectionStart
  let end = el.selectionEnd
  if (typeof start !== 'number' || typeof end !== 'number') return null
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  start = Math.max(0, Math.min(start, draft.length))
  end = Math.max(start, Math.min(end, draft.length))
  return { start, end }
}

/**
 * Restore the composer caret to `caretIndex` after a programmatic
 * `setDraft` commit. A controlled textarea update resets the caret (React
 * commits the value asynchronously and the browser moves the caret to the
 * start/end), so the placement is scheduled and retried across at most two
 * animation frames (setTimeout fallback for jsdom), and only applied when
 * the textarea still matches `expectedDraft` — a newer edit or a different
 * composer wins the race untouched. The caret is clamped into the value
 * bounds, mirroring how browsers clamp type-in positions.
 */
export function placeComposerCaretAfterInsert(expectedDraft: string, caretIndex: number): void {
  let remaining = 2
  let scheduled = false
  const schedule = (fn: () => void): void => {
    if (scheduled) return
    scheduled = true
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn)
    else setTimeout(fn, 0)
  }
  const place = (): void => {
    scheduled = false
    if (remaining <= 0) return
    remaining -= 1
    const el = findComposerTextarea()
    if (el === null || el.disabled || el.readOnly) return
    if (el.value !== expectedDraft) {
      // The commit has not landed yet (or a competing edit won) — one more
      // frame before giving up.
      schedule(place)
      return
    }
    const clamped = Math.max(0, Math.min(caretIndex, el.value.length))
    el.setSelectionRange(clamped, clamped)
  }
  schedule(place)
}

/**
 * Insert `text` into the session's composer draft at the composer's live
 * caret (see {@link probeComposerCaret}), falling back to appending at the
 * end when the caret cannot be resolved. Returns false — and logs — when the
 * conversation service or the session scope is unavailable.
 */
export function appendToDraft(ctx: Context, sessionId: string, text: string): boolean {
  try {
    const actx = sessionScope(ctx, sessionId)
    if (actx === undefined) {
      console.warn('[dsh-remote-vs] draft insert skipped: no session scope', sessionId)
      return false
    }
    const conversation = conversationOf(ctx)
    if (conversation === undefined) {
      console.warn('[dsh-remote-vs] draft insert skipped: conversation service unavailable')
      return false
    }
    const input = conversation.input.for(actx)
    const draft = input.state.getSnapshot().draft
    const caret = probeComposerCaret(draft)
    const { draft: next, caretAfter } = spliceInsert(draft, text, caret)
    input.setDraft(next)
    // Put the caret right after the inserted text once the value commit
    // lands — see the module doc for why this keeps stacked inserts at the
    // running position.
    placeComposerCaretAfterInsert(next, caretAfter)
    return true
  } catch (error) {
    console.warn('[dsh-remote-vs] draft insert failed:', error)
    return false
  }
}

/**
 * The DSH `@` spelling for one relative path, mirroring the host grammar
 * (`formatFileMention` in `@deepseek-ai/dsh-file-reference`): plain when
 * there is no whitespace, quoted when there is, and `undefined` when the
 * path contains a control character or an embedded quote the editor grammar
 * cannot represent.
 *
 * Files and folders share this one constructor so the quoting rule cannot
 * drift between them. A folder spells the trailing slash *inside* the quotes
 * (`@"my dir/"`, `@docs/`): the host's folder token matcher
 * (`FOLDER_REF_RE` in `dsh-client-ui-conversation`) only accepts a quoted
 * directory once the quote closes, and the message bubble's tokenizer
 * (`@"[^"\n]+"` in `dsh-client-ui-primitives`) only classifies a closed
 * quoted token as a folder — unquoted `@my dir/` decorates as a file chip
 * covering just `my`. The host's own picker emits the *open* form
 * (`@"my dir/`) while the user is still descending through completion; a
 * programmatic reference is a finished mention, so it closes the quote.
 */
export function mentionFor(
  relativePath: string,
  kind: 'file' | 'folder',
): { mention: string; label: string } | undefined {
  const path = relativePath.replace(/[\\/]+$/, '')
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point of this guard
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined
  const target = kind === 'folder' ? `${path}/` : path
  const mention = /\s/u.test(target) ? `@"${target}"` : `@${target}`
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const label = at === -1 ? path : path.slice(at + 1)
  return { mention, label }
}

/**
 * A complete directory token (`@docs/`, `@"my dir/"`): the explorer inserts a
 * finished mention, so the trailing slash sits inside the closing quote.
 * Separators normalize to '/' first (the fs-tree spelling); the spelling
 * itself is {@link mentionFor}'s single job, folder kind — this helper adds no
 * quoting rule of its own.
 */
export function directoryMention(relativePath: string): string | undefined {
  return mentionFor(relativePath.replace(/\\/g, '/'), 'folder')?.mention
}

/**
 * Project one absolute POSIX remote path against the binding's remote root.
 * The remote twin of better-sidebar's `workspaceRelativePath`: unknown roots,
 * traversal components and paths outside the root are refused with
 * `undefined` — a mention must never fall back to an absolute token.
 * Case-sensitive (remote hosts are POSIX); both inputs must be absolute.
 */
export function remoteRelativePath(root: string | undefined, path: string): string | undefined {
  if (root === undefined || !root.startsWith('/') || !path.startsWith('/')) return undefined
  const strip = (value: string): string => (value === '/' ? value : value.replace(/\/+$/, ''))
  const base = strip(root)
  const target = strip(path)
  if ([base, target].some(value => value.split('/').some(part => part === '.' || part === '..'))) return undefined
  if (target === base) return '.'
  if (!target.startsWith(`${base === '/' ? '' : base}/`)) return undefined
  const relative = base === '/' ? target.slice(1) : target.slice(base.length + 1)
  return relative === '' || relative.startsWith('/') ? undefined : relative
}

/**
 * Whether two Host-local directory paths name the same directory. The
 * session↔binding gate compares the workspaces snapshot path (canonical
 * host dir) against our `aliasPaths` entry; both spellings may differ in
 * separators, trailing slashes and — on Windows/macOS — letter case, so all
 * three normalize before comparison. Alias ids are hex, so lowercasing is
 * lossless on every platform DSH runs on.
 */
export function sameLocalDir(left: string, right: string): boolean {
  const norm = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(left) === norm(right)
}

/**
 * Insert one remote explorer entry into the session's composer draft. Files
 * mint a structured chip like the native `@` picker
 * (`insertFileReference`); directories append the folder mention as plain
 * text so DSH's folder decoration and completion keep working. The caller
 * owns the binding gate (the session must belong to the viewed binding —
 * see `use-remote-chat-target.ts`); an unrepresentable path is a logged
 * no-op, never an absolute mention.
 */
export function insertRemoteReference(
  ctx: Context,
  sessionId: string,
  remoteRoot: string,
  absPath: string,
  isDir: boolean,
): boolean {
  try {
    const relative = remoteRelativePath(remoteRoot, absPath)
    if (relative === undefined) {
      console.warn('[dsh-remote-vs] reference insert skipped: path outside the remote workspace root')
      return false
    }
    const mention = isDir ? directoryMention(relative) : mentionFor(relative, 'file')?.mention
    if (mention === undefined) {
      console.warn('[dsh-remote-vs] reference insert skipped: path cannot be represented as a mention')
      return false
    }
    if (!isDir && insertFileReference(ctx, sessionId, relative)) return true
    // The host adds space after a file chip, but not before it. Complete
    // directory inserts need their own separator for the next @ click.
    return appendToDraft(ctx, sessionId, isDir ? `${mention} ` : mention)
  } catch (error) {
    console.warn('[dsh-remote-vs] remote-reference insert failed:', error)
    return false
  }
}

/**
 * Insert one FILE reference as a structured chip (like DSH's own `@` picker).
 * The chip displays `@<basename>` but serializes to `@<relative path>` on
 * send, so the reference stays a single link from trigger to basename.
 *
 * Directories keep the plain-text completion behavior (`@dir/`) through
 * `insertRemoteReference`. The rc.1 picker also supports folder chips on
 * explicit selection; its drill action still inserts plain text.
 */
export function insertFileReference(ctx: Context, sessionId: string, relativePath: string): boolean {
  const reference = mentionFor(relativePath, 'file')
  if (reference === undefined) return false
  try {
    const actx = sessionScope(ctx, sessionId)
    if (actx === undefined) return false
    const conversation = conversationOf(ctx)
    if (conversation === undefined) return false
    const input = conversation.input.for(actx)
    const before = input.state.getSnapshot()
    if (before.draftRev === undefined) return false
    // The session-scope Context's typed `emit` is keyed to DSH's closed event
    // map; this internal composer event is deliberately string-loose at runtime.
    // Verified present in DSH 0.2.1-alpha.2 (dsh-client-ui-conversation
    // `input.d.ts`: 'slash/input-insert-reference').
    ;(actx as unknown as { emit(name: string, payload: unknown): void }).emit('slash/input-insert-reference', {
      reference: {
        source: 'reference',
        ref: reference.mention,
        label: reference.label,
        appearance: 'file',
        clipboardText: reference.mention,
      },
      span: {
        draftRev: before.draftRev,
        start: before.draft.length,
        end: before.draft.length,
      },
    })
    const after = input.state.getSnapshot()
    return after.draftRev !== before.draftRev
  } catch (error) {
    console.warn('[dsh-remote-vs] file-reference insert failed:', error)
    return false
  }
}

/** Max inserted selection length (UTF-16 code units, i.e. JS `.length`). */
export const SELECTION_LIMIT = 500

/** The source line span a selection maps to (1-based, inclusive). */
export interface SelectionLines {
  start: number
  end: number
}

/**
 * The fence info line: `rel[:start[-end]]` — lines are omitted entirely
 * when unknown.
 */
export function remoteHeaderOf(remoteRoot: string, absPath: string, lines?: SelectionLines): string {
  const rel = remoteRelativePath(remoteRoot, absPath) ?? absPath
  if (lines === undefined) return rel
  if (lines.end > lines.start) return `${rel}:${lines.start}-${lines.end}`
  return `${rel}:${lines.start}`
}

/**
 * The full text appended to the composer draft for one selection.
 * Over the limit the content is dropped: the plain path line is the whole
 * payload (an empty fenced block would just occupy the draft).
 */
export function buildRemoteSelectionInsert(
  absPath: string,
  remoteRoot: string,
  lines: SelectionLines | undefined,
  selected: string,
): string {
  const header = remoteHeaderOf(remoteRoot, absPath, lines)
  if (selected.length > SELECTION_LIMIT) return header
  return `\`\`\`${header}\n${selected}\n\`\`\``
}
