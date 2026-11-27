/**
 * Hosts view: list + add/edit form + test + key bootstrap + push + import.
 *
 * The form also owns the host's 「网络出口」 (egress: proxy / jump host) block.
 * It is COLLAPSED by default, because most hosts go out directly and a wall of
 * empty proxy fields reads as "you must fill this in"; the collapsed row still
 * carries a read-only chip with the resulting route, so the answer to "how does
 * this host get out" never needs a click. The profile-wide default that
 * `跟随默认` resolves to lives in Settings (`SettingsHosts.tsx`).
 */
import { useId, useState, type ReactNode } from 'react'
import type {
  RemoteDeployState,
  RemoteHostProxySetting,
  RemoteHostProxyView,
  RemoteHostSummary,
  RemoteProxyMode,
  RemoteProxySetting,
  RemoteProxySettingsView,
} from '../protocol.ts'
import { RemoteApiError, api, type HostForm } from './api.ts'
import { DoctorPanel } from './DoctorPanel.tsx'
import { Btn, Field, Notice, Row, hairline, inputStyle, optionStyle, selectStyle } from './ui.tsx'
import { confirmDialog } from './vsc/kit.tsx'

/** The translator shape this plugin's views pass around. */
type TFn = (key: string) => string

function err(e: unknown): string {
  return e instanceof RemoteApiError ? e.message : String(e)
}

/** Short word for a proxy flavour, as the chips print it. */
function shortKind(t: TFn, kind: 'http' | 'socks5'): string {
  return kind === 'http' ? t('proxy.shortHttp') : t('proxy.shortSocks5')
}

/** Everything the egress controls edit, as form strings. */
export interface ProxyFormState {
  mode: RemoteProxyMode
  kind: 'http' | 'socks5'
  host: string
  port: string
  username: string
  password: string
  viaAlias: string
}

/** A blank draft: `跟随默认`, HTTP, no address (i.e. a fresh host). */
export function emptyProxyState(): ProxyFormState {
  return { mode: 'inherit', kind: 'http', host: '', port: '', username: '', password: '', viaAlias: '' }
}

/**
 * Seed the controls from a stored (secret-free) host view.
 *
 * The password box stays EMPTY on purpose: the Host never echoes it back, and
 * `proxySettingOf` expresses "keep the stored one" by omitting the field, so an
 * untouched box cannot overwrite a working credential with an empty string.
 */
export function proxyStateOf(view: RemoteHostProxyView | undefined): ProxyFormState {
  const state = emptyProxyState()
  if (view === undefined) return state
  state.mode = view.mode
  state.viaAlias = view.jumpVia ?? ''
  if (view.target !== undefined) {
    state.kind = view.target.kind
    state.host = view.target.host
    state.port = String(view.target.port)
    state.username = view.target.username ?? ''
  }
  return state
}

/** The profile default as a draft (it only knows `direct` / `proxy`). */
export function defaultProxyStateOf(view: RemoteProxySettingsView | undefined): ProxyFormState {
  const state = emptyProxyState()
  state.mode = view === undefined ? 'direct' : view.defaultMode
  if (view?.target !== undefined) {
    state.kind = view.target.kind
    state.host = view.target.host
    state.port = String(view.target.port)
    state.username = view.target.username ?? ''
  }
  return state
}

/**
 * The endpoint half of a proxy decision.
 *
 * An empty password is OMITTED (not sent as `''`): that is the contract for
 * "keep the stored secret", and it is the only reason the browser never has to
 * see the password at all.
 */
export function proxyTargetOf(state: ProxyFormState): RemoteProxySetting {
  const parsed = Number.parseInt(state.port, 10)
  const username = state.username.trim()
  return {
    kind: state.kind,
    host: state.host.trim(),
    port: Number.isInteger(parsed) ? parsed : 0,
    ...(username === '' ? {} : { username }),
    ...(state.password === '' ? {} : { password: state.password }),
  }
}

