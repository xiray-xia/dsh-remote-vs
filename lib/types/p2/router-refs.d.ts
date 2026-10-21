/**
 * Transparent file-reference router: agent-world-keyed delegation between the
 * stock local implementation (private realm) and per-host remote search. The
 * stock row is prompt-complete (it installs the @ guidance section for every
 * agent it sees), so this router only routes list() and never touches prompts.
 *
 * Reads are soft (ctx.get): declaring downstream services in inject would
 * cycle startup (see the remote-vs inject comment). A missing workingDirectory
 * degrades to the local implementation (which fails its own way if the
 * composition is truly broken); tombstoned sessions throw fail-closed.
 */
import { FileReferenceService } from '@deepseek-ai/dsh-file-reference';
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
export default class TransparentFileReferences extends FileReferenceService {
    static inject: string[];
    /** Agent-scoped remote searchers (auto-released with their agents). */
    private readonly remoteSearches;
    /** `session + call id` -> tool name, for calls whose result is still to come. */
    private readonly pendingCalls;
    constructor(ctx: Context);
    /**
     * Whether this result is positively known to come from a tree reader. A call
     * we never saw start, an unrecognized tool, or a payload that does not even
     * parse all answer "no": skipping the invalidation is only safe on proof, and
     * everything else must keep the guarantee that a bare query cannot answer
     * from an index older than the last possible change.
     */
    private isReadOnlyResult;
    /**
     * Remember which tool a call id belongs to. Keyed by session as well, because
     * a call id is only unique within the session that issued it — two sessions
     * (an agent and its teammate) can otherwise cross-talk and mask a write.
     */
    private rememberCall;
    /** Name of the tool whose result this is (consume it: results arrive once). */
    private takeCall;
    private get local();
    private get remote();
    private effective;
    list(agent: Agent, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]>;
    /** Per-agent remote searcher, rebuilt when the binding changes. */
    private searchFor;
}
