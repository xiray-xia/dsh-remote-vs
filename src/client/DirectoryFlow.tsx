/**
 * Phase 4 native directory-flow occupant: a Local/Remote tabbed dialog that
 * shadows the stock picker (registered at priority -1 into both
 * directory-flow holes).
 *
 * - Local leg: dual-mode. When the Host serves the browse capability, a
 *   compact in-app browser drives uiWorkspace.listDirectory/createDirectory.
 *   When it serves native (this Windows machine), one button opens the OS
 *   chooser via uiWorkspace.pickDirectory. The mode is probed once per open:
 *   a working list() means browse, `directory-picker/unavailable` means
 *   native, anything else is an inline error with retry.
 * - Remote leg: the shared WorkspaceWizard; on save the materialized alias
 *   path goes to onPicked and the owner adopts it as a real workspace
 *   (its title was already set to `<server> > <base>` by syncWorkspaces).
 *
 * The occupant never drives the owner's onError arm: every failure stays
 * inside the dialog (stock BrowseDirectoryFlow does the same), and Cancel is
 * always available. If this entry ever crashes, slot shadowing retires it and
 * the stock picker renders (graceful fallback, no dead surface).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'
import type { RemoteHostSummary } from '../protocol.ts'
import { RemoteApiError, api } from './api.ts'
import { WorkspaceWizard } from './WorkspaceWizard.tsx'
import { detectLang, makeT } from './i18n.ts'
import { Btn, Notice } from './ui.tsx'

/** Injected face: uiWorkspace directory primitives (bound in apply's closure). */
export interface DirectoryFlowInjected {
  listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>
  createDirectory: (path: string, name: string) => Promise<string>
  pickDirectory: () => Promise<string | null>
}

function errText(e: unknown): string {
  if (e !== null && typeof e === 'object' && 'rpcError' in e) {
    const rpc = (e as { rpcError: unknown }).rpcError
    if (rpc !== null && typeof rpc === 'object' && 'message' in rpc && typeof (rpc as { message: unknown }).message === 'string') {
      return (rpc as { message: string }).message
    }
  }
  return e instanceof Error ? e.message : String(e)
}

/** True when the failure is "this backend serves no browse primitives". */
function isUnavailable(e: unknown): boolean {
  if (e !== null && typeof e === 'object' && 'rpcError' in e) {
    const rpc = (e as { rpcError: unknown }).rpcError
    if (rpc !== null && typeof rpc === 'object' && 'code' in rpc) {
      return (rpc as { code: unknown }).code === 'directory-picker/unavailable'
    }
  }
  return /unavailable/i.test(errText(e))
}

