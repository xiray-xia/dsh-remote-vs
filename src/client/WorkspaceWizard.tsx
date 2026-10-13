/**
 * Shared new-remote-workspace wizard (test -> push -> bind path, enforced in
 * order). Used by the Remote tab's Workspaces view and, in Phase 4, by the
 * native directory-flow occupant: `onSaved` carries the materialized alias
 * path the owner adopts as a real workspace.
 */
import { useState, type ReactNode } from 'react'
import type { RemoteHostSummary, RemoteWorkspaceBinding } from '../protocol.ts'
import { RemoteApiError, api } from './api.ts'
import { RemoteDirectoryPicker } from './RemoteDirectoryPicker.tsx'
import { Btn, Field, Notice, Row, hairline, inputStyle, optionStyle, selectStyle } from './ui.tsx'

function err(e: unknown): string {
  return e instanceof RemoteApiError ? e.message : String(e)
}

export function WorkspaceWizard(props: {
  t: (k: string) => string
  hosts: RemoteHostSummary[]
  onDone: () => void
  onCancel: () => void
  /** Phase 4: fired with the materialized alias path before onDone. */
  onSaved?: (workspace: RemoteWorkspaceBinding, aliasPath: string) => void
}): ReactNode {
  const t = props.t
  const [alias, setAlias] = useState(props.hosts[0]?.alias ?? '')
  const [tested, setTested] = useState(false)
  const [pushed, setPushed] = useState(false)
  const [pathOk, setPathOk] = useState(false)
  const [remotePath, setRemotePath] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [showPicker, setShowPicker] = useState(false)

  const pick = (next: string): void => {
    setAlias(next)
    setTested(false)
    setPushed(false)
    setNotice(undefined)
    setError(undefined)
  }

  const runTest = (): void => {
    if (alias === '') return
    setBusy('test')
    api.testHost(alias).then(
      (r) => {
        setBusy(undefined)
        if (r.ok) {
          setTested(true)
          setNotice(`${alias}: OK (${r.durationMs} ms)`)
          setError(undefined)
        } else {
          setTested(false)
          setError(r.error ?? 'unknown')
          setNotice(undefined)
        }
      },
      (e: unknown) => { setBusy(undefined); setTested(false); setError(err(e)); setNotice(undefined) },
    )
  }

  const runPush = (): void => {
    if (alias === '') return
    setBusy('push')
    api.deployPush(alias).then(
      (r) => {
        setBusy(undefined)
        if (r.action === 'failed') {
          setPushed(false)
          setError(r.detail)
          setNotice(undefined)
        } else {
          setPushed(true)
          setNotice(r.detail)
          setError(undefined)
        }
      },
      (e: unknown) => { setBusy(undefined); setPushed(false); setError(err(e)); setNotice(undefined) },
    )
  }

  const runVerify = (target?: string): void => {
    const candidate = (target ?? remotePath).trim()
    if (alias === '' || candidate === '') return
    if (target !== undefined) setRemotePath(target)
    setBusy('verify')
    api.fileOp
      .stat(alias, candidate)
      .then(
        (entry) => {
          setBusy(undefined)
          if (!entry.isDir) {
            setPathOk(false)
            setError(`${candidate}: not a directory`)
            setNotice(undefined)
          } else {
            setPathOk(true)
            setNotice(`${candidate}: directory OK`)
            setError(undefined)
          }
        },
        (e: unknown) => { setBusy(undefined); setPathOk(false); setError(err(e)); setNotice(undefined) },
      )
  }

  const save = (): void => {
    if (alias === '' || name.trim() === '' || remotePath.trim() === '') return
    setBusy('save')
    api.createWorkspace({ name: name.trim(), alias, remotePath: remotePath.trim() }).then(
      (r) => {
        setBusy(undefined)
        props.onSaved?.(r.workspace, r.aliasPath)
        props.onDone()
      },
      (e: unknown) => { setBusy(undefined); setError(err(e)); setNotice(undefined) },
    )
  }

  const disabled = busy !== undefined

  return (
    <div style={{ ...hairline, marginTop: 10, paddingTop: 10 }}>
      <strong>{t('ws.new')}</strong>
      {notice !== undefined && <Notice kind="info">{notice}</Notice>}
      {error !== undefined && <Notice kind="error">{error}</Notice>}
      <div style={{ marginTop: 8, fontWeight: 600 }}>{t('ws.step1')}</div>
      <Row>
        <select
          value={alias}
          disabled={disabled || props.hosts.length === 0}
          onChange={(e) => pick(e.target.value)}
          style={{ ...selectStyle, padding: '4px 8px', fontSize: 13, width: 'auto', flex: 1 }}
        >
          {props.hosts.map((h) => <option key={h.alias} value={h.alias} style={optionStyle}>{h.alias} ({h.user}@{h.host})</option>)}
        </select>
        <Btn onClick={runTest} disabled={disabled || alias === ''}>
          {busy === 'test' ? t('hosts.testing') : t('hosts.test')} {tested ? '✓' : ''}
        </Btn>
      </Row>
      <div style={{ marginTop: 8, fontWeight: 600 }}>{t('ws.step2')}</div>
      <Row>
        <Btn onClick={runPush} disabled={disabled || !tested}>
          {busy === 'push' ? t('hosts.pushing') : t('hosts.push')} {pushed ? '✓' : ''}
        </Btn>
        {!tested && <span style={{ fontSize: 12, opacity: 0.6 }}>{t('ws.testFirst')}</span>}
      </Row>
      <div style={{ marginTop: 8, fontWeight: 600 }}>{t('ws.step3')}</div>
      <Field label={t('ws.remotePath')}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={remotePath}
            disabled={disabled || !pushed}
            onChange={(e) => { setRemotePath(e.target.value); setPathOk(false) }}
            placeholder="/home/user/project"
            style={inputStyle}
          />
          <Btn onClick={() => setShowPicker(true)} disabled={disabled || !pushed}>
            {t('ws.browse')}
          </Btn>
          <Btn onClick={() => runVerify()} disabled={disabled || !pushed || remotePath.trim() === ''}>
            {t('ws.verifyPath')} {pathOk ? '✓' : ''}
          </Btn>
        </div>
      </Field>
      <Field label={t('ws.name')}>
        <input
          value={name}
          disabled={disabled || !pushed}
          onChange={(e) => setName(e.target.value)}
          placeholder={alias !== '' ? `${alias} workspace` : ''}
          style={inputStyle}
        />
      </Field>
      {!pushed && <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 8 }}>{t('ws.pushFirst')}</div>}
      <Row>
        <Btn kind="primary" onClick={save} disabled={disabled || !pushed || !pathOk || name.trim() === ''}>
          {busy === 'save' ? t('common.loading') : t('ws.save')}
        </Btn>
        <Btn onClick={props.onCancel} disabled={disabled}>{t('hosts.cancel')}</Btn>
      </Row>
      <RemoteDirectoryPicker
        t={t}
        open={showPicker}
        title={t('dirPicker.title')}
        alias={alias}
        initialPath={remotePath}
        onPick={(picked) => {
          setShowPicker(false)
          setPathOk(false)
          runVerify(picked)
        }}
        onCancel={() => setShowPicker(false)}
      />
    </div>
  )
}
