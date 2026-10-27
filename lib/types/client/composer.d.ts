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
import type { Context } from '@deepseek-ai/cordis';
/** One reference chip's footprint in clipboard-projection coordinates. */
export interface OccurrenceLike {
    /** Start offset in the clipboard projection (same plane as `draft`). */
    offset: number;
    /** Length in the clipboard projection (the chip's whole `clipboardText`). */
    length: number;
}
/** Pick-time draft span guarded by the input revision (detect coordinates). */
export interface TokenSpan {
    start: number;
    end: number;
    draftRev: number;
}
/** The host's structured-reference payload (mirror of `ReferenceInsert`). */
export interface ReferenceInsert {
    /** Trigger source id; `'reference'` for a programmatic insert. */
    source: string;
    /** What the model receives on send — the chip's full serialized form. */
    ref: string;
    /** What the composer shows in place of `ref`. */
    label: string;
    /** Chip icon family; the host picks its own default when omitted. */
    appearance?: 'session' | 'file' | 'folder';
    /** The text this chip occupies in the draft projection. */
    clipboardText: string;
}
/**
 * One reference to insert: the compact `label` the composer shows, and the
 * `text` the model receives on send. The two are deliberately different — a
 * selection reads as `docs/a.md:12-15` on screen while the model still gets the
 * whole fenced block. A plain-text fallback inserts `text` (never the label),
 * so a chip failure still delivers the payload the user meant.
 */
export interface PendingReference {
    label: string;
    text: string;
    /** What the draft string carries for this chip; defaults to `label`. */
    clipboardText?: string;
    /** Chip icon family. Omit when `text` is not a path (a selection). */
    appearance?: 'file' | 'folder' | 'session';
}
/** Snapshot the insertion logic reads (structural slice of the host's InputState). */
interface InputSnapshot {
    draft: string;
    draftRev?: number;
    occurrences?: readonly OccurrenceLike[];
    phase?: 'plain' | 'adjudicating' | 'claimed' | 'submitting';
    claim?: {
        readonly token: string;
    };
}
/** `draft` with `text` appended behind one separating space when needed. */
export declare function appendText(draft: string, text: string): string;
/**
 * Fold one clipboard-projection offset to its detect-projection twin.
 *
 * An offset inside a chip's expansion snaps to that chip's trailing edge (the
 * host only ever replaces whole chips, never splits one). An offset exactly at
 * a chip's START resolves to the position BEFORE the chip — the host's own
 * `detectOffsetOfClipboardOffset` reads that case as "inside" and would move a
 * caret one chip too far right.
 */
export declare function foldClipboardOffset(draft: string, occurrences: readonly OccurrenceLike[], offset: number): number;
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
export declare function appendOffset(snapshot: InputSnapshot): number | undefined;
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
export declare function insertDraftReference(ctx: Context, sessionId: string, reference: PendingReference): boolean;
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
export declare function appendToDraft(ctx: Context, sessionId: string, text: string): boolean;
/**
 * Insert one reference as a chip, degrading to its plain-text form when the
 * host has no chip channel or refuses the insert. This is the ONE place the
 * fallback policy lives: the explorer's `@` button and the viewer selection
 * popup both come through here.
 */
export declare function insertReferenceOrText(ctx: Context, sessionId: string, reference: PendingReference): boolean;
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
 * mint a structured chip exactly like the native `@` picker (same facade the
 * viewer selection popup uses, with a plain-text fallback); directories append
 * the folder mention as plain text so DSH's folder decoration and completion
 * keep working. The caller owns the binding gate (the session must belong to
 * the viewed binding — see `use-remote-chat-target.ts`); an unrepresentable
 * path is a logged no-op, never an absolute mention.
 */
export declare function insertRemoteReference(ctx: Context | undefined, sessionId: string, remoteRoot: string, absPath: string, isDir: boolean): boolean;
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
 * The composer payload for one selection: the chip label and the model text.
 *
 * The chip reads as `rel:start-end` (compact, and it is what the draft
 * projection carries); the model receives the whole fenced block. Over the
 * limit the content is dropped and BOTH halves are the plain path line — an
 * empty fenced block would just occupy the draft. No `appearance` is set: the
 * host can make `'file'` chips openable, and a selection's `text` is not a
 * path, so a click must not hand a fenced block to the file opener.
 */
export declare function buildRemoteSelectionInsert(absPath: string, remoteRoot: string, lines: SelectionLines | undefined, selected: string): PendingReference;
export {};
