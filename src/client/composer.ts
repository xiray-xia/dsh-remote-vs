/**
 * Remote `@file` / selection insertion into the current session's composer
 * draft: the far-side twin of dsh-better-sidebar's `conversation-draft.ts` +
 * `selection-payload.ts`. The stock local flow projects explorer rows against
 * the host-confirmed workspace root; remote rows are POSIX absolutes on
 * another machine, so they project against the binding's `remotePath` instead —
 * the same workspace-relative spelling the P3 `TransparentFileReferences`
 * router completes, and the `read` tool consumes through the fs router.
 *
 * Vendored behavior (dsh-better-sidebar **0.28.1**, same semantics):
 * - `leadFor` / `appendText` (the one separating-space rule),
 * - `foldClipboardOffset` / `appendOffset` (the host keeps TWO coordinate
 *   systems over the draft: the clipboard projection — `draft` — expands every
 *   chip to its whole `clipboardText`, while every insert event's `span` speaks
 *   the editor's DETECT projection, one placeholder character per chip; a span
 *   derived without folding is rejected by the host on the second chip),
 * - `insertDraftReference` — mint one structured chip through the host's public
 *   `insertReference` facade (the method the native `@` picker calls), with a
 *   leading space pushed through `slash/input-insert-text` when the draft needs
 *   one,
 * - `appendToDraft` — plain text: `setDraft` only for a chipless draft;
 *   anything carrying chips (or a claimed `/command`) is written through the
 *   span channel, because `setDraft` rebuilds the document from a string and
 *   FLATTENS every chip,
 * - `insertReferenceOrText` — the single fallback policy both surfaces use,
 * - `mentionFor` / `directoryMention` (the `@` quoting grammar),
 * - `SELECTION_LIMIT` / `buildRemoteSelectionInsert` (fenced `rel:lines`
 *   payload; over the limit the content is dropped and the chip carries the
 *   plain path line, so an empty fenced block never occupies the draft).
 *
 * The 0.25.0-era version of this file inserted at the composer's DOM caret and
 * always wrote plain text through `setDraft`; both are gone on purpose — the
 * host publishes no caret for the Lexical composer, and `setDraft` silently
 * destroyed existing chips.
 *
 * Remote adaptations (ours):
 * - `remoteRelativePath`: POSIX-only prefix strip against `remoteRoot`
 *   (case-sensitive; outside/traversal refuses with `undefined`, never an
 *   absolute mention — the local `workspaceRelativePath` policy).
 * - `insertRemoteReference`: the caller passes `remoteRoot` directly; there is
 *   no workspaces-membership lookup here because the binding gate lives in
 *   `use-remote-chat-target.ts` (current session must belong to the viewed
 *   binding, else the button is disabled).
 * - `sameLocalDir`: Windows-tolerant alias-dir comparison for that gate.
 *
 * No ctx reads at module scope (explicit `ctx` params only) so every function
 * degrades to a logged no-op when a web-core service is missing, and the pure
 * pieces stay unit-testable. DOM-only: no Node builtins (the client purity gate
 * forbids them).
 */
import type { Context } from '@deepseek-ai/cordis'

/** One reference chip's footprint in clipboard-projection coordinates. */
export interface OccurrenceLike {
  /** Start offset in the clipboard projection (same plane as `draft`). */
  offset: number
  /** Length in the clipboard projection (the chip's whole `clipboardText`). */
  length: number
}

/** Pick-time draft span guarded by the input revision (detect coordinates). */
export interface TokenSpan {
  start: number
  end: number
  draftRev: number
}

/** The host's structured-reference payload (mirror of `ReferenceInsert`). */
export interface ReferenceInsert {
  /** Trigger source id; `'reference'` for a programmatic insert. */
  source: string
  /** What the model receives on send — the chip's full serialized form. */
  ref: string
  /** What the composer shows in place of `ref`. */
  label: string
  /** Chip icon family; the host picks its own default when omitted. */
  appearance?: 'session' | 'file' | 'folder'
  /** The text this chip occupies in the draft projection. */
  clipboardText: string
}

