/**
 * Agent tools: the model-facing counterpart of the remote GUI. Every tool
 * talks to the same pool/files the web UI uses. Hosts must be configured in
 * the GUI first (agents cannot create hosts).
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { RemotePool } from './pool.ts'
import { RemoteFiles } from './sftp.ts'
import type { RemoteStore } from './store.ts'
import type { RemoteExecResult, RemoteHostSummary } from './protocol.ts'

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** Agent-facing host row (schema-strict projection of RemoteHostSummary). */
export interface AgentHostRow {
  alias: string
  host: string
  port: number
  user: string
  auth: 'key' | 'password'
  keyReady: boolean
  managedKey: boolean
  description?: string
  tags: string[]
  createdAt: number
  updatedAt: number
}

function toAgentHostRow(host: RemoteHostSummary): AgentHostRow {
  return {
    alias: host.alias,
    host: host.host,
    port: host.port,
    user: host.user,
    auth: host.auth,
    keyReady: host.keyReady,
    managedKey: host.managedKey,
    ...(host.description !== undefined ? { description: host.description } : {}),
    tags: [...host.tags],
    createdAt: host.createdAt,
    updatedAt: host.updatedAt,
  }
}

function renderHosts(hosts: RemoteHostSummary[]): string {
  if (hosts.length === 0) return 'no remote hosts configured (add one in the Remote sidebar tab first)'
  const rows = hosts.map(h => [
    h.alias, h.host, String(h.port), h.user, h.auth,
    h.auth === 'key' ? (h.keyReady ? 'key-ok' : 'key-missing') : 'password',
    h.tags.length > 0 ? h.tags.join(',') : '-',
    h.description ?? '',
  ].join(' | '))
  return ['alias | host | port | user | auth | key | tags | description', '--- | --- | --- | --- | --- | --- | --- | ---', ...rows].join('\n')
}

function renderExec(result: RemoteExecResult): string {
  const marker = result.timedOut ? '[timed out]' : `[exit code: ${result.exitCode ?? 'null'}]`
  const parts = [marker]
  if (result.stdout !== '') parts.push('stdout:\n' + result.stdout)
  if (result.stderr !== '') parts.push('stderr:\n' + result.stderr)
  if (result.error !== undefined) parts.push('error: ' + result.error)
  parts.push(`duration: ${result.durationMs} ms`)
  return parts.join('\n')
}

/** Schema-strict exec outcome (exitCode null folds to undefined). */
export interface AgentExecOut {
  success: boolean
  exitCode?: number
  timedOut: boolean
  stdout: string
  stderr: string
  durationMs: number
  error?: string
}

export interface RemoteToolsDeps {
  store: RemoteStore
  pool: RemotePool
}

export function remoteHostsTool(deps: RemoteToolsDeps): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'remote_hosts',
    description: 'List configured remote SSH hosts (alias, host, user, auth). Use remote_exec/remote_read/remote_write/remote_ls with the alias.',
    parameters: {
      query: { type: 'string', description: 'Optional fuzzy match against alias, host, and description.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hosts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                host: { type: 'string', required: true },
                port: { type: 'integer', required: true },
                user: { type: 'string', required: true },
                auth: { type: 'string', enum: ['key', 'password'], required: true },
                keyReady: { type: 'boolean', required: true },
                managedKey: { type: 'boolean', required: true },
                description: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' }, required: true },
                createdAt: { type: 'integer', required: true },
                updatedAt: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: { hosts?: AgentHostRow[] }) => text(renderHosts(value.hosts ?? [])),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const query = typeof args.query === 'string' && args.query !== '' ? args.query.toLowerCase() : undefined
      const hosts = deps.store.list()
        .map(h => deps.store.summarize(h))
        .filter(h => query === undefined
          || h.alias.toLowerCase().includes(query)
          || h.host.toLowerCase().includes(query)
          || (h.description ?? '').toLowerCase().includes(query))
        .map(toAgentHostRow)
      return { hosts }
    },
  })
}

export function remoteExecTool(deps: RemoteToolsDeps): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'remote_exec',
    description: 'Run a non-interactive shell command on a remote SSH host. stdout/stderr are returned verbatim (may carry secrets).',
    parameters: {
      alias: { type: 'string', description: 'Host alias from remote_hosts.' },
      command: { type: 'string', description: 'Shell command to run on the remote host.' },
      timeoutMs: { type: 'number', description: 'Timeout in ms (default 60000, max 600000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          exitCode: { type: 'integer' },
          timedOut: { type: 'boolean', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          durationMs: { type: 'number', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value: AgentExecOut) => text(renderExec({ ...value, exitCode: value.exitCode ?? null })),
    },
    async execute(args) {
      const timeoutMs = typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
        ? Math.min(Math.max(Math.floor(args.timeoutMs), 1000), 600_000)
        : undefined
      const result = await deps.pool.exec(
        args.alias as string,
        args.command as string,
        timeoutMs === undefined ? {} : { timeoutMs },
      )
      const out: AgentExecOut = {
        success: result.success,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
      }
      return out
    },
  })
}

export function remoteLsTool(deps: RemoteToolsDeps): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'remote_ls',
    description: 'List one remote directory over SFTP (absolute POSIX path).',
    parameters: {
      alias: { type: 'string', description: 'Host alias from remote_hosts.' },
      path: { type: 'string', description: 'Absolute remote directory path.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                path: { type: 'string', required: true },
                isDir: { type: 'boolean', required: true },
                size: { type: 'integer', required: true },
                mtime: { type: 'integer', required: true },
                isSymlink: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: { entries?: { name: string; isDir: boolean; size: number }[] }) => text(
        (value.entries ?? []).map(e => `${e.isDir ? 'd' : '-'} ${e.size} ${e.name}`).join('\n') || '(empty directory)',
      ),
    },
    async execute(args) {
      const files = new RemoteFiles(deps.pool)
      return { entries: await files.list(args.alias as string, args.path as string) }
    },
  })
}

export function remoteReadTool(deps: RemoteToolsDeps): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'remote_read',
    description: 'Read a remote text file over SFTP (absolute POSIX path, first 8 MiB window). Refuses binary files.',
    parameters: {
      alias: { type: 'string', description: 'Host alias from remote_hosts.' },
      path: { type: 'string', description: 'Absolute remote file path.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          size: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value: { text?: string; truncated?: boolean }) => text(
        (value.text ?? '') + (value.truncated === true ? '\n[... truncated: file exceeds 8 MiB ...]' : ''),
      ),
    },
    async execute(args) {
      const files = new RemoteFiles(deps.pool)
      const result = await files.read(args.alias as string, args.path as string)
      if (result.binary) throw new Error('binary file: remote_read serves text only')
      return { size: result.size, truncated: result.truncated, text: result.text ?? '' }
    },
  })
}

export function remoteWriteTool(deps: RemoteToolsDeps): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'remote_write',
    description: 'Write a remote text file over SFTP (absolute POSIX path, creates parent dirs). Overwrites without confirmation.',
    parameters: {
      alias: { type: 'string', description: 'Host alias from remote_hosts.' },
      path: { type: 'string', description: 'Absolute remote file path.' },
      content: { type: 'string', description: 'UTF-8 text content to write.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          size: { type: 'integer', required: true },
        },
      },
      render: (_args, value: { size?: number }) => text(`wrote ${value.size ?? 0} bytes`),
    },
    async execute(args) {
      const files = new RemoteFiles(deps.pool)
      return files.write(args.alias as string, args.path as string, args.content as string, 'utf8')
    },
  })
}
