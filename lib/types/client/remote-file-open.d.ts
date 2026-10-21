/**
 * Click interception for file references that belong to a REMOTE workspace.
 *
 * DSH opens every file reference through `ctx.sidebarRight.openResource()`
 * (chat `openFile`, deliverables, `@file`, the files tree — one entry point),
 * and its preview reads the address path against the SESSION WORKSPACE ROOT.
 * In a remote session that root is an EMPTY local alias directory, and a model
 * usually quotes paths relative to the directory it actually worked in, so the
 * click either misses by one segment or dies on the host ENOENT — the exact
 * failure users hit on the final-answer file chips.
 *
 * This module wraps that one method: an address that resolves to one of our
 * bindings is opened in OUR editor instead (centre 「远程编辑器」 tab, with
 * the workspace selected); everything else — local sessions, non-file
 * addresses, unresolved sessions — falls through to the original method
 * synchronously, so the native behaviour is preserved untouched.
 *
 * The wrapper is deliberately fail-safe: resolution is synchronous first (the
 * native path is taken whenever this is not clearly a remote click), and the
 * async part (session-cwd probe + remote existence check) can only ever land
 * the click in our editor or fall back to the native open. It never throws out
 * of `openResource`, which callers invoke inside their own try/catch.
 */
import type { Context } from '@deepseek-ai/cordis';
/**
 * Install the click interceptor on the shared `sidebarRight` service.
 *
 * The client plugin's `inject` list is prefetch-only, so the service may not
 * exist when ours applies: poll briefly (same pattern as the explorer surface)
 * and stop on dispose. A host without `sidebarRight` simply never matches.
 *
 * @param ctx - client root context.
 * @returns disposer restoring the original method.
 */
export declare function installRemoteFileOpen(ctx: Context): () => void;
