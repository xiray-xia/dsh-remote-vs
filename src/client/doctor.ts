/**
 * Remote environment doctor: ONE POSIX `sh` line that probes what the remote
 * actually has, plus the pure parser that turns its output into three-state
 * rows.
 *
 * Why this module exists
 * ----------------------
 * The client already depends on remote tools whose absence is invisible until
 * something behaves worse than it should: without `rg` a content search falls
 * back to a recursive `grep` that never finishes on a large tree; without
 * `setsid --wait` a timeout can no longer end the remote command group and the
 * only trace is a host-console warning; a full `$HOME` shows up as a failed
 * push. Each of those was already documented as a known limit — this puts the
 * same evidence on one screen instead of leaving it to guesswork.
 *
 * The three-state rule
 * --------------------
 * `missing` is a POSITIVE fact: the remote answered "no such command". Every
 * other outcome — no marker line, an empty capture, an unparseable row, a
 * link that dropped before the exit status, a budget that ran out — is
 * IGNORANCE and must be reported as `unknown` with the reason. Encoding
 * ignorance as a negative result is the incident-index defect this feature
 * exists to avoid: a user who is told "rg is not installed" when the answer is
 * actually "the probe did not run" will install the wrong thing and still be
 * broken.
 *
 * Where the evidence comes from
 * -----------------------------
 * Every probe line carries a marker (`@@RVS-DOC <key> <state> <detail>`) so
 * the parser never has to guess from human-readable output, and the shell
 * folds each detail onto one line — output content can therefore never forge
 * or split a marker. The script merges stderr into the capture (`2>&1`) and
 * never uses `2>/dev/null`: dropping stderr is how the "permission denied"
 * case used to look exactly like "not installed" (the incident index calls
 * that out by name).
 *
 * What the tools' own failures look like
 * --------------------------------------
 * A shell reports exit 127 BOTH for "no such command" and for a binary that
 * exists but cannot start (missing shared library, broken interpreter). The
 * first is a positive answer, the second is ignorance — so the probe asks
 * `command -v` which one happened instead of assuming. `sshd` is looked up at
 * its absolute locations first: on Debian-family hosts a non-root login PATH
 * does not contain `/usr/sbin`, and a bare lookup would report a running sshd
 * as missing.
 *
 * Pure module: no React, no DOM, no i18n copy (labels are i18n KEYS; the panel
 * translates them, so this file can be gate-evaluated in plain node).
 */

export type DoctorState = 'ok' | 'missing' | 'unknown'

/** One row of the report. */
export interface DoctorItem {
  /** Stable probe id (`os`, `rg`, …) — also what the copied report groups by. */
  key: string
  /** i18n key for the row label. Translated by the panel, not here. */
  label: string
  state: DoctorState
  /**
   * Evidence: the remote's own words, or the reason this probe could not
   * decide. Never empty for `unknown` — an unexplainable unknown is noise.
   */
  detail: string
}

export interface DoctorProbe {
  key: string
  label: string
}

/**
 * Probe order is report order: environment first, then the tools the client
 * actually depends on, then the host-side facts (disk, helper installs).
 */
export const DOCTOR_PROBES: readonly DoctorProbe[] = [
  { key: 'os', label: 'doctor.item.os' },
  { key: 'libc', label: 'doctor.item.libc' },
  { key: 'git', label: 'doctor.item.git' },
  { key: 'rg', label: 'doctor.item.rg' },
  { key: 'tar', label: 'doctor.item.tar' },
  { key: 'setsid', label: 'doctor.item.setsid' },
  { key: 'disk', label: 'doctor.item.disk' },
  { key: 'nproc', label: 'doctor.item.nproc' },
  { key: 'memory', label: 'doctor.item.memory' },
  { key: 'helpers', label: 'doctor.item.helpers' },
  { key: 'sshd', label: 'doctor.item.sshd' },
]

/** Prefix of every probe line. Keep in sync with the script below. */
export const DOCTOR_MARK = '@@RVS-DOC'

