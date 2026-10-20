/**
 * Typed fetch wrapper over the /api/dsh-remote JSON API (full P0 surface).
 */
import {
  REMOTE_API,
  type GitBranch,
  type GitCommit,
  type GitShow,
  type GitStatus,
  type HelperAvailability,
  type ImportReport,
  type RemoteDeployState,
  type RemoteExecResult,
  type RemoteFileEntry,
  type RemoteHostSummary,
  type RemotePluginMeta,
  type RemoteProbe,
  type RemoteRead,
  type RemoteRoutingStatus,
  type RemoteTimeouts,
  type RemoteWorkspaceBinding,
} from '../protocol.ts'
import { DEFAULT_TIMEOUTS, normalizeTimeouts, timeoutSeconds } from '../timeouts.ts'
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
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    // Fall through to the status check with a generic message.
  }
  if (!res.ok) {
    const message = typeof data === 'object' && data !== null && 'error' in data && typeof (data as { error: unknown }).error === 'string'
      ? (data as { error: string }).error
      : `request failed: HTTP ${res.status}`
    throw new RemoteApiError(res.status, message)
  }
  return data as T
}

function post<T>(path: string, body: unknown): Promise<T> {
  return call<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
}

/** Raise a friendly git error for a failed exec result. */
function throwIfGitFailed(r: RemoteExecResult, timeoutMs: number): void {
  if (r.success) return
  if (r.timedOut) {
    throw new RemoteApiError(502, `git timed out after ${timeoutSeconds(timeoutMs)} (big/slow repo — retry, it may be warm now; raise gitTimeoutMs in the plugin settings)`)
  }
  const friendly = gitFailed(r.stderr)
  throw new RemoteApiError(502, friendly ?? (r.stderr.trim() || r.error || `git failed [exit code: ${r.exitCode}]`))
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
        const size = typeof body === 'object' && body !== null && typeof (body as { size?: unknown }).size === 'number'
          ? (body as { size: number }).size
          : options.blob.size
        resolve({ size })
        return
      }
      const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `upload failed: HTTP ${xhr.status}`
      reject(new RemoteApiError(xhr.status, message))
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
}

export interface PushReportView {
  alias: string
  probe: RemoteProbe
  action: 'pushed' | 'skipped-same' | 'failed'
  detail: string
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
  testHost: (alias: string) => post<{ ok: boolean; error?: string; durationMs: number }>(REMOTE_API.test, { alias }),
  bootstrap: (alias: string) => post<{ alias: string; keyPath: string; flipped: boolean; detail: string }>(REMOTE_API.keygen, { alias }),
  // -- files
  fileOp: {
    list: (alias: string, path: string) =>
      post<{ entries: RemoteFileEntry[] }>(REMOTE_API.files, { op: 'list', alias, path }).then(r => r.entries),
    stat: (alias: string, path: string) =>
      post<{ entry: RemoteFileEntry }>(REMOTE_API.files, { op: 'stat', alias, path }).then(r => r.entry),
    read: (alias: string, path: string) => post<RemoteRead>(REMOTE_API.files, { op: 'read', alias, path }),
    write: (alias: string, path: string, content: string) =>
      post<{ size: number }>(REMOTE_API.files, { op: 'write', alias, path, content, encoding: 'utf8' }),
    mkdir: (alias: string, path: string) => post<{ ok: boolean }>(REMOTE_API.files, { op: 'mkdir', alias, path }),
    rm: (alias: string, path: string, recursive: boolean) =>
      post<{ ok: boolean }>(REMOTE_API.files, { op: 'rm', alias, path, recursive }),
    rename: (alias: string, from: string, to: string) =>
      post<{ ok: boolean }>(REMOTE_API.files, { op: 'rename', alias, from, to }),
  },
  // -- exec
  exec: (alias: string, command: string, timeoutMs?: number) =>
    post<RemoteExecResult>(REMOTE_API.exec, timeoutMs === undefined ? { alias, command } : { alias, command, timeoutMs }),
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
  // -- routing mode (volatile, persists to the profile patch)
  setRoutingMode: (mode: 'off' | 'shadow' | 'enforce') =>
    post<{ mode: 'off' | 'shadow' | 'enforce' }>(REMOTE_API.routing, { mode }).then((r) => r.mode),
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
  // -- terminal socket URL
  terminalUrl: (params: { alias?: string; session?: string; cols: number; rows: number }) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = new URL(`${proto}//${location.host}${REMOTE_API.terminal}`)
    if (params.alias !== undefined) url.searchParams.set('alias', params.alias)
    if (params.session !== undefined) url.searchParams.set('session', params.session)
    url.searchParams.set('cols', String(params.cols))
    url.searchParams.set('rows', String(params.rows))
    return url.toString()
  },
}
