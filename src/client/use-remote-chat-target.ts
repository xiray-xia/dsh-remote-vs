/**
 * The session↔binding gate behind the remote `@file` buttons and the
 * selection popup: which session is on screen, and which host-confirmed
 * workspace it belongs to. Views compare the workspace path against their
 * binding's `aliasPaths` entry (see `sameLocalDir`) and disable insertion
 * on mismatch — a remote-relative mention (`@foo/bar.ts`) names nothing in
 * a session that does not live in that binding, so guessing would corrupt
 * the draft.
 *
 * The on-screen session comes from `ctx.sidebarRight.mounted` (the only
 * sanctioned source — the session-list snapshot carries no current-session
 * field in any DSH release; verified present in 0.2.1's
 * dsh-client-ui-sidebar-right). The workspace membership comes from the
 * `workspaces` service list snapshot (`WorkspaceView.path` + `sessionIds`,
 * matched by exact membership — never the session cwd: DSH's `@` grammar
 * is workspace-root relative). Both reads are soft: a missing service
 * answers `undefined` (buttons disabled), never a crash.
 */
import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'

export interface RemoteChatTarget {
  /** The session on screen, or undefined while none is mounted. */
  sessionId: string | undefined
  /** The canonical host dir of the workspace that session belongs to. */
  sessionWorkspacePath: string | undefined
}

type SubscribeFn = (listener: () => void) => () => void

function asSubscribe(value: unknown): SubscribeFn | undefined {
  return typeof value === 'function' ? (value as SubscribeFn) : undefined
}

/** The on-screen session id, or undefined (no seat mounted / no feed). */
function mountedSessionId(ctx: Context): string | undefined {
  try {
    const get = (ctx as unknown as { get?(name: string): unknown }).get
    if (typeof get !== 'function') return undefined
    const mounted = (get.call(ctx, 'sidebarRight') as { mounted?: { getSnapshot?: unknown } } | undefined)?.mounted
    const snapshot = typeof mounted?.getSnapshot === 'function'
      ? (mounted.getSnapshot as () => unknown).call(mounted)
      : undefined
    return typeof snapshot === 'string' ? snapshot : undefined
  } catch {
    return undefined
  }
}

/** Host-confirmed workspace path for one session (exact membership). */
function workspacePathOf(ctx: Context, sessionId: string): string | undefined {
  try {
    const get = (ctx as unknown as { get?(name: string): unknown }).get
    if (typeof get !== 'function') return undefined
    const list = (get.call(ctx, 'workspaces') as { list?: { getSnapshot?: unknown } } | undefined)?.list
    if (typeof list?.getSnapshot !== 'function') return undefined
    const snapshot = (list.getSnapshot as () => unknown).call(list) as {
      phase?: unknown
      state?: unknown
      items?: readonly { path?: unknown; sessionIds?: unknown }[]
    } | undefined
    if (snapshot?.phase !== 'ready' || snapshot?.state !== 'idle') return undefined
    if (!Array.isArray(snapshot.items)) return undefined
    const hit = snapshot.items.find(item =>
      Array.isArray(item.sessionIds) && (item.sessionIds as unknown[]).includes(sessionId))
    return typeof hit?.path === 'string' ? hit.path : undefined
  } catch {
    return undefined
  }
}

function readTarget(ctx: Context): RemoteChatTarget {
  const sessionId = mountedSessionId(ctx)
  if (sessionId === undefined) return { sessionId: undefined, sessionWorkspacePath: undefined }
  return { sessionId, sessionWorkspacePath: workspacePathOf(ctx, sessionId) }
}

/** Subscribe to the mounted-seat feed (session-list pulse as fallback) plus the workspaces list. */
function subscribeTarget(ctx: Context, listener: () => void): () => void {
  const disposers: Array<() => void> = []
  const sessionsListSubscribe = (): void => {
    try {
      // Soft read ONLY: direct `ctx.sessions` throws without inject (see
      // composer.ts sessionScope); `ctx.get` has no such requirement.
      const sessions = (ctx as unknown as { get(name: string): unknown }).get('sessions') as
        | { list?: { subscribe?: unknown } }
        | undefined
      const list = sessions?.list
      if (typeof list?.subscribe === 'function') {
        disposers.push((list.subscribe as SubscribeFn).bind(list)(listener))
      }
    } catch {
      // No pulse: the snapshot read below still answers the current value.
    }
  }
  try {
    const get = (ctx as unknown as { get?(name: string): unknown }).get
    const mounted = (typeof get === 'function'
      ? (get.call(ctx, 'sidebarRight') as { mounted?: { subscribe?: unknown } } | undefined)?.mounted
      : undefined)
    const subscribe = typeof mounted?.subscribe === 'function'
      ? asSubscribe((mounted.subscribe as SubscribeFn).bind(mounted))
      : undefined
    if (subscribe !== undefined) disposers.push(subscribe(listener))
    else sessionsListSubscribe()
  } catch {
    sessionsListSubscribe()
  }
  try {
    const get = (ctx as unknown as { get?(name: string): unknown }).get
    const list = (typeof get === 'function'
      ? (get.call(ctx, 'workspaces') as { list?: { subscribe?: unknown } } | undefined)?.list
      : undefined)
    if (typeof list?.subscribe === 'function') {
      disposers.push((list.subscribe as SubscribeFn).call(list, listener))
    }
  } catch {
    // Membership changes then surface on the next seat/list pulse.
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Ignore.
      }
    }
  }
}

/**
 * Live chat target for remote reference insertion. Snapshot-cached (stable
 * identity while the values stand) for `useSyncExternalStore`.
 *
 * `ctx` is optional because the shared explorer store boots asynchronously:
 * before it is installed the buttons simply stay disabled.
 */
export function useRemoteChatTarget(ctx: Context | undefined): RemoteChatTarget {
  const cacheRef = useRef<RemoteChatTarget>({ sessionId: undefined, sessionWorkspacePath: undefined })
  const subscribe = useCallback(
    (listener: () => void) => (ctx === undefined ? () => {} : subscribeTarget(ctx, listener)),
    [ctx],
  )
  const getSnapshot = useCallback(() => {
    if (ctx === undefined) return cacheRef.current
    const next = readTarget(ctx)
    const prev = cacheRef.current
    if (prev.sessionId === next.sessionId && prev.sessionWorkspacePath === next.sessionWorkspacePath) return prev
    cacheRef.current = next
    return next
  }, [ctx])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
