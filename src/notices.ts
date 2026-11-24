/**
 * One-shot notices the Host hands to the browser on the next JSON response.
 *
 * Why a queue instead of a push channel: the Host half is request/response, and
 * an event that matters (an automatic helper push) is produced *inside* a
 * request the browser already made — the remote operation that needed a dial.
 * Attaching the notice to that response reaches the surface that caused it with
 * no extra connection, and a queue means a push during a streaming response or
 * a failed request still arrives on the next successful one.
 */
export interface HostNotice {
  /** What happened. Only kinds the client knows how to render belong here. */
  kind: 'helper-pushed'
  /** Host alias the helper was pushed to. */
  alias: string
  /** Helper version that was installed. */
  version: string
}

/** Bounded so an unreachable client cannot grow Host memory without limit. */
const MAX_PENDING = 8

let pending: HostNotice[] = []

/** Queue one notice for the next JSON response. */
export function pushHostNotice(notice: HostNotice): void {
  if (pending.length >= MAX_PENDING) return
  pending = [...pending, notice]
}

/**
 * Take the notices queued for ONE host alias.
 *
 * A response only reports news about the host it is about. Draining the whole
 * queue from whichever response was written first delivered host A's helper
 * push into a window looking at host B — and consumed it, so A never saw it.
 * Notices for other aliases stay queued for a response about their host.
 */
export function takeHostNotices(alias: string): HostNotice[] {
  if (pending.length === 0) return []
  const taken = pending.filter(notice => notice.alias === alias)
  if (taken.length === 0) return []
  pending = pending.filter(notice => notice.alias !== alias)
  return taken
}

/**
 * Take everything queued (no host filtering).
 *
 * Kept for callers that own the whole queue — the offline probes reset it, and
 * a response written OUTSIDE the route table has no host to filter by
 * (`src/http.ts` keeps that historical drain-all answer).
 */
export function drainHostNotices(): HostNotice[] {
  if (pending.length === 0) return []
  const drained = pending
  pending = []
  return drained
}
