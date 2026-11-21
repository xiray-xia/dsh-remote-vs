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
import type { Context } from '@deepseek-ai/cordis';
/**
 * Install the behaviour; returns the teardown for the client entry's effect.
 *
 * @param ctx - client plugin context (only soft service reads).
 */
export declare function installAutoOpenRemote(ctx: Context): () => void;
