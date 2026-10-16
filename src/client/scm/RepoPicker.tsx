/**
 * Repository directory picker (SCM): a workspace binding is often a container
 * (`/srv/sites`) while the repository sits one or more levels below it
 * (`/srv/sites/shop/.git`). Git only answers for the directory it runs in, so
 * this dialog browses the REMOTE tree under the workspace root and reports, per
 * directory, which repository it would resolve to before the user commits.
 *
 * Three ways in, because they cover different situations:
 *  - the discovered-repository list (one `find` under the workspace root, max
 *    depth 3) for the common case,
 *  - drilling through directories (dirs only, `..` included),
 *  - typing or pasting a path (relative or absolute inside the workspace) when
 *    the tree is deep.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../api.ts'
import { normalizeRepoSubdir, repoSubdirOf, repoWorkdir } from '../../git-ops.ts'
import { resolveRepoRoot } from './actions.ts'
import { IconButton, IconChevronRight, IconClose, IconFolder, IconRefresh, FolderIcon, MiniSpinner } from '../vsc/kit.tsx'
import { useExplorer } from '../store.tsx'

/** What git resolves to for the directory currently being browsed. */
type Probe =
  | { kind: 'loading' }
  | { kind: 'root' }
  | { kind: 'inside'; subdir: string }
  | { kind: 'none' }
  | { kind: 'error'; message: string }