/**
 * State words for the badge and the copied report. Kept beside the parser
 * because both the panel and `formatDoctorReport` need the same mapping; the
 * values are listed in `DYNAMIC_KEYS` since no literal `t()` call reaches them.
 */
export const DOCTOR_STATE_KEY: Record<DoctorState, string> = {
  ok: 'doctor.state.ok',
  missing: 'doctor.state.missing',
  unknown: 'doctor.state.unknown',
}

/**
 * Budget for the whole probe line. It is a handful of local commands over one
 * exec channel; 20 s leaves room for a slow sshd/`ldd` start without keeping
 * the panel spinning behind a dead link.
 */
export const DOCTOR_TIMEOUT_MS = 20_000

/**
 * Remote install root, mirrored from `REMOTE_ROOT` in `src/deploy.ts`.
 *
 * The client bundle CANNOT import that module (`deploy.ts` pulls `node:crypto`,
 * `node:fs` and the SFTP/SSH layer, which the client build's purity gate in
 * `tsdown.config.ts` rejects), so the literal has to live here.
 * `scripts/check-doctor.mjs` imports `REMOTE_ROOT` from `deploy.ts` and fails
 * when the two drift. That cross-check matters: the first version of this probe
 * looked for a file name the deploy pipeline never writes, so every real host
 * reported "no helper installed" — a self-check that guesses the layout is
 * worse than none.
 */
export const HELPER_ROOT = '~/.dsh-helpers'

/**
 * The remote probe line.
 *
 * Written as one script rather than one exec call per probe: the round trip
 * (and the channel slot) is the expensive part, and a partial report is still
 * useful. Every branch emits exactly one marker line, and the line ends with
 * `exit 0` so a stray tool's exit code cannot turn a complete report into a
 * failed one.
 *
 * `rv_emit` folds the detail onto ONE line: a multi-line capture would either
 * lose its tail in the report or, worse, let decoded output masquerade as a
 * marker for another probe.
 */