/**
 * The `proxy` field for one save, or `undefined` when it must be left out.
 *
 * `undefined` is the BACKWARD-COMPATIBLE answer: an old Host ignores the field,
 * and on create an absent value simply inherits the profile default. An UPDATE
 * that switches back to `跟随默认` is the one case an explicit
 * `{ mode: 'inherit' }` has to be sent, or the stored proxy would never clear.
 */
export function proxySettingOf(state: ProxyFormState): RemoteHostProxySetting | undefined {
  if (state.mode === 'inherit') return undefined
  if (state.mode === 'direct') return { mode: 'direct' }
  if (state.mode === 'jump') return { mode: 'jump', jump: { viaAlias: state.viaAlias.trim() } }
  return { mode: 'proxy', proxy: proxyTargetOf(state) }
}

/**
 * What stops a save: an unusable proxy endpoint, or no jump host picked.
 *
 * `jumpChoices` is the list of aliases the save can legally name (every stored
 * host except the one being edited). A stored jump host that has since been
 * deleted is NOT saveable — the Host refuses a `viaAlias` it does not know — so
 * the form has to say that in the user's language instead of forwarding a raw
 * `unknown host alias` rejection for a field nobody touched.
 */
export function proxyFormProblem(
  state: ProxyFormState,
  jumpChoices?: string[],
): 'target' | 'jump' | 'jumpGone' | undefined {
  if (state.mode === 'proxy') {
    const parsed = Number.parseInt(state.port, 10)
    if (state.host.trim() === '' || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return 'target'
  }
  if (state.mode === 'jump') {
    const alias = state.viaAlias.trim()
    if (alias === '') return 'jump'
    if (jumpChoices !== undefined && !jumpChoices.includes(alias)) return 'jumpGone'
  }
  return undefined
}

/**
 * One line saying where traffic goes — the collapsed chip's text.
 *
 * `跟随默认` is resolved against the profile default when it is known: the whole
 * point of showing the chip while collapsed is that "follow the default" alone
 * does not tell the user whether that means direct or a proxy. An unknown
 * default (a Host without the route, or a failed read) degrades to the bare
 * phrase rather than guessing "direct".
 */
export function proxySummary(t: TFn, state: ProxyFormState, fallback: RemoteProxySettingsView | undefined): string {
  if (state.mode === 'direct') return t('proxy.summaryDirect')
  if (state.mode === 'proxy') {
    const host = state.host.trim()
    const port = state.port.trim()
    if (host === '' || port === '') return t('proxy.chipProxy')
    return t('proxy.summaryProxy')
      .replace('{kind}', shortKind(t, state.kind))
      .replace('{host}', host)
      .replace('{port}', port)
  }
  if (state.mode === 'jump') {
    const alias = state.viaAlias.trim()
    return alias === '' ? t('proxy.mode.jump') : t('proxy.summaryJump').replace('{alias}', alias)
  }
  const target = fallback?.target
  if (fallback === undefined || (fallback.defaultMode === 'proxy' && target === undefined)) {
    return t('proxy.chipInherit')
  }
  if (fallback.defaultMode === 'direct') return t('proxy.summaryInheritDirect')
  return t('proxy.summaryInheritProxy')
    .replace('{kind}', shortKind(t, target?.kind ?? 'http'))
    .replace('{host}', target?.host ?? '')
    .replace('{port}', String(target?.port ?? ''))
}

/** One rendered chip: its word, its hover text, and whether it is a problem. */
export interface ProxyChipModel {
  mode: RemoteProxyMode
  label: string
  title: string
  problem: boolean
}

/**
 * The host ROW's chip: which way this host leaves the machine.
 *
 * Deliberately shorter than the form's summary (`代理`, not `经 HTTP 代理 h:p`) —
 * a list row has one line of room and the full route is the `title`. A refused
 * setting keeps its chip text and switches to the error colour, because the row
 * still has to say what was configured; `problem` explains why it cannot work.
 *
 * `fallback` is the profile-wide default, so a `跟随默认` row resolves to what it
 * actually does (the form's chip already does) — without it the row would say
 * "follow default" while the same host's form says "follow default (via …)". An
 * unknown default degrades to the bare phrase rather than guessing "direct".
 */
export function proxyChipOf(t: TFn, view: RemoteHostProxyView, fallback?: RemoteProxySettingsView): ProxyChipModel {
  const state = proxyStateOf(view)
  const summary = proxySummary(t, state, fallback)
  const label = view.mode === 'jump'
    ? (view.jumpVia === undefined ? t('proxy.mode.jump') : t('proxy.chipJump').replace('{alias}', view.jumpVia))
    : summary
  return {
    mode: view.mode,
    label,
    title: view.problem ?? t('proxy.chipTitle').replace('{summary}', summary),
    problem: view.problem !== undefined,
  }
}

/** Read-only route chip (secondary outline, never a status colour). */
export function ProxyChip(props: { chip: ProxyChipModel }): ReactNode {
  const chip = props.chip
  return (
    <span
      className={chip.problem ? 'rvs-proxy-chip is-error' : 'rvs-proxy-chip'}
      data-proxy-mode={chip.mode}
      {...(chip.problem ? { 'data-proxy-problem': '1' } : {})}
      title={chip.title}
    >
      {chip.label}
    </span>
  )
}

/**
 * Collapsible section header: a real `<button>` with `aria-expanded`.
 *
 * A `<details>` element was refused on purpose: its summary marker cannot be
 * restyled without vendor pseudo-elements and it gives no place for the chip.
 * A native button keeps Enter/Space, focus and the announced state for free.
 */
export function ProxySectionHeader(props: {
  open: boolean
  label: string
  expandLabel: string
  collapseLabel: string
  chip: ProxyChipModel
  controls: string
  onToggle: () => void
}): ReactNode {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: props.open ? 8 : 4 }}>
      <button
        type="button"
        className="rvs-proxy-toggle"
        aria-expanded={props.open}
        aria-controls={props.controls}
        title={props.open ? props.collapseLabel : props.expandLabel}
        onClick={props.onToggle}
      >
        <span className="rvs-proxy-caret" aria-hidden="true">▸</span>
        <span style={{ fontSize: 12, opacity: 0.75 }}>{props.label}</span>
      </button>
      <span style={{ flex: 1 }} />
      <ProxyChip chip={props.chip} />
    </div>
  )
}

