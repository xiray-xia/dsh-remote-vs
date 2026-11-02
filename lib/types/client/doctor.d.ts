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
export type DoctorState = 'ok' | 'missing' | 'unknown';
/** One row of the report. */
export interface DoctorItem {
    /** Stable probe id (`os`, `rg`, …) — also what the copied report groups by. */
    key: string;
    /** i18n key for the row label. Translated by the panel, not here. */
    label: string;
    state: DoctorState;
    /**
     * Evidence: the remote's own words, or the reason this probe could not
     * decide. Never empty for `unknown` — an unexplainable unknown is noise.
     */
    detail: string;
}
export interface DoctorProbe {
    key: string;
    label: string;
}
/**
 * Probe order is report order: environment first, then the tools the client
 * actually depends on, then the host-side facts (disk, helper installs).
 */
export declare const DOCTOR_PROBES: readonly DoctorProbe[];
/** Prefix of every probe line. Keep in sync with the script below. */
export declare const DOCTOR_MARK = "@@RVS-DOC";
/**
 * State words for the badge and the copied report. Kept beside the parser
 * because both the panel and `formatDoctorReport` need the same mapping; the
 * values are listed in `DYNAMIC_KEYS` since no literal `t()` call reaches them.
 */
export declare const DOCTOR_STATE_KEY: Record<DoctorState, string>;
/**
 * Budget for the whole probe line. It is a handful of local commands over one
 * exec channel; 20 s leaves room for a slow sshd/`ldd` start without keeping
 * the panel spinning behind a dead link.
 */
export declare const DOCTOR_TIMEOUT_MS = 20000;
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
export declare const HELPER_ROOT = "~/.dsh-helpers";
/** The single remote command the panel runs through `api.exec`. */
export declare function doctorScript(): string;
/**
 * Parse the probe output into one row per known probe.
 *
 * @param exitCode - the remote exit status, or `null` when the channel died /
 *   the budget ran out. `null` invalidates the WHOLE run: partial stdout from a
 *   killed command is not evidence about the probes it never reached, so every
 *   row becomes `unknown` rather than some rows silently keeping stale states.
 */
export declare function parseDoctor(stdout: string, stderr: string, exitCode: number | null): DoctorItem[];
/**
 * The all-unknown report for a run that never produced a result at all (exec
 * rejected: dead link, timeout at the client, host refused the route). Kept
 * separate so the panel cannot accidentally drop a partial list on the floor.
 */
export declare function doctorFailure(reason: string): DoctorItem[];
/**
 * Plain-text report for "copy all" — what the user pastes into a support
 * thread. One line per probe, states spelled out (no color codes to decode),
 * and every detail verbatim so the reply can be checked instead of trusted.
 */
export declare function formatDoctorReport(alias: string, items: DoctorItem[], t: (key: string) => string, at?: number): string;