const SCRIPT = `export LC_ALL=C
rv_emit() {
  rv_state=$2
  rv_detail=$3
  rv_detail=$(printf '%s' "$rv_detail" | tr '\\n\\r\\t' '   ' | cut -c1-800)
  if [ -z "$rv_detail" ]; then rv_detail='-'; fi
  printf '@@RVS-DOC %s %s %s\\n' "$1" "$rv_state" "$rv_detail"
}
rv_cmd() {
  rv_key=$1
  shift
  rv_out=$("$@" 2>&1)
  rv_rc=$?
  if [ "$rv_rc" -eq 127 ]; then
    if command -v "$1" >/dev/null 2>&1; then
      rv_emit "$rv_key" unknown "exit 127 but present in PATH: $rv_out"
    else
      rv_emit "$rv_key" missing "command not found: $1"
    fi
    return
  fi
  if [ "$rv_rc" -ne 0 ]; then rv_emit "$rv_key" unknown "exit $rv_rc: $rv_out"; return; fi
  rv_line=$(printf '%s\\n' "$rv_out" | head -n 1)
  if [ -z "$rv_line" ]; then rv_emit "$rv_key" unknown "exit 0 with no output"; return; fi
  rv_emit "$rv_key" ok "$rv_line"
}
rv_helpers() {
  if [ -z "$HOME" ]; then
    rv_emit helpers unknown "HOME is not set, so the install root cannot be located"
    return
  fi
  rv_root=${HELPER_ROOT}
  if [ ! -e "$rv_root" ]; then
    rv_emit helpers missing "no $rv_root (nothing has been pushed to this host)"
    return
  fi
  if [ ! -d "$rv_root" ]; then
    rv_emit helpers unknown "$rv_root exists but is not a directory"
    return
  fi
  if [ ! -r "$rv_root" ] || [ ! -x "$rv_root" ]; then
    rv_err=$(ls -a "$rv_root" 2>&1)
    rv_emit helpers unknown "cannot read $rv_root: $rv_err"
    return
  fi
  rv_list=''
  rv_dirs=0
  for rv_dir in "$rv_root"/*/; do
    [ -d "$rv_dir" ] || continue
    rv_dirs=$((rv_dirs + 1))
    rv_manifest=$rv_dir/manifest.json
    [ -f "$rv_manifest" ] || continue
    rv_name=$(basename "$rv_dir")
    rv_ver=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$rv_manifest" | head -n 1 | cut -d'"' -f4)
    if [ -z "$rv_ver" ]; then rv_list="$rv_list $rv_name=(version unparsed)"; else rv_list="$rv_list $rv_name=$rv_ver"; fi
  done
  if [ -n "$rv_list" ]; then rv_emit helpers ok "installed:$rv_list"; return; fi
  if [ "$rv_dirs" -gt 0 ]; then
    rv_emit helpers unknown "$rv_dirs helper dir(s) under $rv_root but no readable manifest.json"
    return
  fi
  if [ -f "$rv_root/manifest.json" ]; then
    rv_artifact=$(grep -o '"artifact"[[:space:]]*:[[:space:]]*"[^"]*"' "$rv_root/manifest.json" | head -n 1 | cut -d'"' -f4)
    if [ -z "$rv_artifact" ]; then
      rv_emit helpers ok "root manifest present (artifact unparsed)"
    else
      rv_emit helpers ok "root manifest: $rv_artifact"
    fi
    return
  fi
  rv_emit helpers missing "no manifest.json under $rv_root (nothing has been pushed to this host)"
}
rv_cmd os uname -sm
rv_cmd libc ldd --version
rv_cmd git git --version
rv_cmd rg rg --version
rv_cmd tar tar --version
rv_out=$(setsid --wait sh -c 'exit 7' 2>&1)
rv_rc=$?
if [ "$rv_rc" -eq 7 ]; then
  rv_emit setsid ok "setsid --wait works (child exit 7 propagated)"
elif [ "$rv_rc" -eq 127 ]; then
  if command -v setsid >/dev/null 2>&1; then
    rv_emit setsid unknown "exit 127 but present in PATH: $rv_out"
  else
    rv_emit setsid missing "command not found: setsid"
  fi
else
  case "$rv_out" in
    *nrecognized*|*llegal*|*nvalid*|*"not supported"*|*"unknown option"*)
      rv_emit setsid missing "setsid rejects --wait: $rv_out" ;;
    *)
      rv_emit setsid unknown "exit $rv_rc: $rv_out" ;;
  esac
fi
rv_out=$(df -h "$HOME" 2>&1)
rv_rc=$?
if [ "$rv_rc" -eq 127 ]; then
  if command -v df >/dev/null 2>&1; then
    rv_emit disk unknown "exit 127 but present in PATH: $rv_out"
  else
    rv_emit disk missing "command not found: df"
  fi
elif [ "$rv_rc" -ne 0 ]; then
  rv_emit disk unknown "exit $rv_rc: $rv_out"
else
  rv_row=$(printf '%s\\n' "$rv_out" | grep -v '^Filesystem' | grep -v '^[[:space:]]*$' | tail -n 1)
  if [ -z "$rv_row" ]; then rv_emit disk unknown "df printed no filesystem row: $rv_out"; else rv_emit disk ok "$rv_row"; fi
fi
rv_cmd nproc nproc
rv_out=$(free -m 2>&1)
rv_rc=$?
if [ "$rv_rc" -eq 127 ]; then
  if command -v free >/dev/null 2>&1; then
    rv_emit memory unknown "exit 127 but present in PATH: $rv_out"
  else
    rv_emit memory missing "command not found: free"
  fi
elif [ "$rv_rc" -ne 0 ]; then
  rv_emit memory unknown "exit $rv_rc: $rv_out"
else
  rv_row=$(printf '%s\\n' "$rv_out" | grep '^Mem:' | head -n 1)
  if [ -z "$rv_row" ]; then rv_emit memory unknown "free printed no Mem: row: $rv_out"; else rv_emit memory ok "$rv_row"; fi
fi
rv_helpers
rv_sshd_bin=''
for rv_cand in /usr/sbin/sshd /sbin/sshd; do
  if [ -x "$rv_cand" ]; then rv_sshd_bin=$rv_cand; break; fi
done
if [ -z "$rv_sshd_bin" ]; then
  rv_found=$(command -v sshd 2>&1)
  if [ $? -eq 0 ] && [ -n "$rv_found" ]; then rv_sshd_bin=$rv_found; fi
fi
if [ -z "$rv_sshd_bin" ]; then
  rv_emit sshd unknown "sshd not found in PATH, /usr/sbin/sshd or /sbin/sshd; MaxSessions is unknown"
else
  rv_out=$("$rv_sshd_bin" -T 2>&1)
  rv_rc=$?
  if [ "$rv_rc" -ne 0 ]; then
    rv_emit sshd unknown "exit $rv_rc: $rv_out"
  else
    rv_row=$(printf '%s\\n' "$rv_out" | grep -i '^maxsessions' | head -n 1)
    if [ -z "$rv_row" ]; then rv_emit sshd unknown "sshd -T printed no MaxSessions line"; else rv_emit sshd ok "$rv_row"; fi
  fi
fi
exit 0
`

