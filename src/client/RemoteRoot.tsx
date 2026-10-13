/**
 * The explorer root shared by both surfaces: the better-sidebar tab (global,
 * one instance) and the native right-Sidebar page (per-session seat, one
 * instance per session that opened it). Four sub-views (workspaces / files /
 * terminal / git) over /api/dsh-remote; all views stay mounted, only the
 * active one displays, and canvas views (editor/terminal) refit on show.
 *
 * `visible` gates the canvas refit signals: the better tab always passes
 * true (it owns tab visibility itself); the native page passes the seat's
 * `tab.visible` (foreground session + expanded + selected).
 */
import type { Context } from '@deepseek-ai/cordis'
import { useCallback, useEffect, useState } from 'react'
import type { RemoteHostSummary, RemoteRoutingStatus, RemoteWorkspaceBinding } from '../protocol.ts'
import { RemoteApiError, api } from './api.ts'
import { FilesView } from './FilesView.tsx'
import { GitView } from './GitView.tsx'
import { TerminalView } from './TerminalView.tsx'
import { WorkspacesView } from './WorkspacesView.tsx'
import { detectLang, makeT } from './i18n.ts'
import { Notice } from './ui.tsx'

type SubTab = 'workspaces' | 'files' | 'terminal' | 'git'

export function RemoteRoot(props: { ctx: Context; visible?: boolean }): React.ReactNode {
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

  const shown = props.visible !== false

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
          ctx={props.ctx}
          workspaces={workspaces}
          aliasPaths={routing.aliasPaths}
          openWorkspaceId={filesWorkspaceId}
          onWorkspaceOpened={() => setFilesWorkspaceId(undefined)}
          visible={shown && tab === 'files'}
        />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: tab === 'terminal' ? 'flex' : 'none', flexDirection: 'column', overflow: 'hidden' }}>
        <TerminalView t={t} hosts={hosts} visible={shown && tab === 'terminal'} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: tab === 'git' ? 'flex' : 'none', flexDirection: 'column', overflow: 'hidden' }}>
        <GitView t={t} workspaces={workspaces} />
      </div>
      </div>
    </div>
  )
}