export function RepoPicker(props: {
  alias: string
  /** Absolute workspace root (the tree the picker may browse). */
  root: string
  /** Currently selected workspace-relative directory ('' = the root). */
  current: string
  onPick: (subdir: string) => void
  onClose: () => void
}): ReactNode {
  const store = useExplorer()
  const { t } = store
  const [cwd, setCwd] = useState<string>(() => repoWorkdir(props.root, props.current))
  const [dirs, setDirs] = useState<{ name: string; path: string }[]>([])
  const [listing, setListing] = useState(false)
  const [probe, setProbe] = useState<Probe>({ kind: 'loading' })
  const [candidates, setCandidates] = useState<string[] | undefined>(undefined)
  const [finding, setFinding] = useState(false)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)

  const rel = repoSubdirOf(props.root, cwd) ?? ''
  const insideRoot = repoSubdirOf(props.root, cwd) !== undefined

  // Directory listing + repository probe for the browsed directory.
  useEffect(() => {
    let cancelled = false
    setListing(true)
    setProbe({ kind: 'loading' })
    api.fileOp.list(props.alias, cwd).then(
      (entries) => {
        if (cancelled) return
        setDirs(
          entries
            .filter(entry => entry.isDir)
            .map(entry => ({ name: entry.name, path: entry.path }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        )
        setListing(false)
      },
      (e: unknown) => {
        if (cancelled) return
        setDirs([])
        setListing(false)
        setError(e instanceof Error ? e.message : String(e))
      },
    )
    resolveRepoRoot(props.alias, cwd).then(
      (found) => {
        if (cancelled) return
        if (found === undefined) setProbe({ kind: 'none' })
        else if (found === cwd) setProbe({ kind: 'root' })
        else setProbe({ kind: 'inside', subdir: repoSubdirOf(props.root, found) ?? found })
      },
      (e: unknown) => {
        if (cancelled) return
        setProbe({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
      },
    )
    return () => { cancelled = true }
  }, [props.alias, props.root, cwd])

  const find = useCallback(async (): Promise<void> => {
    setFinding(true)
    try {
      setCandidates(await store.discoverRepos())
    } finally {
      setFinding(false)
    }
  }, [store])

  // Discovery runs once when the dialog opens: it is the shortest path for the
  // "my repository is in a subdirectory somewhere" case.
  useEffect(() => { void find() }, [find])

  const parent = useMemo(() => {
    if (!insideRoot) return undefined
    if (rel === '') return undefined
    const cut = rel.lastIndexOf('/')
    return repoWorkdir(props.root, cut === -1 ? '' : rel.slice(0, cut))
  }, [insideRoot, rel, props.root])

  const jump = (input: string): void => {
    const value = input.trim()
    if (value === '') return
    if (value.startsWith('/')) {
      const subdir = repoSubdirOf(props.root, value.replace(/\/+$/, ''))
      if (subdir === undefined) {
        setError(t('scm.pickOutside'))
        return
      }
      setError(undefined)
      setCwd(repoWorkdir(props.root, subdir))
      setTyped('')
      return
    }
    setError(undefined)
    setCwd(repoWorkdir(props.root, normalizeRepoSubdir(value)))
    setTyped('')
  }

  const crumbs = rel === '' ? [] : rel.split('/')

  return (
    <div className="rvs-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose() }}>
      <div className="rvs-modal-box rvs-repopick" role="dialog" aria-label={t('scm.pickTitle')}>
        <div className="rvs-modal-title">
          {t('scm.pickTitle')}
          <IconButton title={t('common.close')} onClick={props.onClose}><IconClose size={13} /></IconButton>
        </div>

        <div className="rvs-repopick-bar">
          <button type="button" className="rvs-crumb" onClick={() => setCwd(props.root)}>{t('scm.repoDirRoot')}</button>
          {crumbs.map((part, index) => (
            <span key={`${part}-${index}`} className="rvs-crumb-wrap">
              <IconChevronRight size={11} />
              <button
                type="button"
                className="rvs-crumb"
                onClick={() => setCwd(repoWorkdir(props.root, crumbs.slice(0, index + 1).join('/')))}
              >
                {part}
              </button>
            </span>
          ))}
          {listing && <MiniSpinner />}
        </div>

        <div className={`rvs-repopick-probe ${probe.kind}`}>
          {probe.kind === 'loading' && t('common.loading')}
          {probe.kind === 'root' && `✓ ${t('scm.pickRoot')}`}
          {probe.kind === 'inside' && `${t('scm.pickInside')} ${probe.subdir === '' ? t('scm.repoDirRoot') : probe.subdir}`}
          {probe.kind === 'none' && t('scm.pickNone')}
          {probe.kind === 'error' && probe.message}
        </div>

        {candidates !== undefined && (
          <div className="rvs-repopick-found">
            <span className="rvs-repopick-found-label">{t('scm.discoverFound')}</span>
            {candidates.length === 0
              ? <span className="rvs-repopick-dim">{t('scm.discoverEmpty')}</span>
              : candidates.map(dir => (
                <button
                  key={dir === '' ? '.' : dir}
                  type="button"
                  className="rvs-chip"
                  title={repoWorkdir(props.root, dir)}
                  onClick={() => setCwd(repoWorkdir(props.root, dir))}
                >
                  {dir === '' ? t('scm.repoDirRoot') : dir}
                </button>
              ))}
            <IconButton title={t('scm.discover')} onClick={() => { void find() }} disabled={finding}>
              <IconRefresh size={12} />
            </IconButton>
          </div>
        )}

        <div className="rvs-repopick-list">
          {parent !== undefined && (
            <button type="button" className="rvs-repopick-row up" onClick={() => setCwd(parent)}>
              <IconFolder size={14} /><span>..</span>
            </button>
          )}
          {dirs.map(dir => (
            <button key={dir.path} type="button" className="rvs-repopick-row" title={dir.path} onClick={() => setCwd(dir.path)}>
              <FolderIcon path={dir.path} open={false} size={14} />
              <span>{dir.name}</span>
            </button>
          ))}
          {!listing && dirs.length === 0 && <div className="rvs-repopick-dim">{t('scm.pickEmptyDir')}</div>}
        </div>

        <form
          className="rvs-repopick-type"
          onSubmit={(e) => { e.preventDefault(); jump(typed) }}
        >
          <input
            className="rvs-input"
            value={typed}
            spellCheck={false}
            placeholder={t('scm.pickPathPlaceholder')}
            onChange={(e) => setTyped(e.target.value)}
          />
          <button type="submit" className="rvs-chip" disabled={typed.trim() === ''}>{t('scm.pickGo')}</button>
        </form>

        {error !== undefined && <div className="rvs-repopick-error">{error}</div>}

        <div className="rvs-modal-row">
          <button type="button" className="rvs-modal-btn" onClick={props.onClose}>{t('scm.pickCancel')}</button>
          <button
            type="button"
            className="rvs-modal-btn primary"
            disabled={!insideRoot}
            title={cwd}
            onClick={() => props.onPick(rel)}
          >
            {t('scm.pickChoose')}
          </button>
        </div>
      </div>
    </div>
  )
}
