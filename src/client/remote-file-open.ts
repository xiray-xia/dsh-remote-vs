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
import type { Context } from '@deepseek-ai/cordis'
import { api } from './api.ts'
import {
  parseFileAddress,
  resolveRemoteOpenTarget,
  suffixFindCommand,
  uniqueSuffixMatch,
  type ParsedFileAddress,
  type RemoteOpenBinding,
} from './remote-file-open-target.ts'
import { isEditorCentered, openRemoteFileInBinding, remoteOpenBindings } from './store.tsx'
import { workspacePathOf } from './use-remote-chat-target.ts'

interface SidebarRightLike {
  openResource?: (address: string, options?: unknown) => unknown
}

/** Milliseconds one optional round trip may cost before the click proceeds. */
const CWD_PROBE_MS = 1_500
/** Milliseconds one remote existence probe may cost. */
const EXIST_PROBE_MS = 4_000

/** Bound services: original method per sidebarRight instance (idempotent). */
const originals = new WeakMap<object, (address: string, options?: unknown) => unknown>()

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** The `line` a caller asked to reveal, from either option spelling. */
function lineOf(options: unknown): number | undefined {
  if (typeof options !== 'object' || options === null) return undefined
  const record = options as { line?: unknown; params?: { line?: unknown } }
  const value = record.line ?? record.params?.line
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * Probe candidates in order and return the first one that exists.
 *
 * Every click pays at most one remote stat when the first candidate is right;
 * the probe is skipped entirely only when the binding has a single candidate
 * AND that candidate is the workspace-root spelling (the common, healthy
 * case) — see the caller for the fallback search when every probe misses.
 *
 * @returns the chosen remote path, or `undefined` when none exists.
 */
async function firstExisting(
  alias: string,
  candidates: readonly string[],
): Promise<string | undefined> {
  for (const candidate of candidates) {
    const exists = await withDeadline(api.fileOp.stat(alias, candidate), EXIST_PROBE_MS).then(
      () => true,
      () => false,
    )
    if (exists === true) return candidate
  }
  return undefined
}

/**
 * Last-resort lookup for a clicked PROJECT-relative path (the model `cd`ed
 * inside individual shell commands, so the session cwd never moved): search
 * the binding's remote tree for a unique file whose path ends with the
 * clicked spelling. Only issued after every direct candidate missed.
 */
async function searchSuffix(binding: RemoteOpenBinding, relative: string): Promise<string | undefined> {
  const command = suffixFindCommand(binding.remotePath, relative)
  if (command === undefined) return undefined
  const result = await withDeadline(api.exec(binding.alias, command, 6_000), 7_000).catch(() => undefined)
  if (result === undefined) return undefined
  return uniqueSuffixMatch(binding.remotePath, relative, result.stdout)
}

/** Open one resolved click; returns false when it must stay native. */
function interceptSync(ctx: Context, parsed: ParsedFileAddress, address: string, options: unknown): boolean {
  const table = remoteOpenBindings()
  if (table.bindings.length === 0) return false
  const line = lineOf(options)

  if (parsed.scope === 'absolute') {
    const target = resolveRemoteOpenTarget({ address, table })
    if (target === undefined) return false
    return openRemoteFileInBinding(target.binding.id, target.candidates[0], line === undefined ? {} : { line })
  }

  const sessionWorkspacePath = workspacePathOf(ctx, parsed.sessionId)
  if (sessionWorkspacePath === undefined) return false
  const baseTarget = resolveRemoteOpenTarget({ address, table, sessionWorkspacePath })
  if (baseTarget === undefined) return false

  // The spelling the model used, normalized for the fallback search (only a
  // plain relative path can be searched for by suffix).
  const rawPath = parsed.path.replace(/\\/g, '/')
  const relative = rawPath.startsWith('/') || /^[A-Za-z]:\//.test(rawPath) || rawPath.startsWith('//')
    ? undefined
    : rawPath.replace(/^(?:\.\/)+/, '')

  // Fire-and-forget: the session-cwd probe only ever ADDS a candidate.
  void (async () => {
    let target = baseTarget
    try {
      const probe = await withDeadline(api.sessionCwd(parsed.sessionId), CWD_PROBE_MS)
      const cwd = probe?.cwd
      if (typeof cwd === 'string' && cwd !== '') {
        target = resolveRemoteOpenTarget({ address, table, sessionWorkspacePath, sessionCwd: cwd }) ?? baseTarget
      }
    } catch {
      // Keep the workspace-root target.
    }
    const open = (remotePath: string): void => {
      openRemoteFileInBinding(target.binding.id, remotePath, line === undefined ? {} : { line })
    }
    const existing = await firstExisting(target.binding.alias, target.candidates)
    if (existing !== undefined) {
      open(existing)
      return
    }
    // Nothing at the direct spellings: the model may have quoted a
    // project-relative path (its `cd` lived inside shell commands only).
    if (relative !== undefined) {
      const found = await searchSuffix(target.binding, relative)
      if (found !== undefined) {
        open(found)
        return
      }
    }
    // Still nothing: open the primary spelling so the editor shows the remote
    // read error (named against the remote workspace, not the empty alias).
    open(target.candidates[0])
  })().catch((error: unknown) => {
    // The editor open itself failed: keep the click a no-op rather than
    // surfacing an exception inside another plugin's service call, but say so
    // in the console (`[dsh-remote-vs]`) so a field report is diagnosable.
    console.warn('[dsh-remote-vs] remote file click could not open the remote editor:', error)
  })
  return true
}

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
export function installRemoteFileOpen(ctx: Context): () => void {
  let disposed = false
  let timer: ReturnType<typeof setInterval> | undefined

  const stopTimer = (): void => {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }

  const attempt = (): boolean => {
    if (disposed) return true
    let service: object | undefined
    try {
      service = (ctx as unknown as { get(name: string): unknown }).get('sidebarRight') as object | undefined
    } catch {
      return false
    }
    if (service === undefined) return false
    const side = service as SidebarRightLike
    if (typeof side.openResource !== 'function') return false
    if (originals.has(service)) {
      stopTimer()
      return true
    }
    const original = side.openResource.bind(side)
    const wrapper = (address: string, options?: unknown): unknown => {
      try {
        // Cheap, synchronous gate first: only a file address of a session in
        // one of our bindings is intercepted. Everything else keeps the native
        // call (and its synchronous throw semantics) untouched.
        if (!isEditorCentered()) return original(address, options)
        const parsed = parseFileAddress(address)
        if (parsed === undefined) return original(address, options)
        return interceptSync(ctx, parsed, address, options) === true ? undefined : original(address, options)
      } catch {
        return original(address, options)
      }
    }
    try {
      side.openResource = wrapper
      originals.set(service, original)
    } catch {
      return false
    }
    stopTimer()
    return true
  }

  if (!attempt()) {
    timer = setInterval(() => { if (attempt()) stopTimer() }, 500)
    timer.unref?.()
  }

  return (): void => {
    disposed = true
    stopTimer()
    let service: object | undefined
    try {
      service = (ctx as unknown as { get(name: string): unknown }).get('sidebarRight') as object | undefined
    } catch {
      service = undefined
    }
    if (service === undefined) return
    const original = originals.get(service)
    if (original === undefined) return
    try {
      ;(service as SidebarRightLike).openResource = original
    } catch {
      // Ignore: the service is being torn down.
    }
    originals.delete(service)
  }
}
