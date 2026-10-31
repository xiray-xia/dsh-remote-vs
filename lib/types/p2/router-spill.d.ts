import type { Context } from '@deepseek-ai/cordis';
import { SpillStore } from '@deepseek-ai/dsh-spill';
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill';
export default class TransparentSpillStore extends SpillStore {
    static inject: string[];
    /** Hosts already TTL-swept by THIS process (one `find` per host, not per spill). */
    private readonly sweptAliases;
    /** session id -> directories written for it, for the best-effort dispose prune. */
    private readonly sessionDirs;
    constructor(ctx: Context);
    private get local();
    private get remote();
    private effective;
    saveText(input: SaveTextSpill): Promise<SpillRef>;
    /** Explicit remote policy: mirrored mode, spill dir as the fence root. */
    private policyFor;
    /**
     * Sweep one host's spill root once per process.
     *
     * The marker is set BEFORE awaiting so two concurrent first spills on the same
     * host cannot both issue the sweep; a failed sweep still leaves the host marked
     * (retention is a nicety, retrying it on every spill would be a tax).
     */
    private sweepOnce;
    /** Remember one written directory for the dispose prune (bounded, oldest first). */
    private remember;
    /** Best-effort TTL check for the directories one session wrote. Never throws. */
    private pruneSession;
    private warn;
}
