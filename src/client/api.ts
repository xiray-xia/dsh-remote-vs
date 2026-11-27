/**
 * Typed fetch wrapper over the /api/dsh-remote JSON API (full P0 surface).
 */
import {
  REMOTE_API,
  type ExecStreamEvent,
  type GitBranch,
  type GitCommit,
  type GitShow,
  type GitStatus,
  type HelperAvailability,
  type ImportReport,
  type RemoteChangesDiff,
  type RemoteChangesListRequest,
  type RemoteChangesSummary,
  type RemoteConnectionStatus,
  type RemoteDeployState,
  type RemoteExecResult,
  type RemoteFileEntry,
  type RemoteForwardRequest,
  type RemoteForwardState,
  type RemoteHostProxySetting,
  type RemoteHostSummary,
  type RemoteListenPortsResult,
  type RemoteMetricsResult,
  type RemoteProcessKillResult,
  type RemoteProcessesResult,
  type RemotePluginMeta,
  type RemoteProbe,
  type RemoteProxySettingsPatch,
  type RemoteProxySettingsView,
  type RemoteRead,
  type RemoteRoutingStatus,
  type RemoteTimeouts,
  type RemoteViewSettings,
  type RemoteWorkspaceBinding,
  type RemoteWriteConflict,
  type RemoteWriteResult,
} from '../protocol.ts'
import { DEFAULT_TIMEOUTS, normalizeTimeouts, timeoutSeconds } from '../timeouts.ts'
import { activeConnectionAlias, currentConnection, isConnectionFailure, noteConnectionFailure } from './connection.ts'
import { detectLang, makeT } from './i18n.ts'
import { dispatchHostNotices } from './notices.ts'
import { parseSseFrame, takeSseFrames } from './exec-output.ts'
import { requestGate } from './request-gate.ts'
import {
  branchesCommand,
  gitFailed,
  logCommand,
  messageCommand,
  parseBranches,
  parseLog,
  parseShow,
  parseStatus,
  statCommand,
  statusCommand,
} from '../git-format.ts'