/**
 * The endpoint controls, shared by the per-host form and the profile default.
 *
 * Password semantics are identical in both places: `storedPassword` only
 * switches the placeholder, and an empty box is omitted from the payload.
 */
export function ProxyFields(props: {
  t: TFn
  state: ProxyFormState
  onChange: (next: ProxyFormState) => void
  storedPassword: boolean
  disabled?: boolean
}): ReactNode {
  const t = props.t
  const state = props.state
  const set = (patch: Partial<ProxyFormState>): void => props.onChange({ ...state, ...patch })
  const disabled = props.disabled === true
  return (
    <>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1.1 }}>
          <Field label={t('proxy.kind')}>
            <select
              value={state.kind}
              disabled={disabled}
              onChange={(e) => set({ kind: e.target.value === 'socks5' ? 'socks5' : 'http' })}
              style={selectStyle}
            >
              <option value="http" style={optionStyle}>{t('proxy.typeHttp')}</option>
              <option value="socks5" style={optionStyle}>{t('proxy.typeSocks5')}</option>
            </select>
          </Field>
        </div>
        <div style={{ flex: 1.9 }}>
          <Field label={t('proxy.host')}>
            <input
              value={state.host}
              disabled={disabled}
              onChange={(e) => set({ host: e.target.value })}
              placeholder="192.0.2.10"
              style={inputStyle}
            />
          </Field>
        </div>
        <div style={{ flex: 0.8 }}>
          <Field label={t('proxy.port')}>
            <input
              value={state.port}
              disabled={disabled}
              inputMode="numeric"
              onChange={(e) => set({ port: e.target.value })}
              placeholder="3128"
              style={inputStyle}
            />
          </Field>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <Field label={t('proxy.username')}>
            <input
              value={state.username}
              disabled={disabled}
              autoComplete="off"
              onChange={(e) => set({ username: e.target.value })}
              style={inputStyle}
            />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label={t('proxy.password')}>
            <input
              type="password"
              value={state.password}
              disabled={disabled}
              autoComplete="new-password"
              onChange={(e) => set({ password: e.target.value })}
              placeholder={props.storedPassword ? t('proxy.passwordKeep') : ''}
              style={inputStyle}
            />
          </Field>
        </div>
      </div>
    </>
  )
}

