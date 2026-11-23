/**
 * Whether this page has ANY seat that can render the plugin's editor.
 *
 * Why not "is an `EditorPane` mounted right now": the editor panels are
 * lazy/keep-alive (the sidebar's editor page is only rendered after the rail has
 * visited it, and the conversation-view seat only exists while its host tab is
 * selected). That made the first file click after a page load fall back to the
 * host's native preview — which cannot resolve remote paths at all — even though
 * our editor was one click away. The question the interceptor must answer is
 * "could this file be shown in our editor in this page", i.e. a seat exists.
 *
 * Seats are registered exactly where a surface is registered:
 *  - the better-sidebar tab (`index.tsx` `goBetter`),
 *  - the native right-sidebar page (`registerNativeExplorer` returning a
 *    disposer),
 *  - the conversation-view tab (`conversation.view` registration).
 *
 * Pure module (no React/DOM) so the gate can drive register/unregister.
 */

/** Live seats on this page (0 = nothing of ours can render an editor). */
let seats = 0

/** One seat became available (a tab/view registration succeeded). */
export function noteEditorSeatAvailable(): void {
  seats += 1
}

/** One seat went away (a registration was disposed); never negative. */
export function noteEditorSeatGone(): void {
  seats = Math.max(0, seats - 1)
}

/** How many seats exist right now. */
export function editorSeatCount(): number {
  return seats
}

/** Test-only reset (the gate drives the counter directly). */
export function resetEditorSeatsForTests(): void {
  seats = 0
}