export class RemoteApiError extends Error {
  /**
   * The request failed because the SSH link did, not because the remote said no.
   *
   * Carried as a flag because the message can be REWRITTEN to a localized
   * sentence for repeat failures; classification must survive that rewrite so
   * callers (toast quieting, offline banners) keep treating it as transport.
   */
  transport?: boolean
  /**
   * The operation ran out of its budget; the link itself was not proven bad.
   *
   * Set from the Host's `code: 'deadline'`. It keeps classification honest: one
   * slow request (a huge directory, an 8 MiB read on a thin link) must not flip
   * the chip to "connection error" or downgrade the editor to read-only, while
   * the operation still fails for the user with its readable reason.
   */
  deadline?: boolean
  /**
   * The remote file moved on since the version this buffer was based on.
   *
   * Carried as DATA, not prose: the editor has to offer overwrite / reload /
   * see-the-difference, and that needs what is there now (`mtime`, `size`)
   * without another round trip. The status is 409 for exactly this case — a
   * plain 502 would read as "the host failed", which is the opposite of what
   * happened (the Host successfully protected the file).
   */
  conflict?: RemoteWriteConflict
  /**
   * The Host's own words, kept when the message was rewritten for the user.
   *
   * Today only the loopback fence's `403 forbidden: loopback-only` takes this
   * path (see `loopbackFenceMessage`): the readable sentence explains what to do,
   * while this keeps the exact server string for diagnostics and logs.
   */
  detail?: string
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * The readable form of the loopback fence's refusal (audit S-34).
 *
 * Every `/api/dsh-remote/*` route refuses a request that is not loopback +
 * same-origin with `403 {error: 'forbidden: loopback-only'}`. That is the
 * security model working, not a fault — but through a remote Web UI
 * (`ds-harness-remote`, a tunnel) the whole plugin answers 403 and the raw
 * phrase told the user nothing. The plugin cannot relax the fence (and must
 * not), so it says what happened instead.
 *
 * Kept HERE rather than in `i18n.ts` only because that file was outside this
 * round's write scope; the pair should move into the dictionaries the next time
 * it is touched.
 */
const REMOTE_ACCESS_DENIED: Record<'zh' | 'en', string> = {
  zh: '插件 API 仅限本机访问：通过远程 Web UI（中继 / 隧道）打开 DSH 时该功能不可用，请在本机浏览器中打开 DSH。',
  en: 'The plugin API is only reachable from this machine: it is unavailable when DSH is opened through a remote Web UI (relay / tunnel). Open DSH locally instead.',
}

/**
 * Localize `403 forbidden: loopback-only`, or answer undefined for everything
 * else (the caller then keeps the server's own text).
 */
function loopbackFenceMessage(status: number, rawError: string | undefined): string | undefined {
  if (status !== 403 || rawError !== 'forbidden: loopback-only') return undefined
  return REMOTE_ACCESS_DENIED[detectLang()]
}

/**
 * Validate a 409 payload before believing it is a save conflict.
 *
 * A conflict the client cannot read (an older Host, a proxy that rewrote the
 * body) must fall back to the generic error path rather than produce a
 * half-populated prompt.
 */
function isWriteConflict(value: unknown): value is RemoteWriteConflict {
  if (typeof value !== 'object' || value === null) return false
  const shape = value as { mtime?: unknown; size?: unknown }
  const measured = (field: unknown): boolean => field === null || (typeof field === 'number' && Number.isFinite(field))
  return measured(shape.mtime) && measured(shape.size)
}

/**
 * Per-request scheduling options (the channel lives in `request-gate.ts`).
 *
 * Every call site that does NOT pass them keeps the pre-gate behaviour: a
 * foreground request that starts immediately and never waits.
 */
export interface RequestOptions {
  /**
   * Run this request on the BACKGROUND channel.
   *
   * Only repository-wide git walks use it (see `scm/actions.ts`): they can take
   * minutes on a large tree, and a workspace switch must not make the directory
   * listing queue behind them for a connection. Background requests start only
   * while no foreground request is in flight, one at a time.
   */
  background?: boolean
  /**
   * Cancels the request: a queued background entry leaves the queue, and a
   * request that already started is aborted at the fetch.
   */
  signal?: AbortSignal
}

async function call<T>(path: string, init?: RequestInit, opts?: RequestOptions): Promise<T> {
  // The signal both takes a queued background request out and cancels the fetch
  // itself; an `init.signal` from the caller counts the same way when no
  // explicit one is given.
  const signal = opts?.signal ?? init?.signal ?? undefined
  const send = (): Promise<Response> => fetch(path, {
    ...init,
    ...(signal === undefined ? {} : { signal }),
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const res = opts?.background === true
    ? await requestGate.runBackground(send, signal)
    : await requestGate.runForeground(send)
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    // Fall through to the status check with a generic message.
  }
  if (!res.ok) {
    const body = typeof data === 'object' && data !== null
      ? data as { error?: unknown; code?: unknown; conflict?: unknown }
      : undefined
    const rawMessage = typeof body?.error === 'string' ? body.error : `request failed: HTTP ${res.status}`
    // S-34: the one refusal that is the security fence, not a failure.
    const fenced = loopbackFenceMessage(res.status, typeof body?.error === 'string' ? body.error : undefined)
    const message = fenced ?? rawMessage
    const failure = new RemoteApiError(res.status, message)
    if (fenced !== undefined) {
      failure.detail = rawMessage
      console.debug('[dsh-remote-vs] remote access refused by the loopback fence:', rawMessage)
    }
    if (body?.code === 'deadline') failure.deadline = true
    // A refused save is not a link failure: keep its payload so the caller can
    // ask the user what to do with the current version.
    if (body?.code === 'conflict' && isWriteConflict(body.conflict)) failure.conflict = body.conflict
    // Classify the ERROR (not its text): the deadline flag has to be seen here,
    // or a slow request is mistaken for a dead link.
    if (isConnectionFailure(failure)) {
      failure.transport = true
      // Was the link already known to be down? The FIRST failure keeps its raw
      // diagnostic (that is how the user learns WHY); every later failure is a
      // repeat — the chip already explains it, so surfaces get one short
      // sentence instead of another ssh2 string. The raw text stays on the
      // console for anyone debugging the host.
      const repeat = currentConnection()?.state === 'error'
      noteConnectionFailure(activeConnectionAlias(), failure)
      if (repeat) {
        console.debug('[dsh-remote-vs] transport error:', message)
        // Translated at throw time (not module load): the message follows the
        // language the page is in when the failure happens.
        const localized = new RemoteApiError(res.status, makeT(detectLang())('connection.actionFailed'))
        localized.transport = true
        throw localized
      }
      throw failure
    }
    throw failure
  }
  // One-shot Host notices (an automatic helper push that THIS request
  // triggered) ride the response; render them here so the surface that needed
  // the helper reports it without the user opening Settings.
  dispatchHostNotices(data)
  return data as T
}

function post<T>(path: string, body: unknown, opts?: RequestOptions): Promise<T> {
  return call<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }, opts)
}

