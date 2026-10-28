/**
 * One remote read at a time, per key — with two honest contracts.
 *
 * Why this exists
 * ---------------
 * Git reads are expensive on a large repository: `loadStatusDetail` walks the
 * whole index and worktree (minutes on the AOSP monorepo), and several surfaces
 * can ask for one at the same moment — the workspace dropdown, the session
 * follow, the panel's ⟳, and every write made through the plugin. Until now each
 * caller simply started its own command and the newest one won the paint, which
 * meant two concurrent walks of the same tree and a panel that could not tell
 * which answer was current.
 *
 * The queue replaces that with:
 *
 * - `join`  — "show me a read of this key". A read already in flight is shared:
 *             starting a second one would only duplicate the same walk, so a
 *             workspace switch costs nothing when the previous read of that
 *             workspace is still running.
 * - `fresh` — "the answer must describe the state as of NOW" (the ⟳ button, and
 *             every write: a save, a commit, a stage verb). It never shares a
 *             read that started before the call: it waits for the running one to
 *             settle and then starts its own. Two `fresh` callers that arrive
 *             during the same read share the SINGLE follow-up read, because the
 *             second one can see that the follow-up started after its own call.
 *
 * Reads for DIFFERENT keys run in parallel: two workspaces are two repositories,
 * and making one wait for the other would make a switch feel dead. Nothing here
 * paints anything — the caller decides what its answer may overwrite — so the
 * queue carries no store/React knowledge and is directly testable.
 */
/** How a caller relates to a read that is already in flight. */
export type ReadMode = 'join' | 'fresh';
export declare class ReadQueue {
    private readonly onChange?;
    /** In-flight reads by key (insertion order is irrelevant here). */
    private readonly flights;
    private nextId;
    /**
     * @param onChange - called whenever a read starts or settles, so the owner can
     *   derive a "busy" flag from `inflightKeys()` without polling.
     */
    constructor(onChange?: (() => void) | undefined);
    /** The keys with a read in flight (a caller derives its busy state from this). */
    inflightKeys(): string[];
    /** True while ONE key has a read in flight. */
    isBusy(key: string): boolean;
    /**
     * Run `read` for `key`, honouring `mode`.
     *
     * The returned promise settles with this key's answer: a rejection comes from
     * the read the caller ended up waiting on (its own, or the one it joined).
     * `read` must be equivalent for every caller that passes the same key — the
     * queue keeps only the FIRST caller's closure, because a joined read cannot
     * carry a second closure.
     *
     * @param settleMs - hard settle deadline for a read THIS call starts (`0` =
     *   unbounded). A joined read keeps the deadline it was started with: its
     *   caller already decided how long that read may take.
     */
    run<T>(key: string, read: () => Promise<T>, mode?: ReadMode, settleMs?: number): Promise<T>;
    /**
     * `fresh` while a read is in flight: wait for it, then read once more.
     *
     * The follow-up is NOT started from here unconditionally, or two `fresh`
     * callers that arrived during the same read would each start one (two
     * concurrent walks, exactly what this class exists to prevent). The second
     * caller instead finds a flight whose id is newer than the one it waited on —
     * a read that started after its own call — and shares it.
     */
    private after;
    /** Register a flight and run `read`; a synchronous throw becomes a rejection. */
    private start;
}
