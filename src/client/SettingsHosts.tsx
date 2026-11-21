/**
 * Settings section occupants (`settings.section`, ids `remote-hosts` and
 * `remote-workspaces`): the full host manager plus the binding list/wizard,
 * living in the DSH Settings dialog instead of the Remote tab.
 * The `remote-hosts` page also carries the plugin's two view preferences at the
 * bottom (auto-open the remote workspace, and its share of the frame width) —
 * see `auto-open-remote.ts` for the behaviour they drive.
 * Self-contained: each section fetches its own data so they work without any
 * injected face or sidebar.
 *
 * They also feed the sidebar's shared store after a mutation (see `reload`):
 * the two surfaces list the same hosts/bindings, and a workspace created here
 * used to stay invisible in the Remote tab until the whole page reloaded.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  REMOTE_VIEW_SETTINGS_DEFAULTS,
  REMOTE_VIEW_WIDTH_MAX,
  REMOTE_VIEW_WIDTH_MIN,
  type RemoteHostSummary,
  type RemoteRoutingStatus,
  type RemoteViewSettings,
  type RemoteWorkspaceBinding,
} from '../protocol.ts'
import { RemoteApiError, api } from './api.ts'
import { HostsView } from './HostsView.tsx'
import { refreshAll as refreshSidebarStore } from './store.tsx'
import { loadViewSettings, saveViewSettings } from './view-settings.ts'
import { WorkspacesView } from './WorkspacesView.tsx'
import { detectLang, makeT } from './i18n.ts'
import { Notice, Row, hairline, optionStyle, selectStyle } from './ui.tsx'

export function SettingsHostsSection(_props: SettingsSectionOwnerProps): ReactNode {
  const [t] = useState(() => makeT(detectLang()))
  const [hosts, setHosts] = useState<RemoteHostSummary[]>([])
  /** Pre-load placeholder; matches the plugin's default (nforce) until the host answers. */
  const [mode, setMode] = useState<'off' | 'shadow' | 'enforce'>('enforce')
  const [version, setVersion] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  /** View preferences (the page's third block); defaults until the host answers. */
  const [view, setView] = useState<RemoteViewSettings>(() => ({ ...REMOTE_VIEW_SETTINGS_DEFAULTS }))
  /** The width slider's live value while dragging; persisted on release. */
  const [ratio, setRatio] = useState(REMOTE_VIEW_SETTINGS_DEFAULTS.remoteWorkspaceWidthRatio)
  const [viewSaving, setViewSaving] = useState(false)

  const refresh = useCallback(() => {
    setError(undefined)
    Promise.all([api.getHosts(), api.getWorkspaces(), loadViewSettings()]).then(
      ([rows, w, settings]) => {
        setHosts(rows)
        setMode(w.mode)
        setVersion(w.version)
        if (settings !== undefined) {
          setView(settings)
          setRatio(settings.remoteWorkspaceWidthRatio)
        }
      },
      (e: unknown) => setError(e instanceof RemoteApiError ? e.message : String(e)),
    )
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  /**
   * Reload this section AND the sidebar's shared store.
   *
   * Both surfaces list the same data, but this section keeps PRIVATE state (it
   * must work when the Remote tab was never mounted). A host changed here used
   * to stay invisible in the sidebar until the page reloaded — the reverse of
   * why the sidebar is a module singleton. `refreshSidebarStore` is a no-op
   * before the sidebar bootstraps (its ctx is unset), so the standalone path
   * is unchanged.
   */
  const reload = useCallback(() => {
    refresh()
    refreshSidebarStore()
  }, [refresh])

  const changeMode = (next: 'off' | 'shadow' | 'enforce'): void => {
    if (next === mode || saving) return
    setSaving(true)
    setError(undefined)
    api.setRoutingMode(next).then(
      (live) => { setMode(live); refreshSidebarStore() },
      (e: unknown) => setError(e instanceof RemoteApiError ? e.message : String(e)),
    ).finally(() => setSaving(false))
  }

  /**
   * Persist one view preference. The module cache behind `saveViewSettings`
   * publishes the answer, so the frame-wide auto-open behaviour sees the new
   * value in this same page (a width save then applies to an open panel).
   */
  const saveView = useCallback((patch: Partial<RemoteViewSettings>): void => {
    setViewSaving(true)
    setError(undefined)
    saveViewSettings(patch).then(
      (next) => {
        setView(next)
        setRatio(next.remoteWorkspaceWidthRatio)
      },
      (e: unknown) => setError(e instanceof RemoteApiError ? e.message : String(e)),
    ).finally(() => setViewSaving(false))
  }, [])

  /** Commit the slider on release/keyboard blur, not on every drag tick. */
  const commitRatio = (): void => {
    if (viewSaving || ratio === view.remoteWorkspaceWidthRatio) return
    saveView({ remoteWorkspaceWidthRatio: ratio })
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
      <HostsView t={t} hosts={hosts} onChanged={reload} />
      <div style={{ ...hairline, marginTop: 12, paddingTop: 10 }}>
        <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>{t('viewSettings.title')}</div>
        <Row>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: viewSaving ? 0.5 : 1 }}>
            <input
              type="checkbox"
              checked={view.autoOpenRemoteWorkspace}
              disabled={viewSaving}
              onChange={(e) => saveView({ autoOpenRemoteWorkspace: e.target.checked })}
            />
            {t('viewSettings.autoOpen')}
          </label>
          {viewSaving && <span style={{ fontSize: 12, opacity: 0.6 }}>{t('route.saving')}</span>}
        </Row>
        <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>{t('viewSettings.autoOpenHint')}</div>
        <Row>
          <span style={{ fontSize: 12, opacity: 0.75 }}>{t('viewSettings.width')}</span>
          <input
            type="range"
            min={REMOTE_VIEW_WIDTH_MIN}
            max={REMOTE_VIEW_WIDTH_MAX}
            step={0.05}
            value={ratio}
            disabled={viewSaving}
            onChange={(e) => setRatio(Number(e.target.value))}
            onPointerUp={commitRatio}
            onKeyUp={commitRatio}
            onBlur={commitRatio}
            style={{ width: 180, accentColor: 'inherit', opacity: viewSaving ? 0.5 : 1 }}
          />
          <span style={{ fontSize: 12, opacity: 0.75 }}>{Math.round(ratio * 100)}%</span>
        </Row>
        <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>{t('viewSettings.widthHint')}</div>
      </div>
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

  /** Same cross-surface sync as the hosts section: see the note there. */
  const reload = useCallback(() => {
    refresh()
    refreshSidebarStore()
  }, [refresh])

  return (
    <div style={{ padding: '4px 2px', fontSize: 13, lineHeight: 1.5 }}>
      {error !== undefined && <Notice kind="error">{error}</Notice>}
      <WorkspacesView t={t} hosts={hosts} workspaces={workspaces} routing={routing} onChanged={reload} />
    </div>
  )
}