/** The single remote command the panel runs through `api.exec`. */
export function doctorScript(): string {
  return SCRIPT
}

const KNOWN = new Map(DOCTOR_PROBES.map(probe => [probe.key, probe]))

/** `@@RVS-DOC <key> <state> <detail…>` — anchored, so content cannot forge it. */
const MARKER = /^@@RVS-DOC ([a-z0-9-]+) (ok|missing|unknown)(?: (.*))?$/

/** Flatten whitespace and cap the length, so one detail stays one line. */
function oneLine(text: string, cap = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= cap ? flat : `${flat.slice(0, cap - 1)}…`
}

function isCount(value: string): boolean {
  return /^\d+$/.test(value)
}

/**
 * `df -h` row → "avail 60G · use 40% · /dev/sda1 on /".
 *
 * Column positions are the same in GNU, busybox and BSD `df -h`
 * (`filesystem size used avail use% mount`). A row that does not fit is not an
 * error and not a "no space" verdict: it is unparseable, so the row stays
 * `unknown` with the raw line as evidence.
 */
function describeDisk(row: string): { state: DoctorState; detail: string } {
  const cols = row.split(/\s+/).filter(col => col !== '')
  if (cols.length < 6 || !/^\d+(?:[.,]\d+)?[KMGTPE]?i?$/.test(cols[3]) || !/^(?:\d+%|-)$/.test(cols[4])) {
    return { state: 'unknown', detail: `unexpected df row: ${row}` }
  }
  return { state: 'ok', detail: `avail ${cols[3]} · use ${cols[4]} · ${cols[0]} on ${cols.slice(5).join(' ')}` }
}

/**
 * `free -m` Mem row → "total 15884M · used 12000M · free 1000M".
 *
 * Only the first four columns are labelled: procps versions disagree about the
 * tail (`shared buffers cached` in older ones, `available` in current ones), so
 * naming column 7 would print "available 2484M" out of a host where it actually
 * means `cached`. Three certain numbers beat four with one quietly wrong label.
 */
function describeMemory(row: string): { state: DoctorState; detail: string } {
  const cols = row.split(/\s+/).filter(col => col !== '')
  if (cols.length < 4 || cols[0] !== 'Mem:' || !isCount(cols[1]) || !isCount(cols[2]) || !isCount(cols[3])) {
    return { state: 'unknown', detail: `unexpected free row: ${row}` }
  }
  return { state: 'ok', detail: `total ${cols[1]}M · used ${cols[2]}M · free ${cols[3]}M` }
}

/** Per-key reinterpretation of a successful capture; undefined = keep as-is. */
function refine(key: string, detail: string): { state: DoctorState; detail: string } | undefined {
  if (key === 'disk') return describeDisk(detail)
  if (key === 'memory') return describeMemory(detail)
  return undefined
}

