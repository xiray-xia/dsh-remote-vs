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
import { Notice, Row, hairline, optionStyle, selectStyle } from './ui.tsx'

export function SettingsHostsSection(_props: SettingsSectionOwnerProps): ReactNode {
  const [t] = useState(() => makeT(detectLang()))
  const [hosts, setHosts] = useState<RemoteHostSummary[]>([])
  const [mode, setMode] = useState<'off' | 'shadow' | 'enforce'>('off')
  const [version, setVersion] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const refresh = useCallback(() => {
    setError(undefined)
    Promise.all([api.getHosts(), api.getWorkspaces()]).then(
      ([rows, w]) => {
        setHosts(rows)
        setMode(w.mode)
        setVersion(w.version)
      },
      (e: unknown) => setError(e instanceof RemoteApiError ? e.message : String(e)),
    )
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const changeMode = (next: 'off' | 'shadow' | 'enforce'): void => {
    if (next === mode || saving) return
    setSaving(true)
    setError(undefined)
    api.setRoutingMode(next).then(
      (live) => setMode(live),
      (e: unknown) => setError(e instanceof RemoteApiError ? e.message : String(e)),
    ).finally(() => setSaving(false))
  }

  return (
    <div style={{ padding: '4px 2px', fontSize: 13, lineHeight: 1.5 }}>
      <div style={{ ...hairline, borderTop: 'none', borderBottom: '1px solid rgba(127,127,127,.25)', marginBottom: 10, paddingBottom: 8 }}>
        <Row>
          <span style={{ fontSize: 12, opacity: 0.75 }}>{t('route.mode')}</span>
          <select
            value={mode}
            disabled={saving}
            onChange={(e) => changeMode(e.target.value as 'off' | 'shadow' | 'enforce')}
            style={{ ...selectStyle, opacity: saving ? 0.5 : 1 }}
          >
            <option value="off" style={optionStyle}>{t('route.off')}</option>
            <option value="shadow" style={optionStyle}>{t('route.shadow')}</option>
            <option value="enforce" style={optionStyle}>{t('route.enforce')}</option>
          </select>
          {saving && <span style={{ fontSize: 12, opacity: 0.6 }}>{t('route.saving')}</span>}
          {version !== '' && (
            <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.6 }}>
              {t('plugin.version')}: <code>v{version}</code>
            </span>
          )}
        </Row>
        <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>{t('route.hint')}</div>
      </div>
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
