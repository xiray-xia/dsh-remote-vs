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

/** Take everything queued; the caller attaches it and the queue starts over. */
export function drainHostNotices(): HostNotice[] {
  if (pending.length === 0) return []
  const drained = pending
  pending = []
  return drained
}