/**
 * One reference to insert: the compact `label` the composer shows, and the
 * `text` the model receives on send. The two are deliberately different — a
 * selection reads as `docs/a.md:12-15` on screen while the model still gets the
 * whole fenced block. A plain-text fallback inserts `text` (never the label),
 * so a chip failure still delivers the payload the user meant.
 */
export interface PendingReference {
  label: string
  text: string
  /** What the draft string carries for this chip; defaults to `label`. */
  clipboardText?: string
  /** Chip icon family. Omit when `text` is not a path (a selection). */
  appearance?: 'file' | 'folder' | 'session'
}

/** Snapshot the insertion logic reads (structural slice of the host's InputState). */
interface InputSnapshot {
  draft: string
  draftRev?: number
  occurrences?: readonly OccurrenceLike[]
  phase?: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
  claim?: { readonly token: string }
}

/** Structural slice of the web-core conversation service we touch. */
interface SessionInputLike {
  state: { getSnapshot(): InputSnapshot }
  /** Replace the trigger span with one reference chip (span-CAS'd). Absent on older hosts. */
  insertReference?(ref: ReferenceInsert, span: TokenSpan): boolean
  /** Replace the draft text — flattens every existing chip into its text. */
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

interface SessionScopeLike {
  emit?(name: string, payload: unknown): void
}

function sessionScope(ctx: Context, sessionId: string): SessionScopeLike | undefined {
  // Soft read ONLY: direct `ctx.sessions` property access goes through the
  // cordis proxy trap and throws `cannot get property "sessions" without
  // inject` (our client inject is ['slots', 'uiWorkspace'] by design).
  // `ctx.get` is explicitly "without the inject requirement".
  try {
    const sessions = (ctx as unknown as { get(name: string): unknown }).get('sessions') as
      | { scope?(id: string): unknown }
      | undefined
    return typeof sessions?.scope === 'function' ? (sessions.scope(sessionId) as SessionScopeLike | undefined) : undefined
  } catch {
    return undefined
  }
}

/**
 * The separating space an append needs on its left — one space, but never
 * doubled against existing whitespace. Both the string append and the span
 * channel (which does no splice math of its own) obey this single rule. A blank
 * draft takes no separator: it is replaced outright.
 */
function leadFor(draft: string): string {
  if (draft.trim() === '') return ''
  return /\s$/.test(draft) ? '' : ' '
}

/** `draft` with `text` appended behind one separating space when needed. */
export function appendText(draft: string, text: string): string {
  return `${draft}${leadFor(draft)}${text}`
}

/**
 * Fold one clipboard-projection offset to its detect-projection twin.
 *
 * An offset inside a chip's expansion snaps to that chip's trailing edge (the
 * host only ever replaces whole chips, never splits one). An offset exactly at
 * a chip's START resolves to the position BEFORE the chip — the host's own
 * `detectOffsetOfClipboardOffset` reads that case as "inside" and would move a
 * caret one chip too far right.
 */
export function foldClipboardOffset(
  draft: string,
  occurrences: readonly OccurrenceLike[],
  offset: number,
): number {
  const target = Math.max(0, Math.min(offset, draft.length))
  let shrink = 0
  for (const occurrence of occurrences) {
    if (target >= occurrence.offset + occurrence.length) {
      shrink += occurrence.length - 1
      continue
    }
    if (target > occurrence.offset) return occurrence.offset - shrink + 1
    break
  }
  return target - shrink
}

/**
 * The detect-projection offset that appends at the document end, or
 * `undefined` when it cannot be derived.
 *
 * `foldClipboardOffset` alone is not enough: a command chip (`/goal `, present
 * while `phase === 'claimed'`) collapses to one detect character but never
 * appears in `occurrences` — the host only collects REFERENCE chips. The chip
 * covers exactly `claim.token`, a prefix of the draft, so its own characters
 * fold away and one placeholder takes their place.
 */
export function appendOffset(snapshot: InputSnapshot): number | undefined {
  const { draft, claim } = snapshot
  const occurrences = snapshot.occurrences ?? []
  const token = snapshot.phase === 'claimed' && claim !== undefined && draft.startsWith(claim.token)
    ? claim.token
    : ''
  if (token === '') return foldClipboardOffset(draft, occurrences, draft.length)
  const rest = draft.slice(token.length)
  return 1 + foldClipboardOffset(
    rest,
    occurrences
      .filter(occurrence => occurrence.offset >= token.length)
      .map(occurrence => ({ offset: occurrence.offset - token.length, length: occurrence.length })),
    rest.length,
  )
}

/**
 * Whether the session's draft revision moved past `revision` — the only
 * trustworthy success signal after an exception swallowed the host's answer.
 */
function revisionChanged(ctx: Context, sessionId: string, revision: number | undefined): boolean {
  try {
    const actx = sessionScope(ctx, sessionId)
    if (actx === undefined) return false
    const now = conversationOf(ctx)?.input.for(actx).state.getSnapshot().draftRev
    if (now === undefined || revision === undefined) return false
    return now !== revision
  } catch {
    return false
  }
}

/** One session's resolved input facade, or a logged reason why not. */
function inputFor(
  ctx: Context,
  sessionId: string,
  reason: string,
): { actx: SessionScopeLike; input: SessionInputLike } | undefined {
  const actx = sessionScope(ctx, sessionId)
  if (actx === undefined) {
    console.warn(`[dsh-remote-vs] ${reason}: no session scope`, sessionId)
    return undefined
  }
  const conversation = conversationOf(ctx)
  if (conversation === undefined) {
    console.warn(`[dsh-remote-vs] ${reason}: conversation service unavailable`)
    return undefined
  }
  try {
    return { actx, input: conversation.input.for(actx) }
  } catch (error) {
    console.warn(`[dsh-remote-vs] ${reason}: input facade unavailable`, error)
    return undefined
  }
}

/**
 * Mint one reference chip through the host's public `insertReference` facade —
 * the same method the native `@` picker's event listener calls, so the
 * composer shows a compact chip while the model receives `reference.text`.
 * The host runs its own admission-phase and revision guards and reports whether
 * the edit applied.
 *
 * The chip's `clipboardText` is the compact `label` by default, not the full
 * payload: other draft consumers (copy, plain projections) stay short, and the
 * full payload rides in `text` for send.
 *
 * @returns false when the host refused the insert (stale revision, frozen
 *   submission phase, or no chip channel) so the caller can fall back.
 */
export function insertDraftReference(
  ctx: Context,
  sessionId: string,
  reference: PendingReference,
): boolean {
  let before: number | undefined
  try {
    const resolved = inputFor(ctx, sessionId, 'reference chip skipped')
    if (resolved === undefined) return false
    const { actx, input } = resolved
    const snapshot = input.state.getSnapshot()
    if (input.insertReference === undefined || snapshot.draftRev === undefined) return false
    if (snapshot.phase === 'adjudicating' || snapshot.phase === 'submitting') return false
    before = snapshot.draftRev
    const at = appendOffset(snapshot)
    if (at === undefined) return false
    let rev = snapshot.draftRev
    let start = at
    // The host adds a space AFTER a chip, never before it; a chip appended to
    // a non-empty draft needs its own separator, pushed through the span
    // channel so the chip insertion itself stays a pure replacement.
    if (leadFor(snapshot.draft) !== '') {
      actx.emit?.('slash/input-insert-text', {
        text: ' ',
        span: { draftRev: rev, start: at, end: at },
      })
      const afterSpace = input.state.getSnapshot()
      if (afterSpace.draftRev === rev) return false
      rev = afterSpace.draftRev ?? rev
      start = at + 1
    }
    const chip: ReferenceInsert = {
      source: 'reference',
      ref: reference.text,
      label: reference.label,
      ...(reference.appearance === undefined ? {} : { appearance: reference.appearance }),
      clipboardText: reference.clipboardText ?? reference.label,
    }
    return input.insertReference(chip, { draftRev: rev, start, end: start })
  } catch (error) {
    console.warn('[dsh-remote-vs] reference chip insert failed:', error)
    return revisionChanged(ctx, sessionId, before)
  }
}

/**
 * Append `text` to the session's composer draft. Returns false — and logs —
 * when the conversation service or the session scope is unavailable.
 *
 * A chipless draft takes the plain `setDraft` path. A draft that CARRIES chips
 * is written through `slash/input-insert-text` at the folded end offset
 * instead: `setDraft` rebuilds the document from a string and flattens every
 * chip, which quietly destroys references the user placed by hand. The same
 * span path covers a claimed `/command`, whose prefix chip is not in
 * `occurrences` (see {@link appendOffset}).
 */
export function appendToDraft(ctx: Context, sessionId: string, text: string): boolean {
  try {
    const resolved = inputFor(ctx, sessionId, 'draft insert skipped')
    if (resolved === undefined) return false
    const { actx, input } = resolved
    const snapshot = input.state.getSnapshot()
    const draft = snapshot.draft
    if ((snapshot.occurrences ?? []).length > 0 || snapshot.phase === 'claimed') {
      const at = appendOffset(snapshot)
      if (snapshot.draftRev === undefined || at === undefined) {
        console.warn('[dsh-remote-vs] draft insert skipped: chip draft without a revision')
        return false
      }
      actx.emit?.('slash/input-insert-text', {
        text: `${leadFor(draft)}${text}`,
        span: { draftRev: snapshot.draftRev, start: at, end: at },
      })
      return input.state.getSnapshot().draftRev !== snapshot.draftRev
    }
    input.setDraft(appendText(draft, text))
    return true
  } catch (error) {
    console.warn('[dsh-remote-vs] draft insert failed:', error)
    return false
  }
}

/**
 * Insert one reference as a chip, degrading to its plain-text form when the
 * host has no chip channel or refuses the insert. This is the ONE place the
 * fallback policy lives: the explorer's `@` button and the viewer selection
 * popup both come through here.
 */
export function insertReferenceOrText(
  ctx: Context,
  sessionId: string,
  reference: PendingReference,
): boolean {
  return insertDraftReference(ctx, sessionId, reference) || appendToDraft(ctx, sessionId, reference.text)
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
 * mint a structured chip exactly like the native `@` picker (same facade the
 * viewer selection popup uses, with a plain-text fallback); directories append
 * the folder mention as plain text so DSH's folder decoration and completion
 * keep working. The caller owns the binding gate (the session must belong to
 * the viewed binding — see `use-remote-chat-target.ts`); an unrepresentable
 * path is a logged no-op, never an absolute mention.
 */
export function insertRemoteReference(
  ctx: Context | undefined,
  sessionId: string,
  remoteRoot: string,
  absPath: string,
  isDir: boolean,
): boolean {
  // The shared explorer store boots asynchronously: before its context lands
  // the insertion is a no-op rather than a crash.
  if (ctx === undefined) return false
  try {
    const relative = remoteRelativePath(remoteRoot, absPath)
    if (relative === undefined) {
      console.warn('[dsh-remote-vs] reference insert skipped: path outside the remote workspace root')
      return false
    }
    const token = isDir ? directoryMention(relative) : mentionFor(relative, 'file')?.mention
    if (token === undefined) {
      console.warn('[dsh-remote-vs] reference insert skipped: path cannot be represented as a mention')
      return false
    }
    if (isDir) {
      // Complete directory inserts need their own separator for the next @
      // click; the host adds space after a chip but not before it.
      return appendToDraft(ctx, sessionId, `${token} `)
    }
    const label = mentionFor(relative, 'file')?.label ?? token
    return insertReferenceOrText(ctx, sessionId, {
      label,
      text: token,
      clipboardText: token,
      appearance: 'file',
    })
  } catch (error) {
    console.warn('[dsh-remote-vs] remote-reference insert failed:', error)
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
 * The composer payload for one selection: the chip label and the model text.
 *
 * The chip reads as `rel:start-end` (compact, and it is what the draft
 * projection carries); the model receives the whole fenced block. Over the
 * limit the content is dropped and BOTH halves are the plain path line — an
 * empty fenced block would just occupy the draft. No `appearance` is set: the
 * host can make `'file'` chips openable, and a selection's `text` is not a
 * path, so a click must not hand a fenced block to the file opener.
 */
export function buildRemoteSelectionInsert(
  absPath: string,
  remoteRoot: string,
  lines: SelectionLines | undefined,
  selected: string,
): PendingReference {
  const header = remoteHeaderOf(remoteRoot, absPath, lines)
  if (selected.length > SELECTION_LIMIT) return { label: header, text: header }
  return { label: header, text: `\`\`\`${header}\n${selected}\n\`\`\`` }
}