function LocalLeg(props: {
  t: (k: string) => string
  busy: boolean
  injected: DirectoryFlowInjected
  onPicked: (path: string) => void
}): ReactNode {
  const { t, busy, injected } = props
  const [mode, setMode] = useState<'probing' | 'browse' | 'native' | 'failed'>('probing')
  const [listing, setListing] = useState<DirectoryListing | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [mkdirOpen, setMkdirOpen] = useState(false)
  const [mkdirName, setMkdirName] = useState('')
  const generation = useRef(0)

  const browse = async (dir: string | undefined): Promise<void> => {
    const gen = ++generation.current
    setLoading(true)
    setError(undefined)
    try {
      const level = await injected.listDirectory(dir)
      if (gen !== generation.current) return
      setListing(level)
      setDraft(level.path)
      setMode('browse')
    } catch (e) {
      if (gen !== generation.current) return
      if (isUnavailable(e)) {
        setMode('native')
      } else {
        setMode(mode === 'browse' ? 'browse' : 'failed')
        setError(errText(e))
      }
    } finally {
      if (gen === generation.current) setLoading(false)
    }
  }

  const go = (): void => {
    const target = draft.trim()
    if (target !== '') void browse(target)
  }

  const mkdir = (): void => {
    const name = mkdirName.trim()
    const parent = listing?.path
    if (name === '' || parent === undefined) return
    const gen = ++generation.current
    setLoading(true)
    setError(undefined)
    injected.createDirectory(parent, name).then(
      (created) => {
        if (gen !== generation.current) return
        setMkdirOpen(false)
        setMkdirName('')
        setLoading(false)
        void browse(created)
      },
      (e: unknown) => {
        if (gen !== generation.current) return
        setLoading(false)
        setError(errText(e))
      },
    )
  }

  const nativePick = (): void => {
    const gen = ++generation.current
    setLoading(true)
    setError(undefined)
    setNotice(undefined)
    injected.pickDirectory().then(
      (picked) => {
        if (gen !== generation.current) return
        setLoading(false)
        if (picked === null) {
          setNotice(t('flow.nativeCancelled'))
        } else {
          props.onPicked(picked)
        }
      },
      (e: unknown) => {
        if (gen !== generation.current) return
        setLoading(false)
        setError(errText(e))
      },
    )
  }

  useEffect(() => {
    generation.current += 1
    setListing(undefined)
    setError(undefined)
    setNotice(undefined)
    setMode('probing')
    void browse(undefined)
    return () => {
      generation.current += 1
    }
    // Probe once per mount (the flow remounts per open).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const disabled = busy || loading
  const blocked = busy || loading || mode === 'probing'

  if (mode === 'probing' && listing === undefined && error === undefined) {
    return <div style={{ padding: 12, opacity: 0.6, fontSize: 12 }}>{t('common.loading')}</div>
  }

  if (mode === 'native') {
    return (
      <div style={{ padding: '4px 0' }}>
        <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 10 }}>{t('flow.nativeHint')}</div>
        {notice !== undefined && <Notice kind="info">{notice}</Notice>}
        {error !== undefined && <Notice kind="error">{error}</Notice>}
        <Btn kind="primary" onClick={nativePick} disabled={disabled}>{t('flow.nativePick')}</Btn>
      </div>
    )
  }

  if (mode === 'failed' && listing === undefined) {
    return (
      <div style={{ padding: '4px 0' }}>
        {error !== undefined && <Notice kind="error">{error}</Notice>}
        <Btn onClick={() => { setMode('probing'); void browse(undefined) }} disabled={disabled}>{t('flow.retry')}</Btn>
      </div>
    )
  }

  const current = listing?.path ?? ''
  const parent = listing !== undefined && listing.crumbs.length >= 2
    ? listing.crumbs[listing.crumbs.length - 2]?.path
    : undefined
  const home = listing?.home

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go()
          }}
          disabled={blocked}
          spellCheck={false}
          style={{ flex: 1, background: 'rgba(127,127,127,.12)', color: 'inherit', border: '1px solid rgba(127,127,127,.35)', borderRadius: 6, padding: '4px 8px', fontSize: 13, fontFamily: 'inherit', outline: 'none' }}
        />
        <Btn onClick={go} disabled={blocked || draft.trim() === ''}>{t('dirPicker.go')}</Btn>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <Btn onClick={() => home !== undefined && void browse(home)} disabled={blocked || home === undefined}>{t('dirPicker.home')}</Btn>
        <Btn onClick={() => parent !== undefined && void browse(parent)} disabled={blocked || parent === undefined}>{t('dirPicker.up')}</Btn>
        <code style={{ fontSize: 12, opacity: 0.75, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current}</code>
      </div>
      <div style={{ minHeight: 120, maxHeight: 240, overflowY: 'auto', border: '1px solid rgba(127,127,127,.3)', borderRadius: 6, padding: 4 }}>
        {(listing?.entries ?? []).filter((e) => !e.hidden).map((entry) => (
          <div
            key={entry.path}
            onClick={() => { if (!blocked) void browse(entry.path) }}
            title={entry.path}
            style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '3px 8px', borderRadius: 4, cursor: blocked ? 'default' : 'pointer', fontSize: 13 }}
            onMouseEnter={(e) => {
              if (!blocked) e.currentTarget.style.background = 'rgba(77,107,254,.18)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
            }}
          >
            <span>📁</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
          </div>
        ))}
        {!loading && (listing?.entries ?? []).length === 0 && error === undefined && (
          <div style={{ padding: 8, opacity: 0.6, fontSize: 12 }}>{t('dirPicker.empty')}</div>
        )}
        {loading && <div style={{ padding: 8, opacity: 0.6, fontSize: 12 }}>{t('common.loading')}</div>}
      </div>
      {listing?.truncated === true && (
        <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>{t('flow.truncated')}</div>
      )}
      {error !== undefined && <Notice kind="error">{error}</Notice>}
      {mkdirOpen
        ? (
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input
              value={mkdirName}
              onChange={(e) => setMkdirName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') mkdir()
              }}
              placeholder={t('flow.mkdirName')}
              disabled={disabled}
              spellCheck={false}
              style={{ flex: 1, background: 'rgba(127,127,127,.12)', color: 'inherit', border: '1px solid rgba(127,127,127,.35)', borderRadius: 6, padding: '4px 8px', fontSize: 13, fontFamily: 'inherit', outline: 'none' }}
            />
            <Btn kind="primary" onClick={mkdir} disabled={disabled || mkdirName.trim() === ''}>{t('flow.create')}</Btn>
            <Btn onClick={() => { setMkdirOpen(false); setMkdirName('') }} disabled={disabled}>{t('hosts.cancel')}</Btn>
          </div>
        )
        : (
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Btn onClick={() => setMkdirOpen(true)} disabled={blocked || current === ''}>{t('flow.mkdir')}</Btn>
            <span style={{ flex: 1 }} />
            <Btn kind="primary" onClick={() => props.onPicked(current)} disabled={blocked || current === ''}>{t('flow.open')}</Btn>
          </div>
        )}
    </div>
  )
}

