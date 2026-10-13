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
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {
  SidebarRightTabDefinition,
  UseSidebarRightTabInfo,
} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ReactNode } from 'react'
import { RemoteRoot } from './RemoteRoot.tsx'

/**
 * Structural slice of the tab registry we touch (`register` only — the
 * registry class itself is not exported from the package's client types,
 * only the definition/key types are).
 */
interface TabRegistryLike {
  register(definition: SidebarRightTabDefinition): () => void
}

/** Tab-system identity (also the body seat key). */
export const NATIVE_TAB_ID = 'dsh-remote-vs'
/** Type discriminator `openTab` names. */
export const NATIVE_TAB_KIND = 'remote-vs-explorer'

/**
 * Register the native explorer page. Returns the combined disposer, or
 * `undefined` when the registry is unavailable (older host) or the id is
 * taken (never partially registered — a type failure returns before the
 * seat step runs).
 */
export function registerNativeExplorer(ctx: Context, t: (k: string) => string): (() => void) | undefined {
  let registry: TabRegistryLike | undefined
  try {
    const raw: unknown = ctx.get('sidebarRightTabs')
    registry = (typeof raw === 'object' && raw !== null ? raw : undefined) as
      | TabRegistryLike
      | undefined
    if (typeof registry?.register !== 'function') return undefined
  } catch {
    return undefined
  }
  const definition: SidebarRightTabDefinition = {
    id: NATIVE_TAB_ID,
    kind: NATIVE_TAB_KIND,
    keepMounted: true,
    title: () => t('native.tab'),
    guide: [{
      id: 'remote',
      order: 30,
      title: () => t('native.guide.title'),
      description: () => t('native.guide.desc'),
    }],
  }
  let disposeType: (() => void) | undefined
  try {
    disposeType = registry.register(definition)
  } catch (error) {
    console.warn('[dsh-remote-vs] native explorer registration failed:', error)
    return undefined
  }
  // Seat body: per-registration closure (carries ctx) over the seat's
  // useTabInfo hook (carries visibility). Registered once per fiber
  // lifetime; the effect disposer below owns both halves.
  const Body = (props: { useTabInfo: UseSidebarRightTabInfo }): ReactNode => {
    const { tab } = props.useTabInfo()
    return <RemoteRoot ctx={ctx} visible={tab.visible} />
  }
  let disposeSeat: (() => void) | undefined
  try {
    disposeSeat = ctx.slots.inject(
      'sidebar.right.pane.tab',
      () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: NATIVE_TAB_ID }, Body),
    )
  } catch (error) {
    console.warn('[dsh-remote-vs] native explorer seat registration failed:', error)
    try {
      disposeType?.()
    } catch {
      // Ignore.
    }
    return undefined
  }
  return () => {
    try {
      disposeSeat?.()
    } catch {
      // Ignore.
    }
    try {
      disposeType?.()
    } catch {
      // Ignore.
    }
  }
}
