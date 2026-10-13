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
  type RemoteProbe,
  type RemoteRead,
  type RemoteRoutingStatus,
  type RemoteWorkspaceBinding,
} from '../protocol.ts'
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
    throw new RemoteApiError(502, `git timed out after ${Math.round(timeoutMs / 1000)}s (big/slow repo — retry, it may be warm now)`)
  }
  const friendly = gitFailed(r.stderr)
  throw new RemoteApiError(502, friendly ?? (r.stderr.trim() || r.error || `git failed [exit code: ${r.exitCode}]`))
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
  getWorkspaces: () => call<{ workspaces: RemoteWorkspaceBinding[] } & RemoteRoutingStatus>(REMOTE_API.workspaces),
  createWorkspace: (payload: { name: string; alias: string; remotePath: string }) =>
    call<{ workspace: RemoteWorkspaceBinding; aliasPath: string }>(REMOTE_API.workspaces, { method: 'POST', body: JSON.stringify(payload) }),
  deleteWorkspace: (id: string) =>
    call<{ ok: boolean }>(`${REMOTE_API.workspaces}?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
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
  // Generous timeout: status/log on huge trees (cold cache) routinely exceed 30s.
  git: {
    async status(alias: string, path: string): Promise<GitStatus> {
      const r = await post<RemoteExecResult>(REMOTE_API.exec, { alias, command: statusCommand(path), timeoutMs: 120_000 })
      throwIfGitFailed(r, 120_000)
      return parseStatus(r.stdout)
    },
    async log(alias: string, path: string, max: number, branch?: string): Promise<GitCommit[]> {
      const r = await post<RemoteExecResult>(REMOTE_API.exec, { alias, command: logCommand(path, max, branch), timeoutMs: 120_000 })
      throwIfGitFailed(r, 120_000)
      return parseLog(r.stdout)
    },
    async branches(alias: string, path: string, current: string): Promise<GitBranch[]> {
      const r = await post<RemoteExecResult>(REMOTE_API.exec, { alias, command: branchesCommand(path), timeoutMs: 60_000 })
      throwIfGitFailed(r, 60_000)
      return parseBranches(r.stdout, current)
    },
    async show(alias: string, path: string, ref: string): Promise<GitShow> {
      const [message, stat] = await Promise.all([
        post<RemoteExecResult>(REMOTE_API.exec, { alias, command: messageCommand(path, ref), timeoutMs: 60_000 }),
        post<RemoteExecResult>(REMOTE_API.exec, { alias, command: statCommand(path, ref), timeoutMs: 60_000 }),
      ])
      throwIfGitFailed(message, 60_000)
      throwIfGitFailed(stat, 60_000)
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
