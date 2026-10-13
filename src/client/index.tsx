/**
 * Client half of dsh-remote-vs (Turn C): the `remote-vs:explorer` tab with
 * four sub-views (workspaces / files / terminal / git) over /api/dsh-remote.
 * Host management lives in the DSH Settings dialog (`settings.section` entry).
 * Phase 4 also shadows the native directory-flow holes (Local/Remote dialog).
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-better-sidebar'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { useCallback, useEffect, useState } from 'react'
import type { RemoteHostSummary, RemoteRoutingStatus, RemoteWorkspaceBinding } from '../protocol.ts'
import { RemoteApiError, api } from './api.ts'
import { RemoteDirectoryFlow } from './DirectoryFlow.tsx'
import { FilesView } from './FilesView.tsx'
import { GitView } from './GitView.tsx'
import { SettingsHostsSection, SettingsWorkspacesSection } from './SettingsHosts.tsx'
import { TerminalView } from './TerminalView.tsx'
import { WorkspacesView } from './WorkspacesView.tsx'
import { detectLang, makeT } from './i18n.ts'
import { Notice } from './ui.tsx'

/** Services required before mounting (slots/uiWorkspace are core web services). */
export const inject = ['slots', 'uiWorkspace']

type SubTab = 'workspaces' | 'files' | 'terminal' | 'git'

function RemoteIcon({ size }: { size?: number }): React.ReactNode {
  const s = size ?? 16
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" aria-hidden="true" style={{ display: 'block' }}>
      <rect x="1" y="1" width="14" height="14" rx="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <text x="3.2" y="11.6" fontFamily="monospace" fontSize="7.5" fontWeight="bold" fill="currentColor">&gt;_</text>
    </svg>
  )
}

function RemoteRoot(): React.ReactNode {
  const [t] = useState(() => makeT(detectLang()))
  const [tab, setTab] = useState<SubTab>(() => {
    try {
      const saved = localStorage.getItem('dsh-remote-vs.tab')
      // 'hosts' was removed (moved to Settings); fall through to workspaces.
      return saved === 'files' || saved === 'terminal' || saved === 'git' ? saved : 'workspaces'
    } catch {
      return 'workspaces'
    }
  })
  const [hosts, setHosts] = useState<RemoteHostSummary[]>([])
  const [workspaces, setWorkspaces] = useState<RemoteWorkspaceBinding[]>([])
  const [routing, setRouting] = useState<RemoteRoutingStatus>({ mode: 'off', aliasPaths: {}, tombstones: [] })
  const [error, setError] = useState<string | undefined>(undefined)
  const [filesWorkspaceId, setFilesWorkspaceId] = useState<string | undefined>(undefined)

  const refresh = useCallback(() => {
    setError(undefined)
    Promise.all([api.getHosts(), api.getWorkspaces()]).then(
      ([h, w]) => {
        setHosts(h)
        setWorkspaces(w.workspaces)
        setRouting({ mode: w.mode, aliasPaths: w.aliasPaths, tombstones: w.tombstones })
      },
      (e: unknown) => setError(e instanceof RemoteApiError ? e.message : String(e)),
    )
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const switchTab = (next: SubTab): void => {
    setTab(next)
    try {
      localStorage.setItem('dsh-remote-vs.tab', next)
    } catch {
      // Private mode: ignore.
    }
  }

  const tabs: { id: SubTab; label: string }[] = [
    { id: 'workspaces', label: `${t('tab.workspaces')} (${workspaces.length})` },
    { id: 'files', label: t('tab.files') },
    { id: 'terminal', label: t('tab.terminal') },
    { id: 'git', label: t('tab.git') },
  ]

  return (
    <div style={{ padding: '10px 12px 16px', fontSize: 13, lineHeight: 1.5, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap', flex: 'none' }}>
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => switchTab(item.id)}
            style={{
              background: tab === item.id ? 'rgba(77,107,254,.25)' : 'rgba(127,127,127,.12)',
              color: 'inherit',
              border: `1px solid ${tab === item.id ? 'rgba(77,107,254,.6)' : 'rgba(127,127,127,.3)'}`,
              borderRadius: 6,
              padding: '4px 12px',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {error !== undefined && <div style={{ flex: 'none' }}><Notice kind="error">{error}</Notice></div>}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* All views stay mounted (state survives sub-tab switches); only the
          active one is displayed. Canvas views (editor/terminal) refit on show. */}
      <div style={{ flex: 1, minHeight: 0, display: tab === 'workspaces' ? 'flex' : 'none', flexDirection: 'column', overflow: 'hidden' }}>
        <WorkspacesView
          t={t}
          hosts={hosts}
          workspaces={workspaces}
          routing={routing}
          onChanged={refresh}
          onOpenFiles={(id) => {
            setFilesWorkspaceId(id)
            switchTab('files')
          }}
        />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: tab === 'files' ? 'flex' : 'none', flexDirection: 'column', overflow: 'hidden' }}>
        <FilesView
          t={t}
          workspaces={workspaces}
          openWorkspaceId={filesWorkspaceId}
          onWorkspaceOpened={() => setFilesWorkspaceId(undefined)}
          visible={tab === 'files'}
        />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: tab === 'terminal' ? 'flex' : 'none', flexDirection: 'column', overflow: 'hidden' }}>
        <TerminalView t={t} hosts={hosts} visible={tab === 'terminal'} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: tab === 'git' ? 'flex' : 'none', flexDirection: 'column', overflow: 'hidden' }}>
        <GitView t={t} workspaces={workspaces} />
      </div>
      </div>
    </div>
  )
}

/** Client plugin body. */
export function apply(ctx: Context): void {
  // Explorer tab: only when better-sidebar is installed. No load-order edge
  // exists (client inject metadata is prefetch-only), so poll briefly for a
  // late arrival; give up quietly — directoryFlow + settings work standalone.
  ctx.effect(() => {
    let disposeTab: (() => void) | undefined
    let tries = 0
    const attempt = (): boolean => {
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
        disposeTab = sidebar.registerTab({
          id: 'remote-vs:explorer',
          title: () => '远程',
          description: () => '远端文件、终端与 Git',
          icon: (size: number) => <RemoteIcon size={size} />,
          order: 30,
          single: true,
          component: () => <RemoteRoot />,
        })
      } catch {
        return false
      }
      return true
    }
    if (!attempt()) {
      const timer = setInterval(() => {
        tries += 1
        if (attempt() || tries >= 60) clearInterval(timer)
      }, 500)
      timer.unref?.()
      return () => {
        clearInterval(timer)
        disposeTab?.()
      }
    }
    return () => {
      disposeTab?.()
    }
  }, 'dsh-remote-vs: explorer tab (optional sidebar)')
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
