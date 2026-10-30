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
import type { RemoteFileEntry } from '../protocol.ts'

/** One in-flight listing request and the revision it was issued at. */
interface ListingRequest {
  promise: Promise<RemoteFileEntry[]>
  revision: number
}

export class ListingRequests {
  private readonly inFlight = new Map<string, ListingRequest>()
  /** Newest request per key: only its answer may be stored. */
  private readonly newest = new Map<string, number>()
  private sequence = 0

  /**
   * @param keyOf - cache key for one directory (host alias + absolute path).
   * @param load - performs the listing.
   * @param store - applies a listing whose request is still the newest for its
   *   key; the component writes it into the listing cache.
   */
  constructor(
    private readonly keyOf: (dir: string) => string,
    private readonly load: (dir: string) => Promise<RemoteFileEntry[]>,
    private readonly store: (key: string, entries: RemoteFileEntry[]) => void,
  ) {}

  /**
   * List one directory, or join the request a hover prefetch already started.
   *
   * @param dir - absolute remote directory.
   * @param revision - the explorer revision this read is meant to reflect. A
   *   request issued at another revision is never joined.
   * @param fresh - start a new request even when one is in flight (a
   *   revalidation after a write, where joining the older read would be wrong).
   */
  request(dir: string, revision: number, fresh = false): Promise<RemoteFileEntry[]> {
    const key = this.keyOf(dir)
    const running = this.inFlight.get(key)
    if (!fresh && running !== undefined && running.revision === revision) return running.promise
    const sequence = (this.sequence += 1)
    const promise = this.load(dir)
    const entry: ListingRequest = { promise, revision }
    this.inFlight.set(key, entry)
    this.newest.set(key, sequence)
    const settle = (): void => {
      if (this.inFlight.get(key) === entry) this.inFlight.delete(key)
    }
    promise.then(
      (entries) => {
        if (this.newest.get(key) === sequence) {
          this.newest.delete(key)
          this.store(key, entries)
        }
        settle()
      },
      () => {
        if (this.newest.get(key) === sequence) this.newest.delete(key)
        settle()
      },
    )
    return promise
  }

  /** Whether a listing for `dir` is on the wire. */
  busy(dir: string): boolean {
    return this.inFlight.has(this.keyOf(dir))
  }
}