/** Raise a friendly git error for a failed exec result. */
function throwIfGitFailed(r: RemoteExecResult, timeoutMs: number): void {
  if (r.success) return
  if (r.timedOut) {
    const timedOut = new RemoteApiError(502, `git timed out after ${timeoutSeconds(timeoutMs)} (big/slow repo — retry, it may be warm now; raise gitTimeoutMs in the plugin settings)`)
    // A command budget, not a link failure (the exec route reports a timeout as
    // a result, never as a transport error).
    timedOut.deadline = true
    throw timedOut
  }
  const friendly = gitFailed(r.stderr)
  throw new RemoteApiError(502, friendly ?? (r.stderr.trim() || r.error || `git failed [exit code: ${r.exitCode}]`))
}

/** Query for one remote terminal socket. */
export interface TerminalSocketQuery {
  alias?: string
  session?: string
  cols: number
  rows: number
}

/**
 * Origin the remote terminal socket dials.
 *
 * `dsh web` serves the app from the Host itself, so `location` already names the
 * Host. DSH Desktop serves the app from `dsh-app://app` and forwards HTTP to its
 * own loopback Host, publishing that Host's origin as
 * `__DSH_TRANSPORT__.streamBaseUrl` (the shell also attaches the Host cookie to
 * `ws://127.0.0.1/*` handshakes). Prefer a published origin; without one keep
 * the page origin, which is exactly the pre-Desktop behaviour.
 */
