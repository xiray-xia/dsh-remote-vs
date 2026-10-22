/**
 * Per-session change ledger for remote workspaces.
 *
 * DSH already records "what did this turn change" — but only for local
 * sessions: `@deepseek-ai/dsh-workspace-changes` parses git's POSIX output with
 * host path semantics and stages its scratch index through `node:fs`, so on a
 * routed session the first baseline snapshot fails and the recorder returns
 * before appending anything (measured: 58 remote-bound sessions, 390 fs
 * writes, zero `workspace/changes` events).
 *
 * This ledger re-expresses the idea for a remote host, and one measurement
 * decided its shape. A first version snapshotted the worktree with `git add
 * --all` into a private index; on a monorepo (AOSP, ~1M files) that never
 * finished — it was still hashing two minutes in, and the panel sat at
 * "computing…" forever. Everything here is therefore **read-only and
 * proportional to the files that changed**, never to the size of the
 * repository:
 *
 * 1. `git status --porcelain -uno` names the tracked files that differ (1.7s
 *    measured), `git ls-files --others` names the new ones (11.3s measured,
 *    run as its own best-effort exec).
 * 2. Only those paths are read (their current text, and `HEAD:<path>` for the
 *    ones the session started clean).
 * 3. The diff itself is computed here, line by line, with no git call at all.
 *
 * Nothing in this file writes to the repository: no `git add`, no index, no
 * object store, no temp files under the repo. "What changed" is answered by
 * git's own stat cache; "what changed *since the session started*" is answered
 * by keeping the pre-existing dirty files' contents at session start and
 * treating an unchanged one as untouched.
 */
