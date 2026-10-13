/**
 * Workspaces view: bindings list + the shared new-remote-workspace wizard.
 */
import { useState, type ReactNode } from 'react'
import type { RemoteHostSummary, RemoteRoutingStatus, RemoteWorkspaceBinding } from '../protocol.ts'
import { RemoteApiError, api } from './api.ts'
import { WorkspaceWizard } from './WorkspaceWizard.tsx'
import { Btn, Notice, Row, hairline } from './ui.tsx'

function err(e: unknown): string {
  return e instanceof RemoteApiError ? e.message : String(e)
}

export function WorkspacesView(props: {
  t: (k: string) => string
  hosts: RemoteHostSummary[]
  workspaces: RemoteWorkspaceBinding[]
  routing: RemoteRoutingStatus
  onChanged: () => void
  /** Open the files view for a binding; omitted where no files view exists (settings section hides the button). */
  onOpenFiles?: (workspaceId: string) => void
}): ReactNode {
  const t = props.t
  const [wizard, setWizard] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)

  const remove = (id: string): void => {
    setBusy(id)
    api.deleteWorkspace(id).then(
      () => { setBusy(undefined); setNotice('binding removed'); setError(undefined); props.onChanged() },
      (e: unknown) => { setBusy(undefined); setError(err(e)); setNotice(undefined) },
    )
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      <Row>
        <strong style={{ fontSize: 14 }}>{t('ws.title')}</strong>
        <span style={{ flex: 1 }} />
        <Btn
          kind="primary"
          onClick={() => { setWizard(!wizard); setNotice(undefined); setError(undefined) }}
          disabled={props.hosts.length === 0}
          title={props.hosts.length === 0 ? t('ws.empty') : undefined}
        >
          {t('ws.new')}
        </Btn>
      </Row>
      <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
        {t('route.mode')}: <code>{props.routing.mode}</code>
        {props.routing.tombstones.length > 0 && (
          <span> · {t('route.tombstones')}: {props.routing.tombstones.length}</span>
        )}
      </div>
      {notice !== undefined && <Notice kind="info">{notice}</Notice>}
      {error !== undefined && <Notice kind="error">{error}</Notice>}
      {props.workspaces.length === 0 && !wizard && (
        <div style={{ opacity: 0.7, marginTop: 10 }}>{t('ws.empty')}</div>
      )}
      {props.workspaces.map((w) => (
        <div key={w.id} style={{ ...hairline, marginTop: 10, paddingTop: 8 }}>
          <Row>
            <strong>{w.name}</strong>
            <code style={{ fontSize: 12, opacity: 0.8 }}>{w.alias}:{w.remotePath}</code>
          </Row>
          {props.routing.aliasPaths[w.id] !== undefined && (
            <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2 }} title={t('route.aliasPath')}>
              → {props.routing.aliasPaths[w.id]}
            </div>
          )}
          <div style={{ marginTop: 6 }}>
            <Row>
              {props.onOpenFiles !== undefined && (
                <Btn kind="primary" onClick={() => props.onOpenFiles?.(w.id)}>{t('ws.open')}</Btn>
              )}
              <Btn kind="danger" onClick={() => remove(w.id)} disabled={busy !== undefined}>{t('ws.delete')}</Btn>
            </Row>
          </div>
        </div>
      ))}
      {wizard && (
        <WorkspaceWizard
          t={t}
          hosts={props.hosts}
          onDone={() => { setWizard(false); setNotice('binding saved'); setError(undefined); props.onChanged() }}
          onCancel={() => setWizard(false)}
        />
      )}
    </div>
  )
}