function RemoteLeg(props: {
  t: (k: string) => string
  busy: boolean
  onPicked: (aliasPath: string) => void
  onCancel: () => void
}): ReactNode {
  const { t } = props
  const [hosts, setHosts] = useState<RemoteHostSummary[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [done, setDone] = useState(false)

  useEffect(() => {
    let live = true
    api.getHosts().then(
      (rows) => {
        if (live) setHosts(rows)
      },
      (e: unknown) => {
        if (live) setError(e instanceof RemoteApiError ? e.message : String(e))
      },
    )
    return () => {
      live = false
    }
  }, [])

  if (error !== undefined) {
    return (
      <div style={{ padding: '4px 0' }}>
        <Notice kind="error">{error}</Notice>
      </div>
    )
  }
  if (hosts === undefined) {
    return <div style={{ padding: 12, opacity: 0.6, fontSize: 12 }}>{t('common.loading')}</div>
  }
  if (hosts.length === 0) {
    return (
      <div style={{ padding: '4px 0' }}>
        <Notice kind="info">{t('flow.noHosts')}</Notice>
      </div>
    )
  }
  if (done || props.busy) {
    return <div style={{ padding: 12, opacity: 0.6, fontSize: 12 }}>{t('common.loading')}</div>
  }
  return (
    <div style={{ maxHeight: 420, overflowY: 'auto', paddingRight: 2 }}>
      <WorkspaceWizard
        t={t}
        hosts={hosts}
        onDone={() => undefined}
        onCancel={props.onCancel}
        onSaved={(_workspace, aliasPath) => {
          setDone(true)
          props.onPicked(aliasPath)
        }}
      />
    </div>
  )
}

export function RemoteDirectoryFlow(props: DirectoryFlowOwnerProps & DirectoryFlowInjected): ReactNode {
  const [t] = useState(() => makeT(detectLang()))
  const [tab, setTab] = useState<'local' | 'remote'>('local')
  const [epoch, setEpoch] = useState(0)

  const wasOpen = useRef(false)
  useEffect(() => {
    if (props.open && !wasOpen.current) {
      setTab('local')
      setEpoch((n) => n + 1)
    }
    wasOpen.current = props.open
  }, [props.open])

  if (!props.open) return null

  const injected: DirectoryFlowInjected = {
    listDirectory: props.listDirectory,
    createDirectory: props.createDirectory,
    pickDirectory: props.pickDirectory,
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,.45)' }}
      role="dialog"
      aria-modal="true"
      aria-label={t('flow.title')}
      onClick={() => {
        if (!props.busy) props.onCancel()
      }}
    >
      <div
        style={{
          width: 'min(600px, calc(100vw - 32px))',
          maxHeight: 'min(680px, calc(100vh - 32px))',
          display: 'flex',
          flexDirection: 'column',
          background: 'Canvas',
          color: 'CanvasText',
          border: '1px solid rgba(127,127,127,.4)',
          borderRadius: 8,
          padding: 14,
          fontSize: 13,
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !props.busy) props.onCancel()
        }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
          <strong>{t('flow.title')}</strong>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => setTab('local')}
            disabled={props.busy}
            style={{
              background: tab === 'local' ? 'rgba(77,107,254,.25)' : 'rgba(127,127,127,.12)',
              color: 'inherit',
              border: `1px solid ${tab === 'local' ? 'rgba(77,107,254,.6)' : 'rgba(127,127,127,.3)'}`,
              borderRadius: 6,
              padding: '4px 12px',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {t('flow.local')}
          </button>
          <button
            type="button"
            onClick={() => setTab('remote')}
            disabled={props.busy}
            style={{
              background: tab === 'remote' ? 'rgba(77,107,254,.25)' : 'rgba(127,127,127,.12)',
              color: 'inherit',
              border: `1px solid ${tab === 'remote' ? 'rgba(77,107,254,.6)' : 'rgba(127,127,127,.3)'}`,
              borderRadius: 6,
              padding: '4px 12px',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {t('flow.remote')}
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {tab === 'local'
            ? <LocalLeg key={`local-${epoch}`} t={t} busy={props.busy} injected={injected} onPicked={props.onPicked} />
            : <RemoteLeg key={`remote-${epoch}`} t={t} busy={props.busy} onPicked={props.onPicked} onCancel={props.onCancel} />}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <Btn onClick={props.onCancel} disabled={props.busy}>{t('hosts.cancel')}</Btn>
        </div>
      </div>
    </div>
  )
}
