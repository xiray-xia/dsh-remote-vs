/**
 * Remote listening-TCP-socket enumeration for the port panel.
 *
 * One bounded POSIX one-liner does the work: `ss` (iproute2, every modern
 * Linux) first, `netstat` as the fallback (older Linux, and macOS with a
 * different address spelling), and an explicit `none` when neither exists. The
 * answer is a POOL of three facts the panel must keep apart:
 *
 *  - `none` / `unknown` are "cannot enumerate", never "no ports are open";
 *  - a tool that ran but produced nothing recognizable is a parse failure, not
 *    an empty machine;
 *  - process names are only visible for the invoking user's own processes
 *    (`ss -p` is allowed for everyone, but the kernel hides other users'
 *    sockets), so a missing name is UNKNOWN, not "not a service".
 *
 * Pure functions only (command builder + parser) so the gate can feed real
 * sample outputs; the route owns the exec round trip and its deadline.
 */
import type { RemoteListenPort, RemoteListenPortsResult } from './protocol.ts'

/** Prefix of every control line the probe prints (also the "did it answer" proof). */
export const LISTEN_PORTS_MARK = '@@RVS-PORTS'

/**
 * Budget for the whole probe. A handful of local commands over one channel; if
 * `ss` hangs (a stuck kernel table), the route answers with the exec deadline
 * instead of holding the panel's refresh forever.
 */
export const LISTEN_PORTS_TIMEOUT_MS = 15_000

/**
 * Most listeners one probe reports. A container host or a dev box running a
 * port scanner can have thousands; the panel is a picker, not an inventory.
 */
export const LISTEN_PORTS_MAX = 500

/**
 * The remote probe line.
 *
 * `if/elif/fi` rather than `a && b || c` chains: the shell's operator
 * precedence would make a failing `ss` fall through into `netstat`'s branch in
 * ways that depend on the last command's status, and one missing tool would be
 * indistinguishable from a tool that ran and failed.
 *
 * `-p` is requested first and silently degrades to `-n`: it only ADDS process
 * names, and it is allowed for a non-root user (the kernel just omits other
 * users' sockets). `netstat -an` is the last resort for macOS, whose `-l` is
 * not the Linux spelling; the parser understands both the colon and the dotted
 * `addr.port` form.
 */
export function listenPortsCommand(): string {
  return [
    // EXPORTED, not a bare assignment: a plain `LC_ALL=C` line sets the shell's
    // own variable but does not reach the `ss`/`netstat` child processes, so a
    // localized remote would still print translated headers and break parsing.
    'export LC_ALL=C',
    'if command -v ss >/dev/null 2>&1; then',
    `  echo "${LISTEN_PORTS_MARK} ss"`,
    '  ss -ltnp 2>/dev/null || ss -ltn 2>/dev/null',
    'elif command -v netstat >/dev/null 2>&1; then',
    `  echo "${LISTEN_PORTS_MARK} netstat"`,
    '  netstat -ltnp 2>/dev/null || netstat -ltn 2>/dev/null || netstat -an 2>/dev/null',
    'else',
    `  echo "${LISTEN_PORTS_MARK} none"`,
    'fi',
    `echo "${LISTEN_PORTS_MARK} end"`,
  ].join('\n')
}

/** `0.0.0.0:22` / `[::]:22` / `*:22` / macOS `127.0.0.1.631` → addr + port. */
interface SplitAddress {
  addr: string
  port: number
}

function splitAddressPort(value: string): SplitAddress | undefined {
  let addr: string
  let portText: string
  // The dotted form is tried FIRST: macOS's `netstat -an` prints `127.0.0.1.631`
  // and also `::1.9000`, where a colon split would land inside the address.
  const dotted = /^(.*)\.(\d+)$/.exec(value)
  if (dotted !== null) {
    addr = dotted[1]
    portText = dotted[2]
  } else if (value.includes(':')) {
    const at = value.lastIndexOf(':')
    addr = value.slice(0, at)
    portText = value.slice(at + 1)
    // `[::]:22` keeps the brackets in the address column; strip them so the
    // panel shows `::` (the conventional spelling) and the row can be copied.
    if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1)
  } else {
    return undefined
  }
  if (addr === '' || !/^[0-9]+$/.test(portText)) return undefined
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return { addr, port }
}

/** `[::]:22` → `[::]` for display; the bracket strip above already handles it. */
function normalizeAddr(addr: string): string {
  if (addr === '' || addr === '*') return '*'
  return addr
}

/** Process name out of `users:(("sshd",pid=1,fd=3))`, if the tool printed one. */
function processOf(text: string): string | undefined {
  const match = /users:\(\("([^"]+)"/.exec(text)
  if (match !== null) return match[1]
  // Linux `netstat -p` appends `1234/sshd`.
  const short = /(?:^|\s)[0-9]+\/([^\s/]+)/.exec(text)
  return short === null ? undefined : short[1]
}

