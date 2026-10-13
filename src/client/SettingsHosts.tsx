/**
 * Settings section occupants (`settings.section`, ids `remote-hosts` and
 * `remote-workspaces`): the full host manager plus the binding list/wizard,
 * living in the DSH Settings dialog instead of the Remote tab.
 * Self-contained: each section fetches its own data so they work without any
 * injected face or sidebar.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RemoteHostSummary, RemoteRoutingStatus, RemoteWorkspaceBinding } from '../protocol.ts'
import { RemoteApiError, api } from './api.ts'
import { HostsView } from './HostsView.tsx'
import { WorkspacesView } from './WorkspacesView.tsx'
import { detectLang, makeT } from './i18n.ts'
import { Notice } from './ui.tsx'

export function SettingsHostsSection(_props: SettingsSectionOwnerProps): ReactNode {
  const [t] = useState(() => makeT(detectLang()))
  const [hosts, setHosts] = useState<RemoteHostSummary[]>([])
  const [error, setError] = useState<string | undefined>(undefined)

  const refresh = useCallback(() => {
    setError(undefined)
    api.getHosts().then(
      (rows) => setHosts(rows),
      (e: unknown) => setError(e instanceof RemoteApiError ? e.message : String(e)),
    )
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return (
    <div style={{ padding: '4px 2px', fontSize: 13, lineHeight: 1.5 }}>
      {error !== undefined && <Notice kind="error">{error}</Notice>}
      <HostsView t={t} hosts={hosts} onChanged={refresh} />
    </div>
  )
}

export function SettingsWorkspacesSection(_props: SettingsSectionOwnerProps): ReactNode {
  const [t] = useState(() => makeT(detectLang()))
  const [hosts, setHosts] = useState<RemoteHostSummary[]>([])
  const [workspaces, setWorkspaces] = useState<RemoteWorkspaceBinding[]>([])
  const [routing, setRouting] = useState<RemoteRoutingStatus>({ mode: 'off', aliasPaths: {}, tombstones: [] })
  const [error, setError] = useState<string | undefined>(undefined)

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

  return (
    <div style={{ padding: '4px 2px', fontSize: 13, lineHeight: 1.5 }}>
      {error !== undefined && <Notice kind="error">{error}</Notice>}
      <WorkspacesView t={t} hosts={hosts} workspaces={workspaces} routing={routing} onChanged={refresh} />
    </div>
  )
}
