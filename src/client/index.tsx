/**
 * Client half of dsh-remote-vs (Turn C): the explorer (four sub-views:
 * workspaces / files / terminal / git over /api/dsh-remote) on exactly one
 * surface — the better-sidebar tab when that plugin is installed, else a
 * native right-Sidebar page (same root, guide entry). Host management lives
 * in the DSH Settings dialog (`settings.section` entry). Phase 4 also
 * shadows the native directory-flow holes (Local/Remote dialog).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
// No `dsh-better-sidebar` type import on purpose: that package is an OPTIONAL
// runtime integration, and depending on its types pulled its own aging
// @deepseek-ai/dsh-* chain into this repo — which dragged a second copy of
// schemastery/cordis in and broke the declaration build (TS2742 on `Config`).
// The service is soft-read through an untyped getter instead, exactly like
// `conversation` and `sidebarRightTabs` above.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import './vsc/vsc.css'
import { RemoteDirectoryFlow } from './DirectoryFlow.tsx'
import { registerNativeExplorer } from './NativeExplorer.tsx'
import { installRemoteFileOpen } from './remote-file-open.ts'
import { RemoteEditorView } from './RemoteEditorView.tsx'
import { RemoteRoot } from './RemoteRoot.tsx'
import { ChangesDock, type ChangesDockProps } from './changes/ChangesDock.tsx'
import { SettingsHostsSection, SettingsWorkspacesSection } from './SettingsHosts.tsx'
import { setEditorSurface } from './store.tsx'
import { detectLang, makeT } from './i18n.ts'
import { setIconService, type IconServiceLike } from './vsc/kit.tsx'

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
        sidebar = ((ctx as unknown as { get(name: string): unknown }).get('betterSidebar') ?? undefined) as typeof sidebar
      } catch {
        return false
      }
      if (sidebar === undefined) return false
      // The host icon classifier paints the remote tree with the same glyphs
      // the local sidebar uses (and honours any registered icon theme). It is
      // optional: without it the built-in SVG set takes over.
      try {
        const candidate = sidebar as unknown as Partial<IconServiceLike>
        if (typeof candidate.fileIcon === 'function' && typeof candidate.folderIcon === 'function') {
          setIconService(candidate as IconServiceLike)
        }
      } catch {
        // Ignore: icons fall back to the built-in set.
      }
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
  // Session change panel: the full-width seat above the composer card (the one
  // the todo / goal / queue panels already use), so the files this session
  // touched stay visible while the next instruction is typed. Soft-typed like
  // `conversation.view` below — the slot contract lives in
  // dsh-client-ui-conversation, which is not a dependency of this repo.
  ctx.effect(() => {
    let dispose: (() => void) | undefined
    try {
      const slots = ctx.slots as unknown as {
        inject(slot: string, register: () => () => void): () => void
        register(
          options: { name: string; id: string; order: number },
          component: (props: ChangesDockProps) => ReactNode,
        ): () => void
      }
      dispose = slots.inject('conversation.input.dock', () => slots.register({
        name: 'conversation.input.dock',
        id: 'remote-changes',
        // After todo (0), goal (10) and queue (20); before the git-graph entry.
        order: 30,
      }, ChangesDock))
    } catch (error) {
      console.warn('[dsh-remote-vs] conversation.input.dock registration failed:', error)
      return () => {}
    }
    return () => {
      try {
        dispose?.()
      } catch {
        // Ignore.
      }
    }
  }, 'dsh-remote-vs: session changes dock')
  // Click routing for file references inside remote sessions: the chat's file
  // chips / deliverables / files-tree clicks all pass through
  // `ctx.sidebarRight.openResource`, and DSH's own preview resolves them
  // against the session workspace root — an empty alias dir for us. Install
  // the wrapper early (it polls for the service) so every surface is covered;
  // local sessions and unknown addresses keep the native behaviour.
  ctx.effect(() => installRemoteFileOpen(ctx), 'dsh-remote-vs: remote file click routing')
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
  // The editor tab in the conversation view (right next to 对话 / 轨迹): at
  // full width the file editor and the side-by-side diff stop competing with
  // the tree for a narrow sidebar column. The store then flips the editor
  // surface to 'center' and the sidebar keeps the whole column for browsing.
  // A host without this slot keeps the old sidebar split (nothing disappears).
  //
  // `conversation.view` is a runtime slot whose TYPE comes from
  // dsh-better-sidebar's declarations — and depending on that package for types
  // dragged its aging @deepseek-ai/dsh-* chain (and a second copy of zod, which
  // made TypeScript run out of heap) into this repo. It is soft-registered
  // through a narrow local signature instead: the try/catch below is both the
  // runtime check and the documented fallback for a host without the slot.
  const viewT = makeT(detectLang())
  ctx.effect(() => {
    let dispose: (() => void) | undefined
    try {
      const slots = ctx.slots as unknown as {
        inject(slot: string, register: () => () => void): () => void
        register(
          options: { name: string; id: string; order: number; label: () => string },
          component: () => ReactNode,
        ): () => void
      }
      dispose = slots.inject('conversation.view', () => slots.register({
        name: 'conversation.view',
        id: 'remote-editor',
        order: 30,
        label: () => viewT('view.editor'),
      }, () => <RemoteEditorView ctx={ctx} />))
    } catch (error) {
      console.warn('[dsh-remote-vs] conversation.view registration failed:', error)
      return () => {}
    }
    setEditorSurface('center')
    return () => {
      setEditorSurface('sidebar')
      try {
        dispose?.()
      } catch {
        // Ignore.
      }
    }
  }, 'dsh-remote-vs: conversation view (editor + diff)')
}
