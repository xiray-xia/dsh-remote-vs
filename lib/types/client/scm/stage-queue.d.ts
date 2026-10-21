/** The repository a stage/unstage acts on. */
export interface ScmTarget {
    /** Host alias. */
    alias: string;
    /** Absolute remote repository root (git runs here). */
    root: string;
}
/** The git verbs the coordinator drives. */
export interface StagePort {
    /** `git add -A -- <paths>`. */
    stage: (target: ScmTarget, paths: readonly string[]) => Promise<void>;
    /** `git restore --staged -- <paths>`. */
    unstage: (target: ScmTarget, paths: readonly string[]) => Promise<void>;
    /** Raw `-z` stdout of the path-limited status (`probeStatusPaths`). */
    probe: (target: ScmTarget, paths: readonly string[]) => Promise<string>;
}
/** A verification outcome the user has to know about. */
export interface StageNotice {
    /**
     * `mismatch`: the repository disagreed with the local move, which was then
     * corrected. `unverified`: the check itself could not run, so the local state
     * stands unconfirmed.
     */
    kind: 'mismatch' | 'unverified';
    /** Repo-relative paths the notice is about, in click order. */
    paths: readonly string[];
}
/** The two local effects: the status model, and the user. */
export interface StageSink {
    /** Move paths between the index and worktree halves of the local model. */
    apply: (paths: readonly string[], staged: boolean) => void;
    /**
     * Report one verification outcome.
     *
     * A structured notice rather than a sentence: the wording belongs to the
     * caller (its own i18n keys, which have to be literal `t()` calls in the
     * source for the i18n check to see them), while this module stays free of
     * React, fetch and copy.
     */
    report: (notice: StageNotice) => void;
}
/** Timer injection, so a check can drive the debounce deterministically. */
export interface StageClock {
    set: (fn: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
}
/** The debounce window: how long clicks keep merging into one probe. */
export declare const DEFAULT_STAGE_WINDOW_MS = 250;
/**
 * Coordinates optimistic stage/unstage with a debounced, path-limited check.
 *
 * One instance per client: the panel's clicks, the store's status model and the
 * user notifications all meet here.
 */
export declare class StageCoordinator {
    private readonly port;
    private readonly sink;
    private readonly clock;
    private readonly windowMs;
    /** Clicks waiting for the current window to close. */
    private pending;
    private timer;
    /** Per-repository write chain: the second click waits for the first. */
    private readonly chains;
    constructor(port: StagePort, sink: StageSink, options?: {
        clock?: StageClock;
        windowMs?: number;
    });
    /**
     * Stage or unstage paths: local first, real verb in flight, verification once
     * the window closes.
     *
     * @param target - repository the paths belong to.
     * @param paths - repo-relative paths (a directory row may keep its `/`).
     * @param staged - true to stage, false to unstage.
     * @returns a promise that settles when this click's verification is in:
     *   rejected when the git verb itself failed (the caller reports it), and
     *   resolved when the verb landed — whether or not the probe agreed (a
     *   disagreement is corrected and notified here, not thrown).
     */
    submit(target: ScmTarget, paths: readonly string[], staged: boolean): Promise<void>;
    /**
     * Verify everything submitted so far with ONE path-limited probe per
     * repository. Called by the debounce timer; exposed so a caller (or a check)
     * can force the window closed.
     */
    flush(): Promise<void>;
    /** Drop the pending window (page teardown; the writes already went out). */
    dispose(): void;
    /** Queue one write behind the previous one for the same repository. */
    private enqueue;
    /** (Re)start the debounce window. */
    private arm;
    /**
     * One probe per repository over every path the window touched, then correct
     * whatever it contradicts.
     */
    private verify;
}