import type { RemoteChangesDiff, RemoteChangesSummary, RemoteTimeouts } from '../protocol.ts';
import type { RemotePool } from '../pool.ts';
import type { RemoteWorlds } from '../p2/worlds.ts';
/** The two facts a turn boundary needs from a Session, kept cordis-free. */
export interface LedgerTarget {
    sessionId: string;
    /** Session working directory as the host sees it (an alias path for remote sessions). */
    cwd: string;
}
/** Collaborators the ledger needs; all injectable so it can be unit-tested. */
export interface SessionChangesDeps {
    pool: RemotePool;
    worlds: RemoteWorlds;
    /** Effective git budget, read per call (a `volatile()` edit applies live). */
    timeouts: () => RemoteTimeouts;
    log?: (level: 'info' | 'warn', message: string) => void;
    /** Cap on listed files; the header totals stay whole. */
    maxFiles?: number;
    /** Cap on one file's text, in bytes. */
    maxFileBytes?: number;
    /** Cap on one refresh's total text, in bytes. */
    maxTotalBytes?: number;
    /** Budget for the untracked scan, which is an order of magnitude slower. */
    untrackedBudgetMs?: number;
    /** How often the untracked scan may run again (default five seconds). */
    untrackedRefreshMs?: number;
    /**
     * Override the per-exec budget outright.
     *
     * The timeouts setting is clamped to a sane range, which is right for a Host
     * but useless for a check that must not wait five seconds to see a watchdog
     * fire.
     */
    execBudgetMs?: number;
}
export declare class SessionChanges {
    private readonly ledgers;
    private readonly deps;
    private disposed;
    constructor(deps: SessionChangesDeps);
    /** Open (or reuse) the ledger for one session at the start of a turn. */
    beginTurn(target: LedgerTarget): void;
    /** Refresh the ledger at the end of a turn. */
    endTurn(target: LedgerTarget, turn: number): void;
    /** The current summary for one session, or null when it has no ledger. */
    summary(sessionId: string): RemoteChangesSummary | null;
    /**
     * Compare one listed file across the whole session.
     *
     * The `before` side comes from the session baseline, which never moves. The
     * `after` side is read from the host on every call rather than replayed from
     * the last scan: a revert, a save from the editor or a shell command all
     * change the file between scans, and replaying a cached copy against a fresh
     * buffer is exactly how the painted lines end up at the wrong places.
     *
     * @param sessionId - live session owning the ledger.
     * @param path - the file's remote absolute path (as listed in the summary).
     * @returns hunks for decorations, or null when the session/file is unknown.
     */
    diff(sessionId: string, path: string): Promise<RemoteChangesDiff | null>;
    /** Resolve once every queued refresh has settled, including coalesced work. */
    settled(): Promise<void>;
    /** Drop one session's ledger. */
    forget(sessionId: string): void;
    /** Release every ledger (plugin unmount). */
    dispose(): void;
    /**
     * Force a fresh pass, ignoring the untracked cadence.
     *
     * The panel's refresh button calls this: the cadence exists so a slow scan
     * does not run on every turn, but "I clicked refresh" means the user wants
     * the truth now — including files that appeared seconds ago.
     */
    rescan(sessionId: string): void;
    /**
     * Self-heal a ledger whose data has gone stale.
     *
     * The panel polls `list`, and a poll is the one moment we know a human is
     * looking at the answer. If the data is older than `maxAgeMs`, re-scan — so a
     * turn boundary this Host never delivered costs a few seconds of staleness
     * instead of a manual refresh.
     *
     * @returns whether a refresh was queued.
     */
    touch(sessionId: string, maxAgeMs?: number): boolean;
    /**
     * Point one ledger at a subdirectory of the session root.
     *
     * This is the Source Control panel's "repository directory": an explicit
     * choice by the user, and therefore the authority whenever it is set. The
     * automatic one-level probe is only a fallback for a container workspace that
     * holds exactly one repository.
     *
     * @param subdir - workspace-relative directory, or undefined for the session
     *   root itself. Absolute paths and `..` are refused: they would move the
     *   ledger outside the workspace it was created for.
     */
    useRepoSubdir(sessionId: string, subdir: string | undefined): void;
    /** Resolve the routing target once per session, caching the ledger. */
    private ensure;
    /** Queue a refresh, coalescing bursts (a turn can end while one is running). */
    private schedule;
    /**
     * One refresh: the cheap scan first, then the slow one in the background.
     *
     * The split is not cosmetic. On the reference monorepo `git status -uno`
     * answers in ~3s while `git ls-files --others` needs over a minute, so a
     * single sequential refresh would leave the panel empty for that whole
     * minute even though the tracked changes were known after three seconds.
     * Phase one publishes, phase two adds the new files when (and if) it lands.
     */
    private refresh;
    /** Recompute the panel's list from the scans currently known. */
    private publish;
    /**
     * The cheap scan: tracked files whose working-tree bytes differ from the
     * index (1.4s measured on the reference monorepo).
     *
     * A session working directory is often a CONTAINER for repositories rather
     * than one itself (a session root that holds another repository inside it),
     * and `git status` there answers exit 128 — "not a git
     * repository (or any parent up to mount point /)". When that happens the
     * ledger looks one level down once and adopts the repository it finds, which
     * is the same idea the SCM panel's `repoSubdir` expresses by hand.
     *
     * @returns entries relative to the ledger's root, or undefined when no
     *   repository could be found (the ledger then reports why).
     */
    private scanTracked;
    /**
     * Look for a repository in the session root's immediate subdirectories.
     *
     * **Only an unambiguous answer is adopted.** A workspace that holds several
     * repositories has no single right one, and silently picking the first would
     * report changes from a project the session never touched — worse than saying
     * "I don't know". The explicit repository directory the Source Control panel
     * stores is the real answer, and this fallback exists only to spare the user
     * from setting it when there is exactly one candidate.
     *
     * @returns the adopted root, or undefined when nothing (or too much) was found.
     */
    private adoptRepositoryBelow;
    /**
     * The slow scan: new files, in the background.
     *
     * The same command costs ~11s on a warm tree and over a minute on a cold one,
     * and on the reference AOSP monorepo it has been measured past 60s with no
     * answer at all. It therefore never runs inline with the tracked scan, never
     * runs twice at once, and only runs again after {@link untrackedCadence}. A
     * repository that cannot answer inside {@link untrackedBudget} is written off
     * for the session (`untrackedGivenUp`) rather than retried every turn.
     */
    private kickUntracked;
    /**
     * How long before the untracked scan may run again.
     *
     * Self-tuning on purpose: the same command costs ~0.2s in a small repository
     * and over a minute in a monorepo, so a fixed cadence is either wasteful or
     * useless. Backing off to four times the last duration keeps small projects
     * near-real-time while a big one settles into a scan every couple of minutes
     * instead of one per turn.
     */
    private untrackedCadence;
    /**
     * Fold files that already existed when the session began into the baseline.
     *
     * The untracked walk is slow enough (a minute on a monorepo) that the baseline
     * refresh publishes before it lands, so its first result arrives without a
     * "before" side. Without this, every file the checkout already had — the
     * user's own scratch files, a build's leftovers — would be announced as this
     * session's work, complete with a full-file addition count.
     *
     * mtime decides: strictly older than the ledger's own start means the session
     * cannot have created it, and its present content is therefore its baseline.
     */
    private absorbPreExisting;
    /**
     * Race one host call against its own budget.
     *
     * A budget handed to `exec` is a request, not a guarantee: the transport may
     * keep the promise open long after the command should have been killed (the
     * remote process can even be gone while the channel stays). Awaiting such a
     * promise blocks the ledger's whole queue, so the panel shows "computing…"
     * for as long as the user is willing to stare at it. This bounds that wait.
     */
    private withWatchdog;
    /** Read a batch of files, capped per file and in total. */
    private readPaths;
    /** Run one command on the host, normalizing failure into a reason string. */
    private run;
    /** Turn a failed scan into something a user can act on. */
    private reasonOf;
    /** One exec's budget: the git setting, clamped so a hung host cannot pile up work. */
    private execBudget;
    /** The untracked scan gets its own, more generous budget. */
    /**
     * The untracked scan gets its own, much more generous budget.
     *
     * Three minutes is a deliberate choice for a monorepo: the walk is proportional
     * to the whole checkout, not to the session, and the reference AOSP tree has
     * been measured past a minute cold. Waiting is acceptable here because the
     * scan runs in the background and the tracked changes are already on screen;
     * giving up early is not, because the files a session creates with a shell
     * command are visible ONLY through this scan.
     */
    private untrackedBudget;
    private budget;
    private warn;
}