/** The egress block of the host form (collapsed by default). */
function HostProxySection(props: {
  t: TFn
  state: ProxyFormState
  onChange: (next: ProxyFormState) => void
  open: boolean
  onToggle: () => void
  proxyDefault: RemoteProxySettingsView | undefined
  hosts: RemoteHostSummary[]
  self: string | undefined
  storedPassword: boolean
  busy: boolean
  error: string | undefined
}): ReactNode {
  const t = props.t
  const state = props.state
  const set = (patch: Partial<ProxyFormState>): void => props.onChange({ ...state, ...patch })
  const panelId = useId()
  const groupName = useId()
  const summary = proxySummary(t, state, props.proxyDefault)
  const chip: ProxyChipModel = {
    mode: state.mode,
    label: summary,
    title: t('proxy.chipTitle').replace('{summary}', summary),
    problem: false,
  }
  // A jump host must be another STORED host: the tunnel rides its pooled SSH
  // connection, and the alias being edited is not a candidate for itself.
  const candidates = props.hosts.filter(host => host.alias !== props.self)
  const missing = state.viaAlias !== '' && !candidates.some(host => host.alias === state.viaAlias)
  return (
    <div style={{ ...hairline, marginTop: 2, paddingTop: 8, marginBottom: 8 }}>
      <ProxySectionHeader
        open={props.open}
        label={t('proxy.title')}
        expandLabel={t('proxy.expand')}
        collapseLabel={t('proxy.collapse')}
        chip={chip}
        controls={panelId}
        onToggle={props.onToggle}
      />
      <div id={panelId} hidden={!props.open} className="rvs-proxy-panel">
        <Row>
          <span style={{ opacity: 0.75, marginRight: 4 }}>{t('proxy.mode')}</span>
          <label style={{ marginRight: 10 }}>
            <input
              type="radio"
              name={groupName}
              checked={state.mode === 'inherit'}
              disabled={props.busy}
              onChange={() => set({ mode: 'inherit' })}
            />{' '}{t('proxy.mode.inherit')}
          </label>
          <label style={{ marginRight: 10 }}>
            <input
              type="radio"
              name={groupName}
              checked={state.mode === 'direct'}
              disabled={props.busy}
              onChange={() => set({ mode: 'direct' })}
            />{' '}{t('proxy.mode.direct')}
          </label>
          <label style={{ marginRight: 10 }}>
            <input
              type="radio"
              name={groupName}
              checked={state.mode === 'proxy'}
              disabled={props.busy}
              onChange={() => set({ mode: 'proxy' })}
            />{' '}{t('proxy.mode.proxy')}
          </label>
          <label>
            <input
              type="radio"
              name={groupName}
              checked={state.mode === 'jump'}
              disabled={props.busy}
              onChange={() => set({ mode: 'jump' })}
            />{' '}{t('proxy.mode.jump')}
          </label>
        </Row>
        {state.mode === 'proxy' && (
          <ProxyFields
            t={t}
            state={state}
            onChange={props.onChange}
            storedPassword={props.storedPassword}
            disabled={props.busy}
          />
        )}
        {state.mode === 'jump' && (
          <>
            <Field label={t('proxy.jumpVia')}>
              <select
                value={state.viaAlias}
                disabled={props.busy}
                onChange={(e) => set({ viaAlias: e.target.value })}
                style={selectStyle}
              >
                {candidates.length === 0 && <option value="" style={optionStyle}>{t('proxy.jumpNone')}</option>}
                {missing && (
                  <option value={state.viaAlias} style={optionStyle}>
                    {t('proxy.jumpMissing').replace('{alias}', state.viaAlias)}
                  </option>
                )}
                {candidates.map(host => (
                  <option key={host.alias} value={host.alias} style={optionStyle}>
                    {host.alias === host.host ? host.alias : `${host.alias} (${host.host})`}
                  </option>
                ))}
              </select>
            </Field>
            <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 8 }}>{t('proxy.jumpHint')}</div>
          </>
        )}
        {props.error !== undefined && <Notice kind="error">{props.error}</Notice>}
      </div>
    </div>
  )
}

