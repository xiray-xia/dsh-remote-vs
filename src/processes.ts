/**
 * Remote process snapshots for the monitor page.
 *
 * Same model as `listen-ports.ts`: one bounded POSIX probe (GNU `ps`, a BSD
 * `ps` fallback, then an explicit `none`), with all parsing done host-side so
 * the browser only receives a bounded table. A process is never killed by a
 * command assembled in the browser: the route validates the PID against the
 * latest snapshot and builds the one signal command here.
 */
import type { RemoteProcess, RemoteProcessesResult } from './protocol.ts'
import { shQuote } from './git-format.ts'

/** Marker proving which probe branch actually ran. */
export const PROCESSES_MARK = '@@RVS-PROCS'

/** Budget for the whole probe; a stuck process table must not pin a channel. */
export const PROCESSES_TIMEOUT_MS = 15_000

/** Hard cap on rows per snapshot (a container host can have thousands). */
export const PROCESSES_MAX = 500

/**
 * One bounded probe.
 *
 * GNU first (`--sort` + `etimes`), then the portable `ps aux` table for BSD /
 * old systems (`ppid` and elapsed time are unknown there). The marker
 * line is printed BEFORE the table so an interrupted probe is distinguishable
 * from a genuinely empty one; the final marker lets the parser reject a
 * truncated run.
 */
export function processesCommand(max: number = PROCESSES_MAX): string {
  const cap = Math.max(1, Math.min(PROCESSES_MAX, Math.floor(max)))
  const gnu = `ps -eo pid=,ppid=,user=,pcpu=,pmem=,etimes=,args= --sort=-pcpu 2>/dev/null`
  return [
    // EXPORTED: a plain LC_ALL assignment does not reach `ps` itself.
    'export LC_ALL=C',
    `if ${gnu} >/dev/null 2>&1; then`,
    `  echo "${PROCESSES_MARK} gnu"`,
    `  ${gnu} | head -n ${cap}`,
    'elif ps aux >/dev/null 2>&1; then',
    `  echo "${PROCESSES_MARK} bsd"`,
    `  ps aux | head -n ${cap}`,
    'else',
    `  echo "${PROCESSES_MARK} none"`,
    'fi',
    `echo "${PROCESSES_MARK} end"`,
  ].join('\n')
}

/** A kill signal the route accepts; never an arbitrary string from the client. */
export type KillSignal = 'TERM' | 'KILL'

export function isKillSignal(value: unknown): value is KillSignal {
  return value === 'TERM' || value === 'KILL'
}

/** Assert a PID a process snapshot may contain (1 is the remote init). */
export function assertProcessPid(value: unknown): number {
  const pid = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(pid) || pid <= 1 || pid > 2_147_483_647) throw new Error('invalid process id')
  return pid
}

/**
 * Build the one kill command. The PID has already passed the snapshot check;
 * single-quoting it keeps the command shape uniform with every other builder.
 */
export function killCommand(pid: number, signal: KillSignal): string {
  return `kill -s ${signal} ${shQuote(String(assertProcessPid(pid)))}`
}

function numberOr(value: string): number | null {
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(value)) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/** GNU row: pid ppid user pcpu pmem etimes args. */
function parseGnuRow(line: string): RemoteProcess | undefined {
  const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([0-9.]+)\s+([0-9.]+)\s+(\d+)\s+(.*)$/.exec(line)
  if (match === null) return undefined
  const pid = match[1] as string
  const ppid = match[2] as string
  const user = match[3] as string
  const cpu = match[4] as string
  const mem = match[5] as string
  const elapsed = match[6] as string
  const command = match[7] as string
  return {
    pid: Number(pid),
    ppid: Number(ppid),
    user,
    cpuPercent: numberOr(cpu) ?? 0,
    memPercent: numberOr(mem) ?? 0,
    elapsedSeconds: numberOr(elapsed) ?? null,
    command: command.trim(),
  }
}

/** BSD `ps aux` row: user pid %cpu %mem vsz rss tt stat started time command. */
function parseBsdRow(line: string): RemoteProcess | undefined {
  const match = /^\s*(\S+)\s+(\d+)\s+([0-9.]+)\s+([0-9.]+)\s+\S+\s+\S+\s+\S+\s+\S+\s+(\S+)\s+\S+\s+(.*)$/.exec(line)
  if (match === null) return undefined
  const user = match[1] as string
  const pid = match[2] as string
  const cpu = match[3] as string
  const mem = match[4] as string
  const command = match[6] as string
  return {
    pid: Number(pid),
    ppid: 0,
    user,
    cpuPercent: numberOr(cpu) ?? 0,
    memPercent: numberOr(mem) ?? 0,
    elapsedSeconds: null,
    command: command.trim(),
  }
}

/**
 * Parse one probe. `exitCode === null` (channel died) or a missing end marker
 * means `unknown`, never an empty process table.
 */
export function parseProcesses(stdout: string, exitCode: number | null): RemoteProcessesResult {
  const lines = stdout.split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line)
  const markerAt = lines.findIndex(line => line.trim() === `${PROCESSES_MARK} gnu` || line.trim() === `${PROCESSES_MARK} bsd` || line.trim() === `${PROCESSES_MARK} none`)
  if (exitCode === null || markerAt < 0) {
    return { tool: 'unknown', processes: [], truncated: false, error: 'the remote process probe ended without a complete answer' }
  }
  const marker = lines[markerAt]?.trim() ?? ''
  const endAt = lines.findIndex((line, index) => index > markerAt && line.trim() === `${PROCESSES_MARK} end`)
  if (endAt < 0) {
    return { tool: 'unknown', processes: [], truncated: false, error: 'the remote process probe was interrupted' }
  }
  if (marker.endsWith('none')) return { tool: 'none', processes: [], truncated: false }
  const gnu = marker.endsWith('gnu')
  const processes: RemoteProcess[] = []
  for (const line of lines.slice(markerAt + 1, endAt)) {
    if (line.trim() === '') continue
    const row = gnu ? parseGnuRow(line) : parseBsdRow(line)
    if (row !== undefined) processes.push(row)
  }
  if (processes.length === 0) {
    return { tool: 'unknown', processes: [], truncated: false, error: 'the remote ps output could not be parsed' }
  }
  return { tool: gnu ? 'gnu' : 'bsd', processes, truncated: processes.length >= PROCESSES_MAX }
}
