/**
 * In-flight directory-listing requests, shared by the explorer's hover prefetch
 * and the reads that follow it.
 *
 * Two rules the tree depends on:
 *  - JOIN only a request that started at the SAME revision. A listing read after
 *    a write must never be answered by a request issued before it, or pre-write
 *    rows paint as if they were final (a hover prefetch starts, a write lands,
 *    the click follows and joins the request that predates the write).
 *  - PAINT in request order. If a newer request supersedes an older one for the
 *    same directory, the older answer may still arrive; it must not overwrite the
 *    one the caller asked for.
 *
 * The cache itself stays in the component: this module only owns "which listing
 * requests are on the wire and which answer may be stored".
 */
import type { RemoteFileEntry } from '../protocol.ts';
export declare class ListingRequests {
    private readonly keyOf;
    private readonly load;
    private readonly store;
    private readonly inFlight;
    /** Newest request per key: only its answer may be stored. */
    private readonly newest;
    private sequence;
    /**
     * @param keyOf - cache key for one directory (host alias + absolute path).
     * @param load - performs the listing.
     * @param store - applies a listing whose request is still the newest for its
     *   key; the component writes it into the listing cache.
     */
    constructor(keyOf: (dir: string) => string, load: (dir: string) => Promise<RemoteFileEntry[]>, store: (key: string, entries: RemoteFileEntry[]) => void);
    /**
     * List one directory, or join the request a hover prefetch already started.
     *
     * @param dir - absolute remote directory.
     * @param revision - the explorer revision this read is meant to reflect. A
     *   request issued at another revision is never joined.
     * @param fresh - start a new request even when one is in flight (a
     *   revalidation after a write, where joining the older read would be wrong).
     */
    request(dir: string, revision: number, fresh?: boolean): Promise<RemoteFileEntry[]>;
    /** Whether a listing for `dir` is on the wire. */
    busy(dir: string): boolean;
}
