/**
 * Hosts view: list + add/edit form + test + key bootstrap + push + import.
 */
import { useState, type ReactNode } from 'react'
import type { RemoteDeployState, RemoteHostSummary } from '../protocol.ts'
import { RemoteApiError, api, type HostForm } from './api.ts'
import { Btn, Field, Notice, Row, hairline, inputStyle } from './ui.tsx'

function err(e: unknown): string {
  return e instanceof RemoteApiError ? e.message : String(e)
}

function DeployBadge(props: { deploy: RemoteDeployState | undefined; t: (k: string) => string }): ReactNode {
  const d = props.deploy
  if (d === undefined || d.status === 'not-deployed') return <span style={{ opacity: 0.6 }}>{props.t('deploy.notDeployed')}</span>
  const color = d.status === 'failed' ? '#e06060' : d.status === 'ok' ? '#7ee2a8' : '#e8b84b'
  const label = d.status === 'ok'
    ? props.t('deploy.ok')
    : d.status === 'skipped-same'
      ? props.t('deploy.skipped')
      : props.t('deploy.failed')
  return (
    <span title={d.detail ?? d.artifact} style={{ color }}>
      {label} · {d.artifact}{d.manifestHash !== undefined ? ` ${d.manifestHash.slice(0, 8)}` : ''}
    </span>
  )
}

function HostFormView(props: {
  t: (k: string) => string
  initial?: RemoteHostSummary
  busy: boolean
  onSave: (form: HostForm) => void
  onCancel: () => void
}): ReactNode {
  const t = props.t
  const [alias, setAlias] = useState(props.initial?.alias ?? '')
  const [host, setHost] = useState(props.initial?.host ?? '')
  const [port, setPort] = useState(String(props.initial?.port ?? 22))
  const [user, setUser] = useState(props.initial?.user ?? '')
  const [kind, setKind] = useState<'key' | 'password'>(props.initial?.auth ?? 'key')
  const [keyPath, setKeyPath] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [password, setPassword] = useState('')
  const [description, setDescription] = useState(props.initial?.description ?? '')

  const save = (): void => {
    const portNum = Number.parseInt(port, 10)
    const form: HostForm = {
      alias: alias.trim(),
      host: host.trim(),
      port: Number.isFinite(portNum) ? portNum : 22,
      user: user.trim(),
      auth: kind === 'key'
        ? {
            kind: 'key',
            keyPath: keyPath.trim(),
            ...(passphrase !== '' ? { passphrase } : {}),
          }
        : { kind: 'password', password },
      ...(description.trim() !== '' ? { description: description.trim() } : {}),
    }
    props.onSave(form)
  }

  return (
    <div style={{ ...hairline, marginTop: 10, paddingTop: 10 }}>
      <Field label={t('form.alias')}>
        <input
          value={alias}
          disabled={props.initial !== undefined || props.busy}
          onChange={(e) => setAlias(e.target.value)}
          placeholder="prod-web-1"
          style={inputStyle}
        />
      </Field>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 2 }}>
          <Field label={t('form.host')}>
            <input value={host} disabled={props.busy} onChange={(e) => setHost(e.target.value)} placeholder="192.0.2.10" style={inputStyle} />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label={t('form.port')}>
            <input value={port} disabled={props.busy} onChange={(e) => setPort(e.target.value)} style={inputStyle} />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label={t('form.user')}>
            <input value={user} disabled={props.busy} onChange={(e) => setUser(e.target.value)} placeholder="root" style={inputStyle} />
          </Field>
        </div>
      </div>
      <div style={{ marginBottom: 8, fontSize: 12 }}>
        <span style={{ opacity: 0.75, marginRight: 8 }}>{t('form.auth')}</span>
        <label style={{ marginRight: 10 }}>
          <input type="radio" checked={kind === 'key'} disabled={props.busy} onChange={() => setKind('key')} /> {t('form.authKey')}
        </label>
        <label>
          <input type="radio" checked={kind === 'password'} disabled={props.busy} onChange={() => setKind('password')} /> {t('form.authPassword')}
        </label>
      </div>
      {kind === 'key' ? (
        <>
          <Field label={t('form.keyPath')}>
            <input
              value={keyPath}
              disabled={props.busy}
              onChange={(e) => setKeyPath(e.target.value)}
              placeholder={props.initial?.auth === 'key' ? '(unchanged)' : 'C:\\Users\\me\\.ssh\\id_ed25519'}
              style={inputStyle}
            />
          </Field>
          <Field label={t('form.passphrase')}>
            <input
              type="password"
              value={passphrase}
              disabled={props.busy}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder={props.initial !== undefined ? '(unchanged when empty)' : ''}
              style={inputStyle}
            />
          </Field>
        </>
      ) : (
        <Field label={t('form.password')}>
          <input
            type="password"
            value={password}
            disabled={props.busy}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={props.initial?.auth === 'password' ? '(empty keeps stored)' : ''}
            style={inputStyle}
          />
        </Field>
      )}
      <Field label={t('form.description')}>
        <input value={description} disabled={props.busy} onChange={(e) => setDescription(e.target.value)} style={inputStyle} />
      </Field>
      <Row>
        <Btn kind="primary" onClick={save} disabled={props.busy}>{t('hosts.save')}</Btn>
        <Btn onClick={props.onCancel} disabled={props.busy}>{t('hosts.cancel')}</Btn>
      </Row>
    </div>
  )
}