function DeployBadge(props: { deploy: RemoteDeployState | undefined; t: TFn }): ReactNode {
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

export function HostFormView(props: {
  t: TFn
  initial?: RemoteHostSummary
  busy: boolean
  /** Every stored host: the jump-host list (minus the one being edited). */
  hosts: RemoteHostSummary[]
  /** The profile-wide default, so `跟随默认` can be spelled out while collapsed. */
  proxyDefault?: RemoteProxySettingsView
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
  const [proxy, setProxy] = useState<ProxyFormState>(() => proxyStateOf(props.initial?.proxy))
  /** Collapsed by default: most hosts go out directly, and the chip says so. */
  const [proxyOpen, setProxyOpen] = useState(false)
  const [proxyError, setProxyError] = useState<string | undefined>(undefined)
  /**
   * "Leave it empty to keep it" is only true while the endpoint is UNCHANGED.
   *
   * The Host keeps a stored proxy password only when kind/host/port/username all
   * still match (a new endpoint must not inherit the old secret), so a bare
   * `hasPassword` would promise something an edited port silently breaks. The
   * placeholder is therefore decided against the draft, not the stored view.
   */
  const storedTarget = props.initial?.proxy?.target
  const storedPassword = storedTarget?.hasPassword === true
    && proxy.mode === 'proxy'
    && proxy.kind === storedTarget.kind
    && proxy.host.trim() === storedTarget.host
    && proxy.port.trim() === String(storedTarget.port)
    && proxy.username.trim() === (storedTarget.username ?? '')
  /** Aliases a jump setting may legally name (the Host refuses anything else). */
  const jumpChoices = props.hosts.filter(entry => entry.alias !== props.initial?.alias).map(entry => entry.alias)

  const save = (): void => {
    const problem = proxyFormProblem(proxy, jumpChoices)
    if (problem !== undefined) {
      // Show the message next to the fields it is about, and open the section so
      // it cannot be hidden behind a collapsed header.
      setProxyError(
        problem === 'target'
          ? t('proxy.invalidTarget')
          : problem === 'jump'
            ? t('proxy.invalidJump')
            : t('proxy.jumpGone').replace('{alias}', proxy.viaAlias.trim()),
      )
      setProxyOpen(true)
      return
    }
    setProxyError(undefined)
    const portNum = Number.parseInt(port, 10)
    const setting = proxySettingOf(proxy)
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
      ...(setting === undefined ? {} : { proxy: setting }),
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
              placeholder={props.initial?.auth === 'key' ? t('form.unchanged') : 'C:\\Users\\me\\.ssh\\id_ed25519'}
              style={inputStyle}
            />
          </Field>
          <Field label={t('form.passphrase')}>
            <input
              type="password"
              value={passphrase}
              disabled={props.busy}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder={props.initial !== undefined ? t('form.unchangedWhenEmpty') : ''}
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
            placeholder={props.initial?.auth === 'password' ? t('form.unchangedWhenEmpty') : ''}
            style={inputStyle}
          />
        </Field>
      )}
      <HostProxySection
        t={t}
        state={proxy}
        onChange={(next) => { setProxy(next); setProxyError(undefined) }}
        open={proxyOpen}
        onToggle={() => setProxyOpen(!proxyOpen)}
        proxyDefault={props.proxyDefault}
        hosts={props.hosts}
        self={props.initial?.alias}
        storedPassword={storedPassword}
        busy={props.busy}
        error={proxyError}
      />
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
  t: TFn
  hosts: RemoteHostSummary[]
  /** Profile-wide egress default, so `跟随默认` chips can be resolved. */
  proxyDefault?: RemoteProxySettingsView
  onChanged: () => void
}): ReactNode {
  const t = props.t
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  /** Alias whose environment report is open; the panel mounts and probes. */
  const [doctor, setDoctor] = useState<string | null>(null)

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
        if (r.ok) say(t('hosts.testOk').replace('{alias}', alias).replace('{ms}', String(r.durationMs)))
        else fail(`${alias}: ${r.error ?? t('hosts.unknownError')}`)
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

  const runDelete = async (alias: string): Promise<void> => {
    // Themed confirm instead of `window.confirm`: the native one ignores the
    // plugin theme, is not keyboard-trapped with the rest of the UI and cannot
    // mark the action as destructive.
    const ok = await confirmDialog({
      title: t('hosts.confirmDelete'),
      danger: true,
      okText: t('hosts.delete'),
    })
    if (!ok) return
    setBusy(`del:${alias}`)
    api.deleteHost(alias).then(
      () => { setBusy(undefined); say(t('hosts.deleted').replace('{alias}', alias)); props.onChanged() },
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
        say(`${t('hosts.imported').replace('{count}', String(report.imported.length))}${report.imported.length > 0 ? `: ${report.imported.join(', ')}` : ''}${skipped !== '' ? t('hosts.importedSkipped').replace('{list}', skipped) : ''}`)
        props.onChanged()
      },
      (e: unknown) => { setBusy(undefined); fail(e) },
    )
  }

  const saveForm = (form: HostForm): void => {
    setBusy('save')
    const editingAlias = editing === 'new' ? undefined : editing as string
    const stored = editingAlias === undefined ? undefined : props.hosts.find(h => h.alias === editingAlias)?.proxy
    // An omitted `proxy` means "keep what is stored", so switching back to
    // 跟随默认 has to SAY it — but only when there was something to clear: a host
    // that never had a proxy must not start carrying an explicit `inherit`.
    const proxyPatch = form.proxy
      ?? (stored === undefined || stored.mode === 'inherit' ? undefined : { mode: 'inherit' as const })
    const task = editingAlias === undefined
      ? api.createHost(form)
      : api.updateHost(editingAlias, {
        host: form.host,
        port: form.port,
        user: form.user,
        auth: form.auth,
        description: form.description,
        ...(proxyPatch === undefined ? {} : { proxy: proxyPatch }),
      })
    task.then(
      (h) => {
        setBusy(undefined)
        setEditing(null)
        say(t('hosts.saved').replace('{alias}', h.alias))
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
            <ProxyChip chip={proxyChipOf(t, h.proxy, props.proxyDefault)} />
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
            <Btn onClick={() => { setDoctor(h.alias); setNotice(undefined); setError(undefined) }} disabled={disabled}>
              {t('doctor.open')}
            </Btn>
            <Btn onClick={() => { setEditing(editing === h.alias ? null : h.alias); setNotice(undefined); setError(undefined) }} disabled={disabled}>
              {t('hosts.edit')}
            </Btn>
            <Btn kind="danger" onClick={() => { void runDelete(h.alias) }} disabled={disabled}>{t('hosts.delete')}</Btn>
          </Row>
          {editing === h.alias && (
            <HostFormView
              t={t}
              initial={h}
              busy={disabled}
              hosts={props.hosts}
              proxyDefault={props.proxyDefault}
              onSave={saveForm}
              onCancel={() => setEditing(null)}
            />
          )}
        </div>
      ))}
      {doctor !== null && (
        <DoctorPanel key={doctor} t={t} alias={doctor} onClose={() => setDoctor(null)} />
      )}
      {editing === 'new' && (
        <HostFormView
          t={t}
          busy={disabled}
          hosts={props.hosts}
          proxyDefault={props.proxyDefault}
          onSave={saveForm}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  )
}
