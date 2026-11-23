/**
 * Frame-wide behaviour behind the two view preferences from Settings → 远程主机
 * (`REMOTE_API.viewSettings`):
 *
 *  - `autoOpenRemoteWorkspace` — the first time a session THIS PLUGIN considers
 *    remote appears on screen in this page lifetime, open the plugin's own
 *    right-panel page. Once per session, never for a local session, and never
 *    revisited after a manual close (the "already handled" bookkeeping lives in
 *    this closure and dies with the page);
 *  - `remoteWorkspaceWidthRatio` — when that page is opened, the right column
 *    ends up at that share of the window width (and a save while the panel is
 *    open applies immediately).
 *
 * It lives OUTSIDE every component on purpose: the page it opens is usually
 * CLOSED, so no seat of ours is mounted when the trigger happens — the settings
 * dialog, the conversation view and the explorer tab can all be unmounted while
 * a new remote session appears.
 *
 * "Remote" is decided from this plugin's own knowledge only:
 *  - the on-screen session comes from `ctx.sidebarRight.mounted`, the same
 *    sanctioned source the `@file` buttons use;
 *  - a session is remote when its host-confirmed workspace path — or, failing
 *    that, its live working directory — is one of the alias directories this
 *    plugin materialized for a binding. That is exactly the resolution the click
 *    router already performs (`bindingForSessionCwd`), fed by this plugin's own
 *    `/workspaces` route. No other plugin's API is involved.
 *
 * The width has NO public API in DSH: the supported user path is the column's
 * drag handle, so it is driven there — a synthetic pointer sequence on
 * `[data-side="rightbar"]` (see `resizeRightbar`), with the pointer-capture
 * methods neutralised for exactly one dispatch and restored immediately after
 * (leaving them overridden would break the user's own drag for the rest of the
 * page's life).
 */
import type { Context } from '@deepseek-ai/cordis'
import { clampViewWidthRatio } from '../protocol.ts'
import { api } from './api.ts'
import { NATIVE_TAB_KIND } from './NativeExplorer.tsx'
import { bindingForSessionCwd, type RemoteOpenBindings } from './remote-file-open-target.ts'
import { mountedSessionId, workspacePathOf } from './use-remote-chat-target.ts'
import { currentViewSettings, loadViewSettings, subscribeViewSettings } from './view-settings.ts'

/** The column's drag handle: the only supported way to set its width. */
const RIGHTBAR_HANDLE = '[data-side="rightbar"]'
/** The column element, on DSH releases that tag it (else the frame's grid is read). */
const RIGHTBAR_COLUMN = '[data-rightbar-col]'
/** DSH's own bounds for the column; mirrored so the target is where a drag would land. */
const RIGHTBAR_MIN_WIDTH = 300
const RIGHTBAR_MAX_RATIO = 0.7
/** On-screen session poll (the `mounted` feed is read per tick, not subscribed). */
const POLL_MS = 1_500
/** Retry period while the host cannot answer the preferences at all. */
const SETTINGS_RETRY_MS = 10_000
/** Frames the newly opened panel may take to render its handle (~10 s at 60 fps). */
const HANDLE_FRAME_BUDGET = 600
/** Attempts at proving one session remote before the answer is "not proven". */
const CLASSIFY_ATTEMPTS = 10
/** How long one `/workspaces` answer is reused while it lists bindings. */
const BINDINGS_TTL_MS = 30_000

/** The narrow slice of `ctx.sidebarRight` this module touches (soft read). */
interface SidebarRightLike {
  openTab?: (kind: string) => void
  isExpanded?: () => boolean
  /** Active tab of the active pane (record shape: `{ id, kind, … }`). */
  active?: () => { kind?: string } | undefined
}