/** One `ss -ltn[p]` row, or undefined for headers/foreign lines. */
function parseSsLine(line: string): RemoteListenPort | undefined {
  // `ss -l` prints ONLY listening sockets, so the state column is always
  // `LISTEN`; a header line ("State Recv-Q …") starts differently.
  if (!line.startsWith('LISTEN ')) return undefined
  const fields = line.split(/\s+/)
  // 0:LISTEN 1:Recv-Q 2:Send-Q 3:Local 4:Peer [5..:Process]
  const local = fields[3]
  if (local === undefined) return undefined
  const split = splitAddressPort(local)
  if (split === undefined) return undefined
  const process = fields.length > 5 ? processOf(fields.slice(5).join(' ')) : undefined
  return {
    addr: normalizeAddr(split.addr),
    port: split.port,
    ...(process === undefined ? {} : { process }),
  }
}

/** One `netstat -ltn[p]` / `netstat -an` row, or undefined for headers. */
function parseNetstatLine(line: string): RemoteListenPort | undefined {
  if (!/^tcp[0-9]*\s/.test(line)) return undefined
  const fields = line.split(/\s+/)
  const stateAt = fields.indexOf('LISTEN')
  if (stateAt < 0) return undefined
  const local = fields[3]
  if (local === undefined) return undefined
  const split = splitAddressPort(local)
  if (split === undefined) return undefined
  const tail = fields.slice(stateAt + 1).join(' ')
  const process = tail === '' ? undefined : processOf(tail)
  return {
    addr: normalizeAddr(split.addr),
    port: split.port,
    ...(process === undefined ? {} : { process }),
  }
}

/**
 * Parse one probe's stdout into the panel's result.
 *
 * @param stdout - the probe's standard output (both tools plus markers).
 * @param exitCode - the exec exit code; a non-zero run with no `end` marker is
 *   reported as `unknown`, because an interrupted probe proves nothing about
 *   the ports it never reached.
 */
export function parseListenPorts(stdout: string, exitCode: number | null): RemoteListenPortsResult {
  let tool: 'ss' | 'netstat' | 'none' | 'unknown' = 'unknown'
  let sawEnd = false
  /** Lines that looked like a candidate row, for the "parsed nothing" verdict. */
  let sawCandidate = false
  const seen = new Map<string, RemoteListenPort>()

  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith(LISTEN_PORTS_MARK)) {
      const arg = line.slice(LISTEN_PORTS_MARK.length).trim()
      if (arg === 'end') sawEnd = true
      else if (arg === 'ss' || arg === 'netstat' || arg === 'none') tool = arg
      continue
    }
    const parsed = tool === 'ss'
      ? parseSsLine(line)
      : tool === 'netstat'
        ? parseNetstatLine(line)
        : undefined
    if (parsed !== undefined) {
      const key = `${parsed.addr}|${parsed.port}`
      if (!seen.has(key)) seen.set(key, parsed)
      sawCandidate = true
      continue
    }
    if (tool === 'ss' && line.startsWith('LISTEN ')) sawCandidate = true
    if (tool === 'netstat' && /^tcp[0-9]*\s/.test(line) && line.includes('LISTEN')) sawCandidate = true
  }

  if (tool === 'none') {
    return { tool, ports: [], error: 'neither ss nor netstat is installed on the remote host' }
  }
  if (tool === 'unknown') {
    return {
      tool,
      ports: [],
      error: 'the remote probe did not answer (no marker line in its output)',
    }
  }
  if (!sawEnd && exitCode !== null && exitCode !== 0) {
    return {
      tool,
      ports: [],
      error: `the remote probe exited with code ${exitCode} before it finished`,
    }
  }
  // A null exit code means the channel closed without telling us how the
  // command ended: the stdout is a PREFIX, so nothing here may be presented as
  // the complete list. The route also guards this; the parser must too, because
  // a future caller should not have to know the route's convention.
  if (exitCode === null) {
    return {
      tool: 'unknown',
      ports: [],
      error: 'the remote probe ended without an exit status (the SSH channel closed)',
    }
  }
  const ports = [...seen.values()]
    // Code-unit ordering, not `localeCompare`: the panel's order must be
    // deterministic (and the gate's expected list readable), and ICU collation
    // sorts `::` before `0.0.0.0` — arbitrary for a machine-facing list.
    .sort((left, right) => left.port - right.port || (left.addr < right.addr ? -1 : left.addr > right.addr ? 1 : 0))
  if (ports.length === 0 && sawCandidate) {
    return {
      tool,
      ports: [],
      error: `${tool} printed listening sockets but the output could not be parsed`,
    }
  }
  if (ports.length > LISTEN_PORTS_MAX) {
    return {
      tool,
      ports: ports.slice(0, LISTEN_PORTS_MAX),
      error: `only the first ${LISTEN_PORTS_MAX} listening sockets are listed`,
    }
  }
  return { tool, ports }
}
