/**
 * Which remote spelling a clicked file reference actually exists at.
 *
 * Why this module exists
 * ----------------------
 * A click on a file reference resolves to an ordered candidate list (workspace
 * root first, then the session's current directory — see
 * `remote-file-open-target.ts`), and the caller used to accept only two
 * answers from the existence probe: "it exists" or "it does not". A TIMEOUT or
 * a TRANSPORT failure therefore read as "this spelling is wrong, try the next
 * one": one dead click became N remote stat calls, each paying its own 4s
 * deadline, followed by a 7s `find` fallback — with no UI feedback at all. On a
 * known-broken link every candidate fails the same way, so the extra probes
 * could never find anything either.
 *
 * The project already learned this lesson once, in `scm/actions.ts`:
 * `resolveRepoRoot` folded "not a repository" and "the probe did not answer"
 * into `undefined`, and the cache treated the empty answer as fact (MAINTENANCE
 * §2.25: "仓库探测必须三态"). This is the same rule for the click path:
 * `exists` / `missing` / `unknown`, and `unknown` STOPS the chain.
 *
 * Everything effectful is injected, so the decision table is drivable in node
 * without a store, a React tree or a fake SSH host
 * (`scripts/check-file-open-click.mjs`).
 */
/** What one candidate answer means for the chain. */
export type CandidateVerdict = {
    kind: 'exists';
    path: string;
}
/** Every candidate answered "no such file": the caller may try a suffix search. */
 | {
    kind: 'missing';
}
/** Cannot tell (timed out, link down): stop probing, open the primary spelling. */
 | {
    kind: 'unknown';
};
/** Everything the probe needs from the outside world. */
export interface CandidateProbeDeps {
    /** One remote stat; rejects with the host's error. */
    stat: (alias: string, path: string) => Promise<unknown>;
    /**
     * Bound one probe. Resolves `undefined` when the budget ran out — the shape
     * `withDeadline` already has (a timeout is not an error there).
     */
    deadline: <T>(promise: Promise<T>, ms: number) => Promise<T | undefined>;
    /** The link's last known state; only `'error'` is evidence of a dead link. */
    connection: (alias: string) => 'ok' | 'error' | 'idle' | undefined;
    /** Whether an error means "the link", as opposed to "this path is missing". */
    isLinkFailure: (error: unknown) => boolean;
}
/**
 * Probe the candidates in order, stopping at the first EXISTS **or the first
 * UNKNOWN**.
 *
 * @param alias - host alias the paths live on.
 * @param candidates - candidate spellings, most likely first.
 * @param deps - injected effects (stat / deadline / connection / classifier).
 * @param timeoutMs - budget for ONE probe.
 * @returns the verdict; `unknown` is not a failure — it tells the caller to
 *   stop guessing and show the real remote error instead.
 */
export declare function probeCandidates(alias: string, candidates: readonly string[], deps: CandidateProbeDeps, timeoutMs: number): Promise<CandidateVerdict>;
