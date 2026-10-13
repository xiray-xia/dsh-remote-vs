/**
 * Client half of dsh-remote-vs (Turn C): the explorer (four sub-views:
 * workspaces / files / terminal / git over /api/dsh-remote) on exactly one
 * surface — the better-sidebar tab when that plugin is installed, else a
 * native right-Sidebar page (same root, guide entry). Host management lives
 * in the DSH Settings dialog (`settings.section` entry). Phase 4 also
 * shadows the native directory-flow holes (Local/Remote dialog).
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-better-sidebar'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { RemoteDirectoryFlow } from './DirectoryFlow.tsx'
import { registerNativeExplorer } from './NativeExplorer.tsx'
import { RemoteRoot } from './RemoteRoot.tsx'
import { SettingsHostsSection, SettingsWorkspacesSection } from './SettingsHosts.tsx'
import { detectLang, makeT } from './i18n.ts'

/** Services required before mounting (slots/uiWorkspace are core web services). */
export const inject = ['slots', 'uiWorkspace']

function RemoteIcon({ size }: { size?: number }): React.ReactNode {
  const s = size ?? 16
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" aria-hidden="true" style={{ display: 'block' }}>
      <rect x="1" y="1" width="14" height="14" rx="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <text x="3.2" y="11.6" fontFamily="monospace" fontSize="7.5" fontWeight="bold" fill="currentColor">&gt;_</text>
    </svg>
  )
}

/** Client plugin body. */
export function apply(ctx: Context): void {
  // Explorer surface, exactly one of two: the better-sidebar tab when that
  // plugin is installed, else a native right-Sidebar page (same root, guide
  // entry). No load-order edge exists (client inject metadata is
  // prefetch-only), so poll for a late better-sidebar arrival, accelerated
  // by the loader-settle signal when the client exposes it. The decision
  // commits once per page load — a later arrival never flips the surface
  // (flipping would drop connected terminals and open editors).
  const nativeT = makeT(detectLang())
  ctx.effect(() => {
    let disposeBetter: (() => void) | undefined
    let disposeNative: (() => void) | undefined
    let timer: ReturnType<typeof setInterval> | undefined
    let tries = 0
    let done = false
    const stopTimer = (): void => {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    }
    const goBetter = (): boolean => {
      if (done) return true
      let sidebar: { registerTab: (def: {
        id: string
        title: () => string
        description: () => string
        icon: (size: number) => React.ReactNode
        order: number
        single: boolean
        component: () => React.ReactNode
      }) => () => void } | undefined
      try {
        sidebar = ctx.get('betterSidebar') ?? undefined
      } catch {
        return false
      }
      if (sidebar === undefined) return false
      try {
        disposeBetter = sidebar.registerTab({
          id: 'remote-vs:explorer',
          title: () => '远程',
          description: () => '远端文件、终端与 Git',
          icon: (size: number) => <RemoteIcon size={size} />,
          order: 30,
          single: true,
          component: () => <RemoteRoot ctx={ctx} />,
        })
      } catch {
        return false
      }
      done = true
      stopTimer()
      return true
    }
    const goNative = (): void => {
      if (done) return
      done = true
      stopTimer()
      // Undefined when the registry is unavailable (older host): stay quiet,
      // directoryFlow + settings work standalone.
      disposeNative = registerNativeExplorer(ctx, nativeT) ?? undefined
    }
    if (!goBetter()) {
      // Early-settle signal: once every profile entry has mounted, a still
      // missing betterSidebar is absent (not slow) — decide immediately
      // instead of burning the full 30s. Soft probe: hosts without a client
      // loader skip this, and the poll below is the whole story.
      try {
        const loader = (ctx as unknown as { get(name: string): unknown }).get('loader') as
          | { await?: () => Promise<unknown> }
          | undefined
        if (typeof loader?.await === 'function') {
          void loader.await().then(
            () => { if (!goBetter()) goNative() },
            () => { /* loader trouble is not absence: keep polling */ },
          )
        }
      } catch {
        // Ignore: the poll below covers it.
      }
      timer = setInterval(() => {
        tries += 1
        if (!goBetter() && tries >= 60) goNative()
      }, 500)
      timer.unref?.()
    }
    return () => {
      stopTimer()
      try {
        disposeBetter?.()
      } catch {
        // Ignore.
      }
      try {
        disposeNative?.()
      } catch {
        // Ignore.
      }
    }
  }, 'dsh-remote-vs: explorer surface (better tab preferred, native fallback)')
  // Phase 4: shadow the stock directory picker in both directory-flow holes
  // (single-kind shadowing: lowest priority renders; stock sits at 0).
  // Nested slots.inject because the ui-workspace entries may activate later
  // or replace their declarations (same pattern as the stock flow packages).
  ctx.effect(() => ctx.slots.inject(
    'conversation.hero.workspace.directoryFlow',
    () => ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
      const injected = {
        listDirectory: (path?: string, signal?: AbortSignal) => ctx.uiWorkspace.listDirectory(path, signal),
        createDirectory: (path: string, name: string) => ctx.uiWorkspace.createDirectory(path, name),
        pickDirectory: () => ctx.uiWorkspace.pickDirectory(),
      }
      yield ctx.slots.register({
        name: 'conversation.hero.workspace.directoryFlow',
        priority: -1,
        inject: () => injected,
      }, RemoteDirectoryFlow)
      yield ctx.slots.register({
        name: 'sidebar.workspaces.directoryFlow',
        priority: -1,
        inject: () => injected,
      }, RemoteDirectoryFlow)
    }),
  ), 'dsh-remote-vs: directory flow')
  // Host management lives in the Settings dialog (list slot: additive, order
  // 20 lands after the stock sections). Self-fetching section, no inject face.
  const settingsT = makeT(detectLang())
  ctx.effect(() => ctx.slots.inject(
    'settings.section',
    () => ctx.slots.register({
      name: 'settings.section',
      id: 'remote-hosts',
      order: 20,
      label: () => settingsT('settings.hosts'),
    }, SettingsHostsSection),
  ), 'dsh-remote-vs: settings hosts')
  ctx.effect(() => ctx.slots.inject(
    'settings.section',
    () => ctx.slots.register({
      name: 'settings.section',
      id: 'remote-workspaces',
      order: 21,
      label: () => settingsT('settings.workspaces'),
    }, SettingsWorkspacesSection),
  ), 'dsh-remote-vs: settings workspaces')
}
