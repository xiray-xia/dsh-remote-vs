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
import type { Context } from '@deepseek-ai/cordis';
/** A resolved composer caret/selection in draft coordinates. */
export interface DraftCaret {
    start: number;
    end: number;
}
/**
 * The spliced draft string (see {@link spliceInsert}); pure string math —
 * unit-tested directly.
 */
export declare function insertAtCaret(draft: string, text: string, caret: DraftCaret | null): string;
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
export declare function probeComposerCaret(draft: string): DraftCaret | null;
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
export declare function placeComposerCaretAfterInsert(expectedDraft: string, caretIndex: number): void;
/**
 * Insert `text` into the session's composer draft at the composer's live
 * caret (see {@link probeComposerCaret}), falling back to appending at the
 * end when the caret cannot be resolved. Returns false — and logs — when the
 * conversation service or the session scope is unavailable.
 */
export declare function appendToDraft(ctx: Context, sessionId: string, text: string): boolean;
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
export declare function mentionFor(relativePath: string, kind: 'file' | 'folder'): {
    mention: string;
    label: string;
} | undefined;
/**
 * A complete directory token (`@docs/`, `@"my dir/"`): the explorer inserts a
 * finished mention, so the trailing slash sits inside the closing quote.
 * Separators normalize to '/' first (the fs-tree spelling); the spelling
 * itself is {@link mentionFor}'s single job, folder kind — this helper adds no
 * quoting rule of its own.
 */
export declare function directoryMention(relativePath: string): string | undefined;
/**
 * Project one absolute POSIX remote path against the binding's remote root.
 * The remote twin of better-sidebar's `workspaceRelativePath`: unknown roots,
 * traversal components and paths outside the root are refused with
 * `undefined` — a mention must never fall back to an absolute token.
 * Case-sensitive (remote hosts are POSIX); both inputs must be absolute.
 */
export declare function remoteRelativePath(root: string | undefined, path: string): string | undefined;
/**
 * Whether two Host-local directory paths name the same directory. The
 * session↔binding gate compares the workspaces snapshot path (canonical
 * host dir) against our `aliasPaths` entry; both spellings may differ in
 * separators, trailing slashes and — on Windows/macOS — letter case, so all
 * three normalize before comparison. Alias ids are hex, so lowercasing is
 * lossless on every platform DSH runs on.
 */
export declare function sameLocalDir(left: string, right: string): boolean;
/**
 * Insert one remote explorer entry into the session's composer draft. Files
 * mint a structured chip like the native `@` picker
 * (`insertFileReference`); directories append the folder mention as plain
 * text so DSH's folder decoration and completion keep working. The caller
 * owns the binding gate (the session must belong to the viewed binding —
 * see `use-remote-chat-target.ts`); an unrepresentable path is a logged
 * no-op, never an absolute mention.
 */
export declare function insertRemoteReference(ctx: Context | undefined, sessionId: string, remoteRoot: string, absPath: string, isDir: boolean): boolean;
/**
 * Insert one FILE reference as a structured chip (like DSH's own `@` picker).
 * The chip displays `@<basename>` but serializes to `@<relative path>` on
 * send, so the reference stays a single link from trigger to basename.
 *
 * Directories keep the plain-text completion behavior (`@dir/`) through
 * `insertRemoteReference`. The rc.1 picker also supports folder chips on
 * explicit selection; its drill action still inserts plain text.
 */
export declare function insertFileReference(ctx: Context, sessionId: string, relativePath: string): boolean;
/** Max inserted selection length (UTF-16 code units, i.e. JS `.length`). */
export declare const SELECTION_LIMIT = 500;
/** The source line span a selection maps to (1-based, inclusive). */
export interface SelectionLines {
    start: number;
    end: number;
}
/**
 * The fence info line: `rel[:start[-end]]` — lines are omitted entirely
 * when unknown.
 */
export declare function remoteHeaderOf(remoteRoot: string, absPath: string, lines?: SelectionLines): string;
/**
 * The full text appended to the composer draft for one selection.
 * Over the limit the content is dropped: the plain path line is the whole
 * payload (an empty fenced block would just occupy the draft).
 */
export declare function buildRemoteSelectionInsert(absPath: string, remoteRoot: string, lines: SelectionLines | undefined, selected: string): string;