export function HostsView(props: {
  t: (k: string) => string
  hosts: RemoteHostSummary[]
  onChanged: () => void
}): ReactNode {
  const t = props.t
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [editing, setEditing] = useState<string | 'new' | null>(null)

  const say = (message: string): void => {
    setNotice(message)
    setError(undefined)
  }
  const fail = (e: unknown): void => {
    setError(err(e))
    setNotice(undefined)
  }

  const runTest = (alias: string): void => {
    setBusy(`test:${alias}`)
    api.testHost(alias).then(
      (r) => {
        setBusy(undefined)
        if (r.ok) say(`${alias}: OK (${r.durationMs} ms)`)
        else fail(`${alias}: ${r.error ?? 'unknown'}`)
      },
      (e: unknown) => { setBusy(undefined); fail(e) },
    )
  }

  const runBootstrap = (alias: string): void => {
    setBusy(`key:${alias}`)
    api.bootstrap(alias).then(
      (r) => {
        setBusy(undefined)
        say(`${alias}: ${r.detail} → ${r.keyPath}`)
        props.onChanged()
      },
      (e: unknown) => { setBusy(undefined); fail(e) },
    )
  }

  const runPush = (alias: string): void => {
    setBusy(`push:${alias}`)
    api.deployPush(alias).then(
      (r) => {
        setBusy(undefined)
        say(`${alias}: ${r.detail}`)
        props.onChanged()
      },
      (e: unknown) => { setBusy(undefined); fail(e) },
    )
  }

  const runDelete = (alias: string): void => {
    if (!window.confirm(t('hosts.confirmDelete'))) return
    setBusy(`del:${alias}`)
    api.deleteHost(alias).then(
      () => { setBusy(undefined); say(`${alias}: deleted`); props.onChanged() },
      (e: unknown) => { setBusy(undefined); fail(e) },
    )
  }

  const runImport = (kind: 'ssh-config' | 'dsh-ssh'): void => {
    setBusy(`import:${kind}`)
    const task = kind === 'ssh-config' ? api.importSshConfig() : api.importDshSsh()
    task.then(
      (report) => {
        setBusy(undefined)
        const skipped = report.skipped.map(s => `${s.alias}(${s.reason})`).join('; ')
        say(`imported ${report.imported.length}${report.imported.length > 0 ? `: ${report.imported.join(', ')}` : ''}${skipped !== '' ? `; skipped: ${skipped}` : ''}`)
        props.onChanged()
      },
      (e: unknown) => { setBusy(undefined); fail(e) },
    )
  }

  const saveForm = (form: HostForm): void => {
    setBusy('save')
    const task = editing === 'new'
      ? api.createHost(form)
      : api.updateHost(editing as string, {
        host: form.host,
        port: form.port,
        user: form.user,
        auth: form.auth,
        description: form.description,
      })
    task.then(
      (h) => {
        setBusy(undefined)
        setEditing(null)
        say(`${h.alias}: saved`)
        props.onChanged()
      },
      (e: unknown) => { setBusy(undefined); fail(e) },
    )
  }

  const disabled = busy !== undefined

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      <Row>
        <strong style={{ fontSize: 14 }}>{t('hosts.title')}</strong>
        <span style={{ flex: 1 }} />
        <Btn kind="primary" onClick={() => { setEditing('new'); setNotice(undefined); setError(undefined) }} disabled={disabled || editing !== null}>
          {t('hosts.add')}
        </Btn>
      </Row>
      <div style={{ marginTop: 8 }}>
        <Row>
          <Btn onClick={() => runImport('ssh-config')} disabled={disabled}>{t('hosts.importSshConfig')}</Btn>
          <Btn onClick={() => runImport('dsh-ssh')} disabled={disabled}>{t('hosts.importDshSsh')}</Btn>
        </Row>
      </div>
      {notice !== undefined && <Notice kind="info">{notice}</Notice>}
      {error !== undefined && <Notice kind="error">{error}</Notice>}
      {props.hosts.length === 0 && editing === null && (
        <div style={{ opacity: 0.7, marginTop: 10 }}>{t('hosts.empty')}</div>
      )}
      {props.hosts.map((h) => (
        <div key={h.alias} style={{ ...hairline, marginTop: 10, paddingTop: 8 }}>
          <Row>
            <code style={{ fontWeight: 700 }}>{h.alias}</code>
            <code style={{ opacity: 0.75 }}>{h.user}@{h.host}:{h.port}</code>
            <span style={{ fontSize: 12, opacity: 0.75 }}>
              {h.auth === 'key' ? (h.keyReady ? '🔑✓' : '🔑?') : '🔒'}
              {h.managedKey ? ' (managed)' : ''}
            </span>
          </Row>
          <div style={{ fontSize: 12, margin: '4px 0' }}>
            <DeployBadge deploy={h.deploy} t={t} />
            {h.description !== undefined && h.description !== '' && <span style={{ opacity: 0.7 }}> · {h.description}</span>}
          </div>
          <Row>
            <Btn onClick={() => runTest(h.alias)} disabled={disabled}>
              {busy === `test:${h.alias}` ? t('hosts.testing') : t('hosts.test')}
            </Btn>
            {h.auth === 'password' && (
              <Btn onClick={() => runBootstrap(h.alias)} disabled={disabled}>
                {busy === `key:${h.alias}` ? t('hosts.bootstrapping') : t('hosts.bootstrap')}
              </Btn>
            )}
            <Btn onClick={() => runPush(h.alias)} disabled={disabled}>
              {busy === `push:${h.alias}` ? t('hosts.pushing') : t('hosts.push')}
            </Btn>
            <Btn onClick={() => { setEditing(editing === h.alias ? null : h.alias); setNotice(undefined); setError(undefined) }} disabled={disabled}>
              {t('hosts.edit')}
            </Btn>
            <Btn kind="danger" onClick={() => runDelete(h.alias)} disabled={disabled}>{t('hosts.delete')}</Btn>
          </Row>
          {editing === h.alias && (
            <HostFormView t={t} initial={h} busy={disabled} onSave={saveForm} onCancel={() => setEditing(null)} />
          )}
        </div>
      ))}
      {editing === 'new' && (
        <HostFormView t={t} busy={disabled} onSave={saveForm} onCancel={() => setEditing(null)} />
      )}
    </div>
  )
}
