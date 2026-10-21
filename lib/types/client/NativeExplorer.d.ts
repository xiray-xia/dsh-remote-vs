/**
 * Native right-Sidebar fallback surface: the same explorer RemoteRoot as the
 * better-sidebar tab, registered as a native page type when better-sidebar
 * is not installed (the decision lives in index.tsx; the two surfaces are
 * mutually exclusive — two mounted roots would split terminal/editor state).
 *
 * Two-stage registration, the public path every tab type uses (see
 * dsh-client-ui-sidebar-files):
 * 1. `sidebarRightTabs.register` — the static type (page kind, opened by
 *    kind; `priority` defaults to `extension`, the band for types from
 *    outside the product). `keepMounted` keeps visited bodies alive through
 *    hiding/session switches so terminals survive.
 * 2. `sidebar.right.pane.tab` keyed seat body under the definition's `id`.
 *    The title seat is skipped: the chip shows the registry `title()`.
 *
 * Per-session instances: the native surface mounts one body per session
 * seat that opened the page (the official files tab works the same way) —
 * open files and connected terminals do not cross sessions. The body reads
 * the seat's `useTabInfo` hook (delivered by the seat inject face
 * `hooks.tabInfo`, no custom inject needed) and forwards `tab.visible` so
 * canvas views refit on reveal.
 *
 * All service reads are soft (`ctx.get`, never direct property access —
 * direct reads throw without inject, see MAINTENANCE §6). Missing registry
 * answers `undefined` (caller stays quiet, settings + native directory flow
 * still work standalone).
 */
import type { Context } from '@deepseek-ai/cordis';
/** Tab-system identity (also the body seat key). */
export declare const NATIVE_TAB_ID = "dsh-remote-vs";
/** Type discriminator `openTab` names. */
export declare const NATIVE_TAB_KIND = "remote-vs-explorer";
/**
 * Register the native explorer page. Returns the combined disposer, or
 * `undefined` when the registry is unavailable (older host) or the id is
 * taken (never partially registered — a type failure returns before the
 * seat step runs).
 */
export declare function registerNativeExplorer(ctx: Context, t: (k: string) => string): (() => void) | undefined;