export function terminalSocketBase(): string {
  const transport = (globalThis as unknown as { __DSH_TRANSPORT__?: { streamBaseUrl?: unknown } }).__DSH_TRANSPORT__
  const published = transport?.streamBaseUrl
  if (typeof published === 'string' && /^https?:\/\//i.test(published)) return published
  return `${location.protocol}//${location.host}`
}

/** Absolute socket URL for one remote terminal, resolved against `base`. */
export function terminalSocketUrl(params: TerminalSocketQuery, base = terminalSocketBase()): string {
  const url = new URL(REMOTE_API.terminal, base)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  if (params.alias !== undefined) url.searchParams.set('alias', params.alias)
  if (params.session !== undefined) url.searchParams.set('session', params.session)
  url.searchParams.set('cols', String(params.cols))
  url.searchParams.set('rows', String(params.rows))
  return url.toString()
}

/**
 * Effective remote timeouts (see `src/timeouts.ts`).
 *
 * Module state on purpose: the numbers come from the Host's workspaces answer
 * (a `volatile()` config edit) and every git/read call site reads them at call
 * time, so a settings change applies to the next command without any remount.
 * Before the first answer — or against an older Host that omits the field —
 * the shared defaults stand, and they are the RAISED ones, so a big repository
 * no longer dies at the old 45 s client deadline.
 */
let effectiveTimeouts: RemoteTimeouts = DEFAULT_TIMEOUTS

/** Apply the Host-provided pair (clamped; a malformed answer keeps defaults). */
export function configureTimeouts(value: unknown): RemoteTimeouts {
  effectiveTimeouts = normalizeTimeouts(value)
  return effectiveTimeouts
}

/** Current per-git-command timeout in milliseconds. */
export function gitTimeoutMs(): number {
  return effectiveTimeouts.gitMs
}

/** Current per-file-read timeout in milliseconds. */
export function fileReadTimeoutMs(): number {
  return effectiveTimeouts.readMs
}

/** Progress of one upload, in bytes as the browser reports them. */
export interface UploadProgress {
  loaded: number
  total: number
}

/**
 * Upload one file's bytes to an absolute remote path.
 *
 * XHR rather than `fetch`: only XHR reports UPLOAD progress, and a drag & drop
 * of a large file with no feedback is indistinguishable from a hang (the same
 * lesson the git timeouts taught). The body is the raw bytes — the host route
 * streams them into SFTP, so neither side buffers the whole file.
 *
 * @param options.alias - host alias.
 * @param options.path - absolute remote destination path.
 * @param options.blob - the file to send.
 * @param options.overwrite - replace an existing file (the route answers 409
 *   with `status === 409` otherwise, which the caller resolves per batch).
 * @param options.signal - cancels the transfer.
 * @param options.onProgress - called as the browser flushes body bytes.
 * @returns the byte count the host wrote.
 */
export function uploadFile(options: {
  alias: string
  path: string
  blob: Blob
  overwrite?: boolean
  signal?: AbortSignal
  onProgress?: (progress: UploadProgress) => void
}): Promise<{ size: number }> {
  return new Promise<{ size: number }>((resolve, reject) => {
    const query = new URLSearchParams({ alias: options.alias, path: options.path })
    if (options.overwrite === true) query.set('overwrite', '1')
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${REMOTE_API.upload}?${query.toString()}`)
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        reject(new RemoteApiError(0, 'upload cancelled'))
        return
      }
      options.signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }
    if (options.onProgress !== undefined) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) options.onProgress?.({ loaded: event.loaded, total: event.total })
      }
    }
    xhr.onload = () => {
      let body: unknown = null
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        // Keep the status-based message below.
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        // The bytes are on the remote host now: the quick-open index is stale.
        noteRemoteWrite()
        const size = typeof body === 'object' && body !== null && typeof (body as { size?: unknown }).size === 'number'
          ? (body as { size: number }).size
          : options.blob.size
        resolve({ size })
        return
      }
      const rawError = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : undefined
      // Same fence, same readable answer as the JSON path above (S-34).
      const fenced = loopbackFenceMessage(xhr.status, rawError)
      const failure = new RemoteApiError(xhr.status, fenced ?? (rawError ?? `upload failed: HTTP ${xhr.status}`))
      if (fenced !== undefined) {
        failure.detail = rawError
        console.debug('[dsh-remote-vs] remote access refused by the loopback fence:', rawError)
      }
      reject(failure)
    }
    xhr.onerror = () => reject(new RemoteApiError(0, 'upload failed: connection error'))
    xhr.onabort = () => reject(new RemoteApiError(0, 'upload cancelled'))
    xhr.send(options.blob)
  })
}

export interface HostForm {
  alias: string
  host: string
  port: number
  user: string
  auth: { kind: 'key' | 'password'; keyPath?: string; passphrase?: string; password?: string }
  description?: string
  tags?: string[]
  /**
   * How this host reaches the network (see `RemoteHostProxySetting`).
   *
   * Absent means "no opinion": a create then keeps the profile default, and an
   * update keeps whatever the host already had — which is what makes the field
   * backward compatible with a Host that never heard of it.
   */
  proxy?: RemoteHostProxySetting
}

export interface PushReportView {
  alias: string
  probe: RemoteProbe
  action: 'pushed' | 'skipped-same' | 'failed'
  detail: string
}

/**
 * How many remote WRITES this client session has issued.
 *
 * The quick-open file index is memory-only, so it has no filesystem watcher to
 * tell it the tree changed; a write is the only signal there is. A counter is
 * the smallest possible coupling: the writer does not know who caches, and a
 * reader compares the number it saw when it built (see `quickopen-model.ts`) — a
 * mismatch means rebuild.
 *
 * Bumped when the write actually LANDED (a rejected or conflicted write changed
 * nothing and must not cost a rebuild), which is why the call sites sit on the
 * success path.
 *
 * What bumps it:
 * - the panel's own file writes: `fileOp.write/mkdir/rm/rename` and uploads;
 * - the SCM verbs that change the WORKING TREE, detected in {@link execChangesWorktree}
 *   because those commands are built and issued outside this module
 *   (`scm/actions.ts`): discard (`restore` / `clean -fd`, which deletes untracked
 *   files), branch switches (`checkout` / `switch`), `reset`, `stash apply|pop`,
 *   patch/merge verbs and `pull`.
 *
 * Known boundary (deliberate, not an oversight): writes that do not come through
 * either of those paths — a command typed in the remote terminal, or one the
 * model runs through its own tooling — are invisible here. They are picked up on
 * the next panel write, the next SCM worktree verb, or a page reload.
 */
let remoteWriteSeq = 0

/** Record one landed remote write (see {@link remoteWriteSequence}). */
export function noteRemoteWrite(): void {
  remoteWriteSeq += 1
}

/** The counter a cached listing must match to still be considered fresh. */
export function remoteWriteSequence(): number {
  return remoteWriteSeq
}

/**
 * Git verbs that change the WORKING TREE, so a file index built before them may
 * list paths that no longer exist (or miss ones that now do).
 *
 * Deliberately narrow, and it reads the INDEX-ONLY variants out on purpose:
 * - `restore --staged` (unstage) and `apply --cached` (stage a hunk) touch the
 *   index only, so the file set is unchanged — invalidating on those would
 *   rebuild the index after every stage click;
 * - `stash drop` and `git branch -d` leave the worktree alone;
 * - read verbs (`status`, `log`, `diff`, `show`, `rev-parse`, `stash list`,
 *   `ls-files`, …) run constantly.
 * What DOES invalidate: discards (`restore`/`clean -fd`, which deletes untracked
 * files), branch switches (`checkout`/`switch`), `reset`, `stash` apply/pop and
 * `stash push`/`save`, patch/merge verbs (`apply` without `--cached`, `am`,
 * `merge`, `rebase`, `cherry-pick`, `revert`) and `pull`.
 */
const WORKTREE_WRITE_COMMAND =
  /\bgit\b[^\n]*?\s(?:restore(?!\s+--staged)|clean|checkout|switch|reset|merge|rebase|cherry-pick|revert|pull|am|apply(?!\s+--(?:cached|index))|stash\s+(?:apply|pop|push|save))\b/

/**
 * Does this remote command change the working tree?
 *
 * Exported so the gate can drive it directly: the SCM verbs do not pass through
 * `api.fileOp`, so this predicate is the only thing that makes discard/checkout/
 * stash invalidate the quick-open index at all.
 */
export function execChangesWorktree(command: string): boolean {
  return WORKTREE_WRITE_COMMAND.test(command)
}

/** Bump the counter for one landed command that changed the working tree. */
function afterRemoteCommand(command: string): void {
  if (execChangesWorktree(command)) noteRemoteWrite()
}

/** Promise helper: bump the counter when a write request resolved. */
function afterRemoteWrite<T>(value: T): T {
  noteRemoteWrite()
  return value
}

export const api = {
  // -- hosts
  getHosts: () => call<{ hosts: RemoteHostSummary[] }>(REMOTE_API.hosts).then(r => r.hosts),
  createHost: (payload: HostForm) =>
    call<{ host: RemoteHostSummary }>(REMOTE_API.hosts, { method: 'POST', body: JSON.stringify(payload) }).then(r => r.host),
  updateHost: (alias: string, patch: Partial<HostForm>) =>
    call<{ host: RemoteHostSummary }>(`${REMOTE_API.hosts}?alias=${encodeURIComponent(alias)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }).then(r => r.host),
  deleteHost: (alias: string) =>
    call<{ ok: boolean }>(`${REMOTE_API.hosts}?alias=${encodeURIComponent(alias)}`, { method: 'DELETE' }),
  testHost: (alias: string, opts?: RequestOptions) =>
    post<{ ok: boolean; error?: string; durationMs: number }>(REMOTE_API.test, { alias }, opts),
  /** Per-alias SSH connection health (Host pool's view; this is a local poll). */
  connectionStatus: () => call<{ connections: RemoteConnectionStatus[] }>(REMOTE_API.status).then(r => r.connections),
  bootstrap: (alias: string) => post<{ alias: string; keyPath: string; flipped: boolean; detail: string }>(REMOTE_API.keygen, { alias }),
  // -- files
  fileOp: {
    list: (alias: string, path: string) =>
      post<{ entries: RemoteFileEntry[] }>(REMOTE_API.files, { op: 'list', alias, path }).then(r => r.entries),
    stat: (alias: string, path: string) =>
      post<{ entry: RemoteFileEntry }>(REMOTE_API.files, { op: 'stat', alias, path }).then(r => r.entry),
    read: (alias: string, path: string) => post<RemoteRead>(REMOTE_API.files, { op: 'read', alias, path }),
    /**
     * Write one file, optionally guarded by the version it was based on.
     *
     * `guard` is the save-conflict lock: the Host refuses (409, `code:
     * 'conflict'`) when the remote file no longer matches, and the caller gets a
     * `RemoteApiError` carrying `conflict`. Omitting it keeps the old
     * unconditional write, which is what every programmatic caller wants.
     */
    write: (alias: string, path: string, content: string, guard?: { expectMtime?: number; expectSize?: number }) =>
      post<RemoteWriteResult>(REMOTE_API.files, {
        op: 'write',
        alias,
        path,
        content,
        encoding: 'utf8',
        ...(guard ?? {}),
      }).then(afterRemoteWrite),
    mkdir: (alias: string, path: string) =>
      post<{ ok: boolean }>(REMOTE_API.files, { op: 'mkdir', alias, path }).then(afterRemoteWrite),
    rm: (alias: string, path: string, recursive: boolean) =>
      post<{ ok: boolean }>(REMOTE_API.files, { op: 'rm', alias, path, recursive }).then(afterRemoteWrite),
    rename: (alias: string, from: string, to: string) =>
      post<{ ok: boolean }>(REMOTE_API.files, { op: 'rename', alias, from, to }).then(afterRemoteWrite),
  },
  // -- exec
  /**
   * One remote command (`/exec`), foreground unless `opts.background` asks for
   * the git channel. Reads the SCM panel builds stay foreground; the
   * repository-wide walks pass `{ background: true }` (see `scm/actions.ts`).
   */
  exec: (alias: string, command: string, timeoutMs?: number, opts?: RequestOptions) =>
    post<RemoteExecResult>(REMOTE_API.exec, timeoutMs === undefined ? { alias, command } : { alias, command, timeoutMs }, opts)
      .then((result) => {
        // A worktree-changing git verb (discard / checkout / stash apply …) runs
        // through here rather than `fileOp`, so it is the one place an index
        // cache can learn about it (see `execChangesWorktree`).
        if (result.success) afterRemoteCommand(command)
        return result
      }),
  /**
   * Streaming exec: the network verbs' live log.
   *
   * The route answers as SSE frames; `onData` receives decoded text while the
   * command runs, and the promise settles on the `exit` frame. An aborted
   * `signal` cancels the remote process group on the host side (the route acts
   * on the closed response), so a cancel button can actually stop a push.
   */
  execStream: async (
    alias: string,
    command: string,
    timeoutMs: number,
    handlers: { onData?: (stream: 'out' | 'err', text: string) => void; signal?: AbortSignal },
  ): Promise<RemoteExecResult> => {
    // A USER-initiated verb (fetch/pull/push, its own live panel), so it is
    // foreground — but only the RESPONSE ESTABLISHMENT is claimed: the SSE body
    // streams for minutes, and holding the foreground counter for that long
    // would starve every background git read (and make the panel's own refresh
    // wait for itself).
    const response = await requestGate.runForeground(() => fetch(REMOTE_API.execStream, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias, command, timeoutMs }),
      ...(handlers.signal === undefined ? {} : { signal: handlers.signal }),
    }))
    if (!response.ok || response.body === null) {
      let message = `request failed: HTTP ${response.status}`
      try {
        const data = await response.json() as { error?: unknown }
        if (typeof data.error === 'string') message = data.error
      } catch {
        // Keep the status-based message.
      }
      throw new RemoteApiError(response.status, message)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let exit: Extract<ExecStreamEvent, { t: 'exit' }> | undefined
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const { frames, rest } = takeSseFrames(buffer)
      buffer = rest
      for (const frame of frames) {
        const payload = parseSseFrame(frame)
        if (payload === null || typeof payload !== 'object') continue
        const event = payload as ExecStreamEvent
        if (event.t === 'out' || event.t === 'err') handlers.onData?.(event.t, event.d)
        else if (event.t === 'exit') exit = event
      }
    }
    if (exit === undefined) throw new RemoteApiError(502, 'stream ended without an exit frame')
    // The streaming path carries `pull`/`sync`, which merge into the worktree:
    // same invalidation as the unary path above.
    if (exit.success) afterRemoteCommand(command)
    return {
      success: exit.success,
      exitCode: exit.exitCode,
      timedOut: exit.timedOut,
      stdout: '',
      stderr: '',
      durationMs: exit.durationMs,
      ...(exit.error === undefined ? {} : { error: exit.error }),
    }
  },
  // -- workspaces
  getWorkspaces: () => call<{ workspaces: RemoteWorkspaceBinding[] } & RemoteRoutingStatus & RemotePluginMeta>(REMOTE_API.workspaces),
  createWorkspace: (payload: { name: string; alias: string; remotePath: string }) =>
    call<{ workspace: RemoteWorkspaceBinding; aliasPath: string }>(REMOTE_API.workspaces, { method: 'POST', body: JSON.stringify(payload) }),
  deleteWorkspace: (id: string) =>
    call<{ ok: boolean }>(`${REMOTE_API.workspaces}?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /**
   * Current working directory of one live session, for click resolution.
   *
   * A model quotes files relative to where it actually worked; the workspace
   * root alone misses that (see `remote-file-open-target.ts`). Unknown or
   * non-live sessions answer `undefined` and the caller keeps the root base.
   */
  sessionCwd: (sessionId: string) =>
    call<{ cwd?: string }>(REMOTE_API.sessionCwd, { method: 'POST', body: JSON.stringify({ sessionId }) }),
  /**
   * What one live session changed on its remote host.
   *
   * `list` is cheap — the host already holds the ledger — so the dock polls it;
   * `diff` costs one remote git run per file, so it is fetched only when a file
   * is opened for review.
   */
  changes: {
    /**
     * @param force - `⟳` semantics: tracked scan now AND re-arm the slow new-file
     *   walk (expensive; a deliberate click).
     * @param trackedOnly - "user came back to the page": tracked files now, but the
     *   slow walk keeps its cadence/write-off (see `RemoteChangesListRequest`).
     */
    list: (sessionId: string, force = false, repoSubdir = '', trackedOnly = false) => {
      const body: RemoteChangesListRequest = {
        op: 'list',
        sessionId,
        ...(force ? { force: true } : {}),
        ...(trackedOnly ? { trackedOnly: true } : {}),
        ...(repoSubdir === '' ? {} : { repoSubdir }),
      }
      return post<{ summary: RemoteChangesSummary | null }>(REMOTE_API.changes, body)
        .then(r => r.summary ?? null)
    },
    diff: (sessionId: string, path: string, repoSubdir = '') =>
      post<{ diff: RemoteChangesDiff | null }>(REMOTE_API.changes, {
        op: 'diff',
        sessionId,
        path,
        ...(repoSubdir === '' ? {} : { repoSubdir }),
      }).then(r => r.diff ?? null),
    /**
     * The same comparison, but against the previous completed turn's close
     * instead of the session baseline (the panel's 「本轮」 scope).
     *
     * Answers `unavailable` / `stale` (with a reason) instead of hunks when the
     * host has no cached per-turn contents or the file moved on after the turn —
     * the client must fall back to `diff` (session view) rather than paint lines
     * that no longer exist.
     */
    turnDiff: (sessionId: string, path: string, repoSubdir = '') =>
      post<{ diff: RemoteChangesDiff | null }>(REMOTE_API.changes, {
        op: 'turnDiff',
        sessionId,
        path,
        ...(repoSubdir === '' ? {} : { repoSubdir }),
      }).then(r => r.diff ?? null),
  },
  // -- routing mode (volatile, persists to the profile patch)
  setRoutingMode: (mode: 'off' | 'shadow' | 'enforce') =>
    post<{ mode: 'off' | 'shadow' | 'enforce' }>(REMOTE_API.routing, { mode }).then((r) => r.mode),
  // -- view preferences (auto-open remote page + its width share)
  getViewSettings: () =>
    call<{ settings: RemoteViewSettings }>(REMOTE_API.viewSettings).then((r) => r.settings),
  /** Flat patch: unknown keys are ignored, unusable values keep the stored one. */
  setViewSettings: (patch: Partial<RemoteViewSettings>) =>
    post<{ settings: RemoteViewSettings }>(REMOTE_API.viewSettings, patch).then((r) => r.settings),
  // -- profile-wide egress default (per-host overrides live on the host rows)
  /**
   * The default egress every `mode: 'inherit'` host follows.
   *
   * Answers the DEFAULTS on a fresh profile (`direct`), and a Host too old to
   * know the route answers 404 — callers treat that as "direct" and keep the
   * per-host form working (see `proxySummary`).
   */
  getProxySettings: () =>
    call<{ settings: RemoteProxySettingsView }>(REMOTE_API.proxySettings).then((r) => r.settings),
  /**
   * Patch the default egress.
   *
   * `target: null` clears the stored endpoint; omitting it keeps the stored one
   * (so flipping to `direct` and back does not lose the address), and an empty
   * password keeps the stored secret — the browser never sees it.
   */
  patchProxySettings: (patch: RemoteProxySettingsPatch) =>
    post<{ settings: RemoteProxySettingsView }>(REMOTE_API.proxySettings, patch).then((r) => r.settings),
  // -- deploy
  deployStatus: (alias: string) =>
    call<{ deploy: RemoteDeployState; helpers: HelperAvailability[] }>(
      `${REMOTE_API.deploy}?alias=${encodeURIComponent(alias)}&view=status`,
    ),
  deployProbe: (alias: string) =>
    call<RemoteProbe>(`${REMOTE_API.deploy}?alias=${encodeURIComponent(alias)}&view=probe`),
  deployPush: (alias: string) => post<PushReportView>(REMOTE_API.deploy, { alias }),
  // -- importers
  importSshConfig: () => post<ImportReport>(REMOTE_API.importSshConfig, {}),
  importDshSsh: () => post<ImportReport>(REMOTE_API.importDshSsh, {}),
  // -- terminal
  terminalClose: (id: string) => post<{ ok: boolean }>(REMOTE_API.terminalClose, { id }),
  // -- port forwards (the port panel's `ssh -L` tunnels)
  /**
   * Live forwards, narrowed to one host when an alias is given.
   *
   * A purely LOCAL read: the Host already holds the tunnels, so the panel can
   * poll this every few seconds without spending a single remote command.
   */
  forwards: (alias?: string) =>
    call<{ forwards: RemoteForwardState[] }>(
      alias === undefined || alias === ''
        ? REMOTE_API.forwards
        : `${REMOTE_API.forwards}?alias=${encodeURIComponent(alias)}`,
    ).then(r => r.forwards),
  /**
   * Open one forward.
   *
   * 400 = the request is not a valid rule, 409 = the local port is taken, 502 =
   * the tunnel could not be established (a refused `direct-tcpip` included) —
   * all three arrive as a `RemoteApiError` whose `message` is the Host's own
   * explanation, which is what the panel shows.
   */
  startForward: (request: RemoteForwardRequest) =>
    post<{ forward: RemoteForwardState }>(REMOTE_API.forwards, request).then(r => r.forward),
  /** Close one forward by its rule id. */
  stopForward: (id: string) =>
    call<{ ok: boolean }>(`${REMOTE_API.forwards}?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /**
   * One bounded probe of the remote host's listening TCP sockets.
   *
   * Costs one remote exec, so the panel asks rarely; `tool: 'none' | 'unknown'`
   * is an honest "cannot enumerate" answer and must not be rendered as "none
   * found" (see `RemoteListenPortsResult`).
   */
  listenPorts: (alias: string) =>
    call<RemoteListenPortsResult>(`${REMOTE_API.listenPorts}?alias=${encodeURIComponent(alias)}`),
  /** One bounded remote process table (per-host cache on the Host side). */
  processes: (alias: string, refresh = false) =>
    call<RemoteProcessesResult>(`${REMOTE_API.processes}?alias=${encodeURIComponent(alias)}${refresh ? '&refresh=1' : ''}`),
  /** Signal one PID from the latest snapshot; the route rejects unknown PIDs. */
  killProcess: (alias: string, pid: number, signal: 'TERM' | 'KILL') =>
    post<RemoteProcessKillResult>(REMOTE_API.processes, { alias, pid, signal }),
  /**
   * One host's live metrics sample.
   *
   * `refresh` bypasses the Host's few-second reuse window (manual refresh).
   * The route always answers one entry for `alias`; a host that disappeared
   * between the panel's host list and this call is a normal 404.
   */
  hostMetrics: (alias: string, refresh = false) =>
    call<RemoteMetricsResult>(
      `${REMOTE_API.metrics}?alias=${encodeURIComponent(alias)}${refresh ? '&refresh=1' : ''}`,
    ).then((result) => {
      const metrics = result.hosts.find(host => host.alias === alias) ?? result.hosts[0]
      if (metrics === undefined) throw new RemoteApiError(502, `no metrics for ${alias}`)
      return metrics
    }),
  // -- git (over the exec route; parsed in the browser, no host changes)
  // Timeouts come from the effective setting: status/log on a huge cold tree
  // routinely exceed the old fixed 120 s, and the client deadline used to cut
  // in even earlier (see timeouts.ts).
  git: {
    async status(alias: string, path: string): Promise<GitStatus> {
      const timeoutMs = gitTimeoutMs()
      const r = await post<RemoteExecResult>(REMOTE_API.exec, { alias, command: statusCommand(path), timeoutMs })
      throwIfGitFailed(r, timeoutMs)
      return parseStatus(r.stdout)
    },
    async log(alias: string, path: string, max: number, branch?: string): Promise<GitCommit[]> {
      const timeoutMs = gitTimeoutMs()
      const r = await post<RemoteExecResult>(REMOTE_API.exec, { alias, command: logCommand(path, max, branch), timeoutMs })
      throwIfGitFailed(r, timeoutMs)
      return parseLog(r.stdout)
    },
    async branches(alias: string, path: string, current: string): Promise<GitBranch[]> {
      const timeoutMs = gitTimeoutMs()
      const r = await post<RemoteExecResult>(REMOTE_API.exec, { alias, command: branchesCommand(path), timeoutMs })
      throwIfGitFailed(r, timeoutMs)
      return parseBranches(r.stdout, current)
    },
    async show(alias: string, path: string, ref: string): Promise<GitShow> {
      const timeoutMs = gitTimeoutMs()
      const [message, stat] = await Promise.all([
        post<RemoteExecResult>(REMOTE_API.exec, { alias, command: messageCommand(path, ref), timeoutMs }),
        post<RemoteExecResult>(REMOTE_API.exec, { alias, command: statCommand(path, ref), timeoutMs }),
      ])
      throwIfGitFailed(message, timeoutMs)
      throwIfGitFailed(stat, timeoutMs)
      return parseShow(ref, message.stdout, stat.stdout)
    },
  },
  // -- terminal socket URL (Desktop resolves it against its published Host origin)
  terminalUrl: (params: TerminalSocketQuery) => terminalSocketUrl(params),
}