/** This plugin's right-panel face, or `undefined` on a host without the seat. */
function softSidebarRight(ctx: Context): SidebarRightLike | undefined {
  try {
    const raw = (ctx as unknown as { get(name: string): unknown }).get('sidebarRight')
    return typeof raw === 'object' && raw !== null ? (raw as SidebarRightLike) : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether this plugin's own page is the tab the right column is showing.
 *
 * The column is ONE panel shared by every sidebar page, so a width that belongs
 * to the remote workspace may only be committed while the remote workspace is
 * the page on screen; any other answer leaves the panel alone.
 */
function ownTabActive(ctx: Context): boolean {
  try {
    return softSidebarRight(ctx)?.active?.()?.kind === NATIVE_TAB_KIND
  } catch {
    return false
  }
}

/**
 * Install the behaviour; returns the teardown for the client entry's effect.
 *
 * @param ctx - client plugin context (only soft service reads).
 */
export function installAutoOpenRemote(ctx: Context): () => void {
  /** Sessions this page lifetime already decided about — never revisited. */
  const decided = new Set<string>()
  /** Sessions being classified right now (one probe per session at a time). */
  const deciding = new Set<string>()
  /** Spend so far on sessions that could not be classified yet. */
  const attempts = new Map<string, number>()
  /** Binding table from the plugin's own `/workspaces` route (bounded reuse). */
  let bindings: RemoteOpenBindings | undefined
  let bindingsAt = 0
  /** Next time a failed preferences load may be retried. */
  let settingsRetryAt = 0
  /** Cancels the handle poll of a superseded width change. */
  let pollToken = 0
  let disposed = false
  let lastRatio = currentViewSettings()?.remoteWorkspaceWidthRatio
  let timer: ReturnType<typeof setInterval> | undefined

  /** Binding table, refetched when stale or when it lists nothing (a new workspace). */
  const openBindings = async (): Promise<RemoteOpenBindings | undefined> => {
    if (bindings !== undefined && bindings.bindings.length > 0 && Date.now() - bindingsAt < BINDINGS_TTL_MS) {
      return bindings
    }
    try {
      const answer = await api.getWorkspaces()
      bindings = { bindings: answer.workspaces, aliasPaths: answer.aliasPaths }
      bindingsAt = Date.now()
      return bindings
    } catch {
      // An older host answers 404 for the route, a broken host nothing: either
      // way the answer is "cannot prove", never "not remote".
      bindings = undefined
      return undefined
    }
  }

  /**
   * Prove whether one session works in a remote workspace.
   *
   * `remote`/`local` are proofs; `unknown` means it cannot be decided YET (host
   * down, the workspaces service still settling) and the caller may retry.
   */
  const classify = async (sessionId: string): Promise<'remote' | 'local' | 'unknown'> => {
    const table = await openBindings()
    if (table === undefined) return 'unknown'
    // No binding at all: nothing on this profile can be remote.
    if (table.bindings.length === 0) return 'local'
    const workspace = workspacePathOf(ctx, sessionId)
    if (workspace !== undefined) {
      // The host's own workspace membership is the strongest evidence: a remote
      // session's workspace IS the alias directory of exactly one binding.
      return bindingForSessionCwd(table, workspace) !== undefined ? 'remote' : 'local'
    }
    // No membership (or the workspaces service is not ready yet): the session's
    // own cwd is the last resort, the same order `followSessionWorkspace` uses.
    let cwd: string | undefined
    try {
      cwd = (await api.sessionCwd(sessionId)).cwd
    } catch {
      return 'unknown'
    }
    if (cwd === undefined || cwd === '') return 'unknown'
    return bindingForSessionCwd(table, cwd) !== undefined ? 'remote' : 'local'
  }

  /** Poll for the drag handle, then move the column to `ratio` of the frame. */
  const applyWidth = (ratio: number): void => {
    const token = (pollToken += 1)
    let frames = HANDLE_FRAME_BUDGET
    const step = (): void => {
      if (disposed || token !== pollToken) return
      const handle = document.querySelector<HTMLElement>(RIGHTBAR_HANDLE)
      // Only ever resize the column while THIS plugin's page is the one on
      // screen: the right column is shared with every other sidebar page (the
      // local workbench among them), and a width meant for the remote workspace
      // must not restyle a panel showing something else.
      if (handle !== null && ownTabActive(ctx) && resizeRightbar(handle, ratio)) return
      frames -= 1
      // The panel renders its handle in the frame it becomes visible, so a poll
      // corrects a restored panel immediately instead of on a timer.
      if (frames > 0) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  /**
   * Open this plugin's own right-panel page, then size it.
   *
   * @returns false when there was nothing to open — the seat has not mounted
   *   this session's surface yet, the better-sidebar surface owns the tab, or an
   *   older host never registered our page. The caller retries within its budget
   *   and then gives up (a permanent "no page of ours" must not be fought).
   */
  const openPage = (ratio: number): boolean => {
    const sidebar = softSidebarRight(ctx)
    if (typeof sidebar?.openTab !== 'function') return false
    try {
      sidebar.openTab(NATIVE_TAB_KIND)
    } catch {
      return false
    }
    applyWidth(ratio)
    return true
  }

  /**
   * Record one pass that could not decide; after {@link CLASSIFY_ATTEMPTS} the
   * session is treated as "not ours" so it is never probed for the whole page's
   * lifetime. The safe answer is always the one that does not open a panel.
   */
  const noteAttempt = (sessionId: string): void => {
    const spent = (attempts.get(sessionId) ?? 0) + 1
    if (spent < CLASSIFY_ATTEMPTS) {
      attempts.set(sessionId, spent)
      return
    }
    attempts.delete(sessionId)
    decided.add(sessionId)
  }

  /** Decide one session, once. */
  const decide = async (sessionId: string): Promise<void> => {
    deciding.add(sessionId)
    try {
      const kind = await classify(sessionId)
      if (disposed) return
      if (kind === 'unknown') {
        noteAttempt(sessionId)
        return
      }
      attempts.delete(sessionId)
      decided.add(sessionId)
      if (kind !== 'remote') return
      // The setting is read again here: it may have been saved while the
      // session was being classified.
      const settings = currentViewSettings()
      if (settings?.autoOpenRemoteWorkspace !== true) return
      if (openPage(settings.remoteWorkspaceWidthRatio)) return
      // The page could not be opened yet (the session's surface may still be
      // minting): undo the decision and retry on a later pulse.
      decided.delete(sessionId)
      noteAttempt(sessionId)
    } finally {
      deciding.delete(sessionId)
    }
  }

  /** One on-screen-session pulse. */
  const tick = (): void => {
    if (disposed) return
    const sessionId = mountedSessionId(ctx)
    if (sessionId === undefined || decided.has(sessionId) || deciding.has(sessionId)) return
    if (currentViewSettings() === undefined) {
      // The host may not be up yet (or is an older build without the route):
      // retry at a human pace instead of every tick, and never guess the answer.
      const now = Date.now()
      if (now >= settingsRetryAt) {
        settingsRetryAt = now + SETTINGS_RETRY_MS
        void loadViewSettings(true)
      }
      return
    }
    void decide(sessionId)
  }

  // A SAVE is an explicit user request: when the panel is already open, the new
  // share applies in place. A load (page start, or the retry after a failed one)
  // must not resize a panel the user opened by hand, and a save that leaves the
  // share alone (the auto-open toggle) must not touch the panel either.
  const unsubscribe = subscribeViewSettings((next, source) => {
    const previous = lastRatio
    lastRatio = next.remoteWorkspaceWidthRatio
    if (source !== 'save' || previous === next.remoteWorkspaceWidthRatio) return
    const sidebar = softSidebarRight(ctx)
    // Expanded is not enough: the column may be showing another plugin's page
    // (the local workbench among them), and its width is not ours to change.
    if (typeof sidebar?.isExpanded === 'function' && sidebar.isExpanded() && ownTabActive(ctx)) {
      applyWidth(next.remoteWorkspaceWidthRatio)
    }
  })

  void loadViewSettings()
  timer = setInterval(tick, POLL_MS)
  timer.unref?.()

  return () => {
    disposed = true
    pollToken += 1
    unsubscribe()
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

/**
 * Move the right column to `ratio` of the frame width through the drag handle.
 *
 * A drag commits `setRightbar(base - dx)` with `base` measured at pointer-down,
 * so one synthetic down/up pair whose clientX delta is `current - target` lands
 * exactly on `target` (DSH clamps the column itself, but the target is clamped
 * here too so a narrow window cannot ask for the impossible).
 */
function resizeRightbar(handle: HTMLElement, ratio: number): boolean {
  const viewport = document.documentElement.clientWidth
  if (viewport <= 0) return false
  const target = Math.min(
    Math.max(Math.round(viewport * clampViewWidthRatio(ratio)), RIGHTBAR_MIN_WIDTH),
    Math.max(RIGHTBAR_MIN_WIDTH, Math.round(viewport * RIGHTBAR_MAX_RATIO)),
  )
  const current = currentRightbarWidth(handle, viewport)
  if (current === undefined) return false
  const dx = Math.round(current) - target
  if (Math.abs(dx) < 1) return true
  const origin = Math.round(handle.getBoundingClientRect().left)
  withNeutralPointerCapture(handle, () => {
    withoutTrackTransition(handle, () => {
      dispatchPointer(handle, 'pointerdown', origin)
      dispatchPointer(handle, 'pointerup', origin + dx)
    })
  })
  return true
}

/**
 * The width the drag will commit AGAINST (`base` in `setRightbar(base - dx)`).
 *
 * First choice is the handle's own `left`: DSH positions it at
 * `viewport - normal.rightbar`, which IS the base a pointer-down measures, so it
 * stays exact even while the column animates or is clamped narrower than the
 * committed value. Then the rendered width, from the tagged column (releases
 * that mark it), the frame's resolved third grid track (the column IS that
 * track, and computed values are resolved pixels), and finally the handle's
 * geometry — the 8 px handle is centred on the column's inner edge, so its left
 * edge sits at `viewport - width - 4`.
 */
function currentRightbarWidth(handle: HTMLElement, viewport: number): number | undefined {
  const positioned = Number.parseFloat(handle.style.left)
  if (Number.isFinite(positioned) && positioned >= 0 && positioned <= viewport) {
    const width = viewport - positioned
    // A reading below the plausible minimum means the column has not settled
    // yet (a restored panel animating in). Treating it as the base turns the
    // delta into a huge overshoot that lands on DSH's 70 % clamp — the panel
    // then opens far wider than the configured share (2026-11-23 report).
    if (width >= RIGHTBAR_MIN_WIDTH / 2) return width
  }
  const column = document.querySelector<HTMLElement>(RIGHTBAR_COLUMN)
  if (column !== null) {
    const width = column.getBoundingClientRect().width
    if (width > 0) return width
  }
  const frame = handle.parentElement
  if (frame !== null) {
    const tracks = getComputedStyle(frame).gridTemplateColumns.trim().split(/\s+/)
    const track = tracks[tracks.length - 1]
    const width = track === undefined ? Number.NaN : Number.parseFloat(track)
    if (Number.isFinite(width) && width > 0) return width
  }
  const fallback = viewport - handle.getBoundingClientRect().left - 4
  return fallback > 0 ? fallback : undefined
}

/** Dispatch one pointer event the drag handle's own handlers accept. */
function dispatchPointer(handle: HTMLElement, type: 'pointerdown' | 'pointerup', clientX: number): void {
  const rect = handle.getBoundingClientRect()
  handle.dispatchEvent(new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    buttons: type === 'pointerdown' ? 1 : 0,
    clientX,
    clientY: Math.round(rect.top + rect.height / 2),
  }))
}

/** Pointer-capture methods replaced for one dispatch and then removed again. */
const CAPTURE_METHODS = ['setPointerCapture', 'hasPointerCapture', 'releasePointerCapture'] as const

/**
 * Run one synthetic drag with the pointer-capture API neutralised.
 *
 * The handle captures the pointer on `pointerdown` (`setPointerCapture`), which
 * throws for an id no real pointer owns — a synthetic pointer can never become
 * the capture target. The three methods are therefore replaced for the duration
 * of ONE dispatch and removed immediately afterwards: leaving them overridden on
 * the handle would break the user's own drag for the rest of the page's life.
 */
function withNeutralPointerCapture(handle: HTMLElement, run: () => void): void {
  const saved = CAPTURE_METHODS.map(name => Object.getOwnPropertyDescriptor(handle, name))
  for (const name of CAPTURE_METHODS) {
    Object.defineProperty(handle, name, {
      configurable: true,
      writable: true,
      // A capture that is not held answers false; the setters are no-ops.
      value: name === 'hasPointerCapture' ? () => false : () => undefined,
    })
  }
  try {
    run()
  } finally {
    CAPTURE_METHODS.forEach((name, index) => {
      const previous = saved[index]
      if (previous === undefined) Reflect.deleteProperty(handle, name)
      else Object.defineProperty(handle, name, previous)
    })
  }
}

/**
 * Commit the width without DSH's track animation sweeping the column.
 *
 * The frame animates `grid-template-columns` while it switches tracks, so a
 * programmatic width landing mid-animation would animate too. The frame (and the
 * tagged column, when the release has one) is pinned to `transition: none` for
 * the dispatch and restored on the next frame.
 */
function withoutTrackTransition(handle: HTMLElement, run: () => void): void {
  const frame = handle.parentElement
  const column = document.querySelector<HTMLElement>(RIGHTBAR_COLUMN)
  const targets: HTMLElement[] = []
  for (const candidate of [frame, column]) {
    if (candidate instanceof HTMLElement) targets.push(candidate)
  }
  if (targets.length === 0) {
    run()
    return
  }
  const previous = targets.map(target => target.style.transition)
  for (const target of targets) target.style.transition = 'none'
  run()
  requestAnimationFrame(() => {
    targets.forEach((target, index) => {
      target.style.transition = previous[index] ?? ''
    })
  })
}