function normalize(probe: DoctorProbe, state: DoctorState, rawDetail: string): DoctorItem {
  // Longer than the default cap: a helper listing carries one entry per
  // installed version and must not be cut in the middle for no reason.
  const detail = oneLine(rawDetail, 600)
  if (state === 'ok') {
    // A "success" that produced no output proves nothing about the item.
    if (detail === '') return { key: probe.key, label: probe.label, state: 'unknown', detail: 'the probe reported success but carried no output' }
    const refined = refine(probe.key, detail)
    if (refined !== undefined) return { key: probe.key, label: probe.label, state: refined.state, detail: refined.detail }
    return { key: probe.key, label: probe.label, state: 'ok', detail }
  }
  if (state === 'missing') {
    return { key: probe.key, label: probe.label, state: 'missing', detail: detail === '' ? 'reported not installed by the remote probe' : detail }
  }
  return { key: probe.key, label: probe.label, state: 'unknown', detail: detail === '' ? 'the probe could not decide' : detail }
}

function allUnknown(reason: string): DoctorItem[] {
  const detail = oneLine(reason, 300)
  return DOCTOR_PROBES.map(probe => ({ key: probe.key, label: probe.label, state: 'unknown' as DoctorState, detail }))
}

function wholeRunReason(stderr: string): string {
  const err = oneLine(stderr, 200)
  return err === ''
    ? 'the remote command did not report an exit status (the link dropped or the time budget ran out)'
    : `the remote command did not report an exit status; stderr: ${err}`
}

/**
 * Parse the probe output into one row per known probe.
 *
 * @param exitCode - the remote exit status, or `null` when the channel died /
 *   the budget ran out. `null` invalidates the WHOLE run: partial stdout from a
 *   killed command is not evidence about the probes it never reached, so every
 *   row becomes `unknown` rather than some rows silently keeping stale states.
 */
export function parseDoctor(stdout: string, stderr: string, exitCode: number | null): DoctorItem[] {
  if (exitCode === null) return allUnknown(wholeRunReason(stderr))
  const found = new Map<string, { state: DoctorState; detail: string }>()
  for (const raw of stdout.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const match = MARKER.exec(line)
    if (match === null) continue
    const key = match[1]
    // A marker for a probe this build does not know is ignored, never rendered.
    if (!KNOWN.has(key) || found.has(key)) continue
    const detail = (match[3] ?? '').trim()
    // `-` is the script's "nothing to report" placeholder, not a detail.
    found.set(key, { state: match[2] as DoctorState, detail: detail === '-' ? '' : detail })
  }
  return DOCTOR_PROBES.map((probe) => {
    const hit = found.get(probe.key)
    if (hit === undefined) {
      // Absent evidence is NOT a negative answer. This is the line that keeps a
      // truncated output from ever being reported as "not installed".
      return {
        key: probe.key,
        label: probe.label,
        state: 'unknown' as DoctorState,
        detail: 'no marker line in the captured output (the probe did not answer, or the output was truncated)',
      }
    }
    return normalize(probe, hit.state, hit.detail)
  })
}

/**
 * The all-unknown report for a run that never produced a result at all (exec
 * rejected: dead link, timeout at the client, host refused the route). Kept
 * separate so the panel cannot accidentally drop a partial list on the floor.
 */
export function doctorFailure(reason: string): DoctorItem[] {
  return allUnknown(reason)
}

/**
 * Plain-text report for "copy all" — what the user pastes into a support
 * thread. One line per probe, states spelled out (no color codes to decode),
 * and every detail verbatim so the reply can be checked instead of trusted.
 */
export function formatDoctorReport(
  alias: string,
  items: DoctorItem[],
  t: (key: string) => string,
  at: number = Date.now(),
): string {
  const lines = [
    t('doctor.reportTitle').replace('{alias}', alias),
    t('doctor.reportAt').replace('{at}', new Date(at).toISOString()),
    '',
  ]
  for (const item of items) {
    lines.push(`${t(DOCTOR_STATE_KEY[item.state])}  ${t(item.label)}: ${item.detail}`)
  }
  return lines.join('\n')
}
