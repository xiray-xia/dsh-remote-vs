/**
 * Host Client-Remote access for document previews.
 *
 * The reference local-workbench implementation reads bytes through
 * `remote.workspaceFiles.readBytes` and converts Office through
 * `remote.officeKit.render`. dsh-remote-vs replaces the global `fs` with a
 * transparent RouterFs, so those services can route a remote session's
 * workspace; this module keeps them as SOFT services (ctx.get) and reports
 * `unavailable` when a profile does not mount them.
 */
import type { Context } from '@deepseek-ai/cordis'

export type PreviewFailureReason = 'unavailable' | 'too-large' | 'not-found' | 'remote' | 'failed'

export type PreviewBytesResult =
  | { ok: true; data: Uint8Array; size: number }
  | { ok: false; reason: PreviewFailureReason; detail: string }

type RemoteCallResult =
  | { ok: true; value: { data: Uint8Array; bytes?: number } }
  | { ok: false; error: { code?: unknown; message?: unknown; details?: unknown } }

interface WorkspaceFilesRemote {
  readBytes?: (sessionId: string, path: string, options: Record<string, unknown>, signal?: AbortSignal) => Promise<RemoteCallResult>
}

interface OfficeKitRemote {
  render?: (sessionId: string, path: string, priority: 'foreground' | 'background', signal?: AbortSignal) => Promise<RemoteCallResult>
}

let rootCtx: Context | undefined

export function installPreviewServices(ctx: Context): () => void {
  rootCtx = ctx
  return () => {
    if (rootCtx === ctx) rootCtx = undefined
  }
}

function remoteNamespace(name: string): Record<string, unknown> | undefined {
  const ctx = rootCtx
  if (ctx === undefined) return undefined
  try {
    const raw: unknown = (ctx as unknown as { get(service: string): unknown }).get(name)
    return typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function failureReason(code: string, reason?: string): PreviewFailureReason {
  const lowered = `${code} ${reason ?? ''}`.toLowerCase()
  if (lowered.includes('too-large') || lowered.includes('too_large')) return 'too-large'
  if (lowered.includes('workspace-file/not-found') || lowered.includes('not-regular-file')) return 'not-found'
  if (lowered.includes('unavailable') || lowered.includes('missing')) return 'unavailable'
  return 'failed'
}

function toBytesResult(outcome: RemoteCallResult | undefined, fallbackDetail: string): PreviewBytesResult {
  if (outcome === undefined) return { ok: false, reason: 'unavailable', detail: fallbackDetail }
  if (outcome.ok) {
    const data = outcome.value.data
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
      return { ok: false, reason: 'failed', detail: 'empty payload' }
    }
    return { ok: true, data, size: typeof outcome.value.bytes === 'number' ? outcome.value.bytes : data.byteLength }
  }
  const code = typeof outcome.error.code === 'string' ? outcome.error.code : ''
  const message = typeof outcome.error.message === 'string' ? outcome.error.message : ''
  const details = outcome.error.details
  const reason = typeof details === 'object' && details !== null
    && typeof (details as { reason?: unknown }).reason === 'string'
    ? (details as { reason: string }).reason
    : undefined
  return {
    ok: false,
    reason: failureReason(code, reason),
    detail: [code, reason, message].filter(part => typeof part === 'string' && part !== '').join(': '),
  }
}

export async function readWorkspaceBytes(
  sessionId: string,
  path: string,
  signal?: AbortSignal,
): Promise<PreviewBytesResult> {
  if (sessionId === '') return { ok: false, reason: 'unavailable', detail: 'no session' }
  const service = remoteNamespace('remote.workspaceFiles') as WorkspaceFilesRemote | undefined
  if (typeof service?.readBytes !== 'function') {
    return { ok: false, reason: 'unavailable', detail: 'remote.workspaceFiles is not mounted' }
  }
  let outcome: RemoteCallResult
  try {
    outcome = await service.readBytes(sessionId, path, {}, signal)
  } catch (error) {
    return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
  return toBytesResult(outcome, 'remote.workspaceFiles is not mounted')
}

export async function renderOfficePdf(
  sessionId: string,
  path: string,
  signal?: AbortSignal,
): Promise<PreviewBytesResult> {
  if (sessionId === '') return { ok: false, reason: 'unavailable', detail: 'no session' }
  const service = remoteNamespace('remote.officeKit') as OfficeKitRemote | undefined
  if (typeof service?.render !== 'function') {
    return { ok: false, reason: 'unavailable', detail: 'remote.officeKit is not mounted' }
  }
  let outcome: RemoteCallResult
  try {
    outcome = await service.render(sessionId, path, 'foreground', signal)
  } catch (error) {
    return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
  return toBytesResult(outcome, 'remote.officeKit is not mounted')
}
