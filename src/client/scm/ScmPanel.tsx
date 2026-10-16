/**
 * Source control panel: commit box, changes (unstaged + untracked), staged
 * changes, stash stack, and the repository block (branch, ahead/behind, sync,
 * branches and remotes).
 *
 * All verbs go to the remote host through `scm/actions`; destructive ones
 * (discard, delete branch, drop stash, push) raise the themed confirm first,
 * and every successful write refreshes the shared status so the tree markers
 * and the change list never disagree.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { GitBranch, GitRemote, GitStash } from '../../protocol.ts'
import { useExplorer } from '../store.tsx'
import {
  branchOp,
  commitAll,
  discardPaths,
  GitOpError,
  loadBranches,
  loadRemotes,
  loadStashes,
  lastCommitMessage,
  remoteOp,
  stagePaths,
  stashOp,
  syncRepo,
  unstagePaths,
} from './actions.ts'
import type { ChangeEntry } from './status-map.ts'
import { RepoPicker } from './RepoPicker.tsx'
import {
  IconBranch,
  IconButton,
  IconCheck,
  IconChevronRight,
  IconClose,
  IconFolder,
  IconPlus,
  IconRefresh,
  IconSync,
  IconTrash,
  IconUndo,
  FileIcon,
  MiniSpinner,
  baseName,
  confirmDialog,
  fullTime,
  gitStatusClass,
  gitLetter,
  isPreviewOnlyFile,
  promptDialog,
  toast,
} from '../vsc/kit.tsx'

const MSG_KEY = 'dsh-remote-vs.commitMsg'

function messageOf(error: unknown): string {
  return error instanceof GitOpError || error instanceof Error ? error.message : String(error)
}

export function ScmPanel(props: { onOpenHistory: () => void; visible: boolean }): ReactNode {
  const store = useExplorer()
  const { t, lang, buckets, head, alias, repoRoot } = store
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const [message, setMessage] = useState<string>(() => {
    try {
      return localStorage.getItem(MSG_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [stashes, setStashes] = useState<GitStash[]>([])
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [remotes, setRemotes] = useState<GitRemote[]>([])
  const [branchOpen, setBranchOpen] = useState(false)
  const [remoteOpen, setRemoteOpen] = useState(false)
  const [newBranch, setNewBranch] = useState('')
  const [remoteForm, setRemoteForm] = useState({ name: '', url: '' })
  const [picker, setPicker] = useState(false)

  const fold = (id: string): void => setFolded(prev => ({ ...prev, [id]: prev[id] !== true }))

  useEffect(() => {
    try {
      localStorage.setItem(MSG_KEY, message)
    } catch {
      // Private mode: ignore.
    }
  }, [message])

  const loadExtras = useCallback(async (): Promise<void> => {
    if (alias === '' || repoRoot === undefined) {
      setStashes([])
      setBranches([])
      setRemotes([])
      return
    }
    try {
      const [stashList, branchList, remoteList] = await Promise.all([
        loadStashes(alias, repoRoot),
        loadBranches(alias, repoRoot, head?.branch ?? ''),
        loadRemotes(alias, repoRoot),
      ])
      setStashes(stashList)
      setBranches(branchList)
      setRemotes(remoteList)
    } catch {
      // The panel degrades: status stays usable without the extras.
    }
  }, [alias, repoRoot, head?.branch])

  /**
   * What the extras are keyed by: the three values `loadExtras` is built from.
   * Keying this effect on `status` instead re-ran all three remote git commands
   * on EVERY write made through the plugin — a successful refresh always mints
   * a fresh status object, so saving in the editor reloaded the stash / branch /
   * remote lists. The panel's own verbs still refresh them explicitly
   * (`refreshAll`).
   */
  const extrasKey = JSON.stringify([alias, repoRoot ?? '', head?.branch ?? ''])
  const listedExtras = useRef('')
  useEffect(() => {
    // A parked panel stays MOUNTED behind `display:none`: it may not spend three
    // remote git commands getting ready for a view it is not in. It catches up
    // on the way back — the key is only recorded while it IS on screen, so a
    // change made while parked still reads as pending.
    if (props.visible === false || listedExtras.current === extrasKey) return
    listedExtras.current = extrasKey
    void loadExtras()
  }, [extrasKey, loadExtras, props.visible])

  const refreshAll = useCallback(async (): Promise<void> => {
    await store.afterWrite()
    await loadExtras()
  }, [store, loadExtras])

  /** Open one change: previews for images, diffs otherwise. */
  const openChange = (entry: ChangeEntry): void => {
    // `-u normal` reports an untracked DIRECTORY as one `dir/` row: it has no
    // file diff, so the change list says so instead of opening an empty pane.
    if (entry.path.endsWith('/')) {
      toast(t('scm.dirEntry'), false)
      return
    }
    // A conflicted path has no single diff: `git diff` prints a combined
    // `diff --cc` block with `@@@` hunks, which the unified-diff parsers do
    // not recognise. The result was worse than "no diff" — with no hunks and
    // no stage-0 side to read, the projection marked EVERY line as added and
    // the pane claimed the whole file was new. Send the user to the file
    // instead, where the conflict markers can actually be resolved.
    if (entry.status === 'U') {
      store.openFile(`${repoRoot?.replace(/\/+$/, '') ?? store.root}/${entry.path}`)
      toast(t('scm.conflictOpen'), false)
      return
    }
    if (isPreviewOnlyFile(entry.path)) {
      store.openFile(`${repoRoot?.replace(/\/+$/, '') ?? store.root}/${entry.path}`)
      return
    }
    store.openDiff(entry.path, entry.staged, entry.status === '?')
  }

  const guard = async (action: string, body: () => Promise<void>): Promise<void> => {
    setBusy(action)
    try {
      await body()
      await refreshAll()
    } catch (error) {
      toast(messageOf(error), true)
    } finally {
      setBusy(undefined)
    }
  }

  const discardOne = async (entry: ChangeEntry): Promise<void> => {
    if (repoRoot === undefined) return
    const ok = await confirmDialog({
      title: entry.status === '?' ? t('scm.deleteUntrackedTitle') : t('scm.discardTitle'),
      text: (entry.status === '?' ? t('scm.deleteUntrackedText') : t('scm.discardText')).replace('{path}', entry.path),
      danger: true,
      okText: entry.status === '?' ? t('files.delete') : t('scm.discard'),
    })
    if (!ok) return
    await guard('discard', async () => {
      if (entry.status === '?') await discardPaths(alias, repoRoot, [], [entry.path])
      else await discardPaths(alias, repoRoot, [entry.path], [])
      toast(t('scm.discarded'))
    })
  }

  const stageOne = async (entry: ChangeEntry, staged: boolean): Promise<void> => {
    if (repoRoot === undefined) return
    await guard(`stage:${entry.path}`, async () => {
      if (staged) await unstagePaths(alias, repoRoot, [entry.path])
      else await stagePaths(alias, repoRoot, [entry.path])
    })
  }

  const doCommit = async (): Promise<void> => {
    if (repoRoot === undefined || message.trim() === '') return
    await guard('commit', async () => {
      await commitAll(alias, repoRoot, message)
      setMessage('')
      try {
        localStorage.removeItem(MSG_KEY)
      } catch {
        // Ignore.
      }
      toast(t('scm.committed'))
    })
  }

  const amend = async (): Promise<void> => {
    if (repoRoot === undefined) return
    const previous = await lastCommitMessage(alias, repoRoot)
    const next = await promptDialog({
      title: t('scm.amendTitle'),
      text: t('scm.amendText'),
      initial: previous,
      okText: t('scm.commit'),
    })
    if (next === undefined || next.trim() === '') return
    await guard('amend', async () => {
      await commitAll(alias, repoRoot, next, true)
      toast(t('scm.committed'))
    })
  }

  const doSync = async (kind: 'fetch' | 'pull' | 'push' | 'sync'): Promise<void> => {
    if (repoRoot === undefined) return
    if (kind === 'push' || kind === 'sync') {
      const ok = await confirmDialog({
        title: kind === 'push' ? t('scm.pushTitle') : t('scm.syncTitle'),
        text: kind === 'push' ? t('scm.pushText') : t('scm.syncText'),
        okText: kind === 'push' ? t('scm.push') : t('scm.sync'),
      })
      if (!ok) return
    }
    await guard(kind, async () => {
      const output = await syncRepo(alias, repoRoot, kind)
      toast(`${t('scm.syncDone')} ${output.split('\n').slice(-1)[0] ?? ''}`.trim())
    })
  }

  const saveStash = async (): Promise<void> => {
    if (repoRoot === undefined) return
    const text = await promptDialog({
      title: t('scm.stashSaveTitle'),
      text: t('scm.stashSaveText'),
      initial: '',
      okText: t('scm.stashSave'),
    })
    if (text === undefined) return
    await guard('stash', async () => {
      await stashOp(alias, repoRoot, { kind: 'save', message: text, includeUntracked: true })
      toast(t('scm.stashSaved'))
    })
  }

  const changes = buckets.changes
  const staged = buckets.staged
  const conflicts = buckets.conflicts
  const aheadBehind = head !== undefined && (head.ahead > 0 || head.behind > 0)
    ? `↑${head.ahead} ↓${head.behind}`
    : ''

  const section = (
    id: string,
    title: string,
    count: string | number | undefined,
    actions: ReactNode,
    body: () => ReactNode,
  ): ReactNode => {
    const collapsed = folded[id] === true
    return (
      <div className={`rvs-scm-section${collapsed ? ' collapsed' : ''}`}>
        <div className="rvs-scm-head" onClick={() => fold(id)}>
          <span className={`rvs-chevron${collapsed ? '' : ' open'}`}><IconChevronRight size={12} /></span>
          <span>{title}</span>
          <span className="rvs-scm-head-actions" onClick={(e) => e.stopPropagation()}>{actions}</span>
          {count !== undefined && count !== '' && count !== 0 && <span className="rvs-count">{count}</span>}
        </div>
        {/*
          `body` is a thunk, and neither a folded nor a parked section calls it.
          As a plain argument the whole change list — up to the 4000 entries
          `git-ops.ts` stops at, ~8 elements each, a `fileIcon` service call per
          row — was constructed before `section` was even entered, so collapsing
          only hid it with CSS while React kept rebuilding every row on every
          publish (the panel is keep-alive and subscribes to the whole store).
        */}
        {collapsed || props.visible === false ? null : body()}
      </div>
    )
  }

  const changeRow = (entry: ChangeEntry, isStaged: boolean): ReactNode => (
    <div
      key={`${isStaged ? 's' : 'u'}:${entry.path}`}
      className="rvs-scm-item"
      role="button"
      tabIndex={0}
      title={`${entry.path}\n${t('scm.openHint')}`}
      onClick={() => openChange(entry)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openChange(entry) }}
    >
      <span className="rvs-node-icon"><FileIcon path={entry.path} size={14} /></span>
      <span className="rvs-scm-path">{entry.path}</span>
      {(entry.oldPath ?? '') !== '' && <span className="rvs-scm-dir">← {entry.oldPath}</span>}
      <span className={`rvs-file-status rvs-letter-${gitStatusClass(entry.status)}`}>{gitLetter(entry.status)}</span>
      <span className="rvs-scm-actions">
        <IconButton
          title={isStaged ? t('scm.unstage') : t('scm.stage')}
          disabled={busy !== undefined}
          onClick={() => { void stageOne(entry, isStaged) }}
        >
          {isStaged ? <IconClose size={12} /> : <IconPlus size={13} />}
        </IconButton>
        {!isStaged && (
          <IconButton
            title={entry.status === '?' ? t('scm.deleteUntracked') : t('scm.discard')}
            danger
            disabled={busy !== undefined}
            onClick={() => { void discardOne(entry) }}
          >
            <IconTrash size={13} />
          </IconButton>
        )}
      </span>
    </div>
  )

  return (
    <div className="rvs-pane grow">
      <div className="rvs-header">
        <span className="rvs-title">{t('scm.title')}</span>
        {store.gitBusy && <MiniSpinner />}
        <IconButton title={t('scm.refresh')} onClick={() => { void refreshAll() }} disabled={store.gitBusy}>
          <IconRefresh size={14} />
        </IconButton>
      </div>
      {/* Git answers for the directory it runs in, so a binding whose repository
          sits in a sub-directory needs this row (the workspace picker above only
          names the binding). */}
      <div className="rvs-repo-bar" title={store.repoWorkdir === '' ? undefined : store.repoWorkdir}>
        <span className="rvs-repo-bar-label">{t('scm.repoDir')}</span>
        <button
          type="button"
          className="rvs-repo-bar-path"
          title={t('scm.repoDirHint')}
          onClick={() => setPicker(true)}
        >
          {store.repoSubdir === '' ? t('scm.repoDirRoot') : store.repoSubdir}
        </button>
        {store.repoSubdir !== '' && (
          <IconButton
            title={t('scm.repoDirReset')}
            disabled={store.gitBusy}
            onClick={() => {
              void store.setRepoSubdir('').then(() => toast(t('scm.repoDirSwitched')))
            }}
          >
            <IconClose size={12} />
          </IconButton>
        )}
        <IconButton title={t('scm.browse')} onClick={() => setPicker(true)}>
          <IconFolder size={14} />
        </IconButton>
      </div>
      {picker && (
        <RepoPicker
          alias={alias}
          root={store.root}
          current={store.repoSubdir}
          onClose={() => setPicker(false)}
          onPick={(subdir) => {
            setPicker(false)
            void store.setRepoSubdir(subdir).then(() => toast(t('scm.repoDirSwitched')))
          }}
        />
      )}
      <div className="rvs-scroll">
        {repoRoot === undefined && (
          <div className="rvs-empty">
            {/* A failed refresh has to say WHY. Keying this purely off
                repoMissing/repoRoot meant a failing `git status` (huge repo,
                dubious ownership, locked index) rendered "Loading…" forever
                while the reason sat unread in store.gitError. */}
            {store.gitError !== undefined
              ? store.gitError
              : store.repoMissing ? t('git.hint') : t('common.loading')}
            {store.repoMissing && (
              <div className="rvs-repo-bar-fix">
                <button type="button" className="rvs-chip" onClick={() => setPicker(true)}>{t('scm.browse')}</button>
              </div>
            )}
          </div>
        )}
        {repoRoot !== undefined && (
          <>
            {conflicts.length > 0 && section(
              'conflicts',
              t('scm.conflicts'),
              conflicts.length,
              <IconButton
                title={t('scm.stageAll')}
                disabled={busy !== undefined}
                onClick={() => { void guard('stageAll', async () => { await stagePaths(alias, repoRoot, conflicts.map(item => item.path)) }) }}
              >
                <IconPlus size={13} />
              </IconButton>,
              () => <div>{conflicts.map(entry => changeRow(entry, false))}</div>,
            )}

            <div className="rvs-commit-box">
              <textarea
                className="rvs-commit-input"
                placeholder={head === undefined ? t('scm.commitPlaceholder') : `${t('scm.commitPlaceholder')} (${head.branch})`}
                value={message}
                spellCheck={false}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault()
                    void doCommit()
                  }
                }}
              />
              <div className="rvs-commit-row">
                <button
                  type="button"
                  className="rvs-commit-btn"
                  disabled={busy !== undefined || message.trim() === '' || staged.length === 0}
                  title={t('scm.commitHint')}
                  onClick={() => { void doCommit() }}
                >
                  {busy === 'commit' ? `${t('scm.committing')}…` : t('scm.commit')}
                </button>
                <button
                  type="button"
                  className="rvs-chip"
                  title={t('scm.amend')}
                  disabled={busy !== undefined}
                  onClick={() => { void amend() }}
                >
                  <IconUndo size={13} />
                </button>
              </div>
              {staged.length === 0 && changes.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--rvs-fg3)' }}>{t('scm.commitNeedsStage')}</div>
              )}
            </div>

            {section(
              'changes',
              t('scm.changes'),
              changes.length,
              <>
                {changes.length > 0 && (
                  <IconButton
                    title={t('scm.stageAll')}
                    disabled={busy !== undefined}
                    onClick={() => { void guard('stageAll', async () => { await stagePaths(alias, repoRoot, changes.map(item => item.path)) }) }}
                  >
                    <IconPlus size={13} />
                  </IconButton>
                )}
                {changes.length > 0 && (
                  <IconButton
                    title={t('scm.discardAll')}
                    danger
                    disabled={busy !== undefined}
                    onClick={() => {
                      void (async () => {
                        const ok = await confirmDialog({
                          title: t('scm.discardAllTitle'),
                          text: t('scm.discardAllText').replace('{count}', String(changes.length)),
                          danger: true,
                          okText: t('scm.discard'),
                        })
                        if (!ok) return
                        await guard('discardAll', async () => {
                          const tracked = changes.filter(item => item.status !== '?').map(item => item.path)
                          const untracked = changes.filter(item => item.status === '?').map(item => item.path)
                          await discardPaths(alias, repoRoot, tracked, untracked)
                          toast(t('scm.discarded'))
                        })
                      })()
                    }}
                  >
                    <IconTrash size={13} />
                  </IconButton>
                )}
              </>,
              () => (changes.length === 0
                ? <div className="rvs-empty">{t('scm.noChanges')}</div>
                : <div>{changes.map(entry => changeRow(entry, false))}</div>),
            )}

            {staged.length > 0 && section(
              'staged',
              t('scm.staged'),
              staged.length,
              <IconButton
                title={t('scm.unstageAll')}
                disabled={busy !== undefined}
                onClick={() => { void guard('unstageAll', async () => { await unstagePaths(alias, repoRoot, staged.map(item => item.path)) }) }}
              >
                <IconClose size={12} />
              </IconButton>,
              () => <div>{staged.map(entry => changeRow(entry, true))}</div>,
            )}

            {section(
              'stash',
              t('scm.stashes'),
              stashes.length,
              <>
                <IconButton title={t('scm.stashSave')} disabled={busy !== undefined} onClick={() => { void saveStash() }}>
                  <IconPlus size={13} />
                </IconButton>
                <IconButton title={t('scm.refresh')} disabled={busy !== undefined} onClick={() => { void loadExtras() }}>
                  <IconRefresh size={13} />
                </IconButton>
              </>,
              () => (stashes.length === 0
                ? <div className="rvs-empty">{t('scm.noStash')}</div>
                : (
                  <div>
                    {stashes.map(item => (
                      <div key={item.ref} className="rvs-scm-item" style={{ cursor: 'default' }} title={`${item.ref}  ${fullTime(item.date)}`}>
                        <span className="rvs-node-icon"><IconCheck size={13} /></span>
                        <span className="rvs-scm-path">{item.message === '' ? item.ref : item.message}</span>
                        <span className="rvs-scm-actions" style={{ display: 'flex' }}>
                          <IconButton
                            title={t('scm.stashApply')}
                            disabled={busy !== undefined}
                            onClick={() => { void guard('stash', async () => { await stashOp(alias, repoRoot, { kind: 'pop', ref: item.ref }); toast(t('scm.stashApplied')) }) }}
                          >
                            <IconUndo size={13} />
                          </IconButton>
                          <IconButton
                            title={t('scm.stashDrop')}
                            danger
                            disabled={busy !== undefined}
                            onClick={() => {
                              void (async () => {
                                const ok = await confirmDialog({
                                  title: t('scm.stashDropTitle'),
                                  text: item.ref,
                                  danger: true,
                                  okText: t('scm.stashDrop'),
                                })
                                if (!ok) return
                                await guard('stash', async () => { await stashOp(alias, repoRoot, { kind: 'drop', ref: item.ref }) })
                              })()
                            }}
                          >
                            <IconTrash size={13} />
                          </IconButton>
                        </span>
                      </div>
                    ))}
                  </div>
                )),
            )}

            {section(
              'repository',
              t('scm.repository'),
              aheadBehind,
              <>
                <IconButton title={t('scm.fetch')} disabled={busy !== undefined} onClick={() => { void doSync('fetch') }}>↓</IconButton>
                <IconButton title={t('scm.pull')} disabled={busy !== undefined} onClick={() => { void doSync('pull') }}>⇣</IconButton>
                <IconButton title={t('scm.push')} disabled={busy !== undefined} onClick={() => { void doSync('push') }}>↑</IconButton>
                <IconButton title={t('scm.sync')} disabled={busy !== undefined} onClick={() => { void doSync('sync') }}>
                  <IconSync size={14} />
                </IconButton>
              </>,
              () => <div style={{ paddingBottom: 8 }}>
                <div className="rvs-repo-item" style={{ cursor: 'default' }}>
                  <span className="rvs-node-icon" style={{ color: 'var(--rvs-brand)' }}><IconBranch size={14} /></span>
                  <span className="rvs-repo-name" style={{ direction: 'rtl', unicodeBidi: 'plaintext', textAlign: 'left' }} title={repoRoot}>{baseName(repoRoot)}</span>
                  <span className="rvs-repo-branch">{head?.branch ?? ''}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '2px 10px 2px 12px' }}>
                  <span className="rvs-pill">⑂ {head?.detached === true ? t('scm.detached') : (head?.branch ?? '—')}</span>
                  <button type="button" className="rvs-chip" onClick={() => setBranchOpen(v => !v)}>{t('scm.branches')}</button>
                  <button type="button" className="rvs-chip" onClick={() => setRemoteOpen(v => !v)}>{t('scm.remotes')}</button>
                </div>

                {branchOpen && (
                  <div className="rvs-subpanel">
                    <div className="rvs-subpanel-head">
                      <span>{t('scm.branches')}</span>
                      <span className="rvs-einfo-spacer" />
                      <IconButton title={t('common.close')} onClick={() => setBranchOpen(false)}><IconClose size={11} /></IconButton>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        className="rvs-input"
                        placeholder={t('scm.newBranch')}
                        value={newBranch}
                        onChange={(e) => setNewBranch(e.target.value)}
                      />
                      <button
                        type="button"
                        className="rvs-chip primary"
                        disabled={newBranch.trim() === '' || busy !== undefined}
                        onClick={() => {
                          const name = newBranch.trim()
                          setNewBranch('')
                          void guard('branch', async () => { await branchOp(alias, repoRoot, { kind: 'create', name }) })
                        }}
                      >
                        {t('scm.create')}
                      </button>
                    </div>
                    <div style={{ marginTop: 6, maxHeight: 200, overflow: 'auto' }}>
                      {branches.map(branch => (
                        <div key={branch.name} className="rvs-scm-item" style={{ cursor: 'default', paddingLeft: 4 }} title={branch.short}>
                          <span className="rvs-node-icon">{branch.head ? '➤' : ''}</span>
                          <span className="rvs-scm-path">
                            {branch.name}
                            {branch.remote === true && <span className="rvs-scm-dir"> · remote</span>}
                          </span>
                          <span className="rvs-scm-actions" style={{ display: 'flex' }}>
                            {!branch.head && (
                              <IconButton
                                title={t('scm.checkout')}
                                disabled={busy !== undefined}
                                onClick={() => {
                                  void (async () => {
                                    const ok = await confirmDialog({
                                      title: t('scm.checkoutTitle'),
                                      text: t('scm.checkoutText').replace('{branch}', branch.name),
                                      okText: t('scm.checkout'),
                                    })
                                    if (!ok) return
                                    await guard('checkout', async () => {
                                      await branchOp(alias, repoRoot, { kind: 'checkout', ref: branch.name })
                                      toast(`${t('scm.checkedOut')} ${branch.name}`)
                                    })
                                  })()
                                }}
                              >
                                <IconCheck size={13} />
                              </IconButton>
                            )}
                            {!branch.head && branch.remote !== true && (
                              <IconButton
                                title={t('scm.merge')}
                                disabled={busy !== undefined}
                                onClick={() => { void guard('merge', async () => { await branchOp(alias, repoRoot, { kind: 'merge', ref: branch.name }) }) }}
                              >
                                ⤵
                              </IconButton>
                            )}
                            {!branch.head && branch.remote === true && (
                              <IconButton
                                title={t('scm.publish')}
                                disabled={busy !== undefined}
                                onClick={() => { void guard('publish', async () => { await branchOp(alias, repoRoot, { kind: 'publish', name: branch.name, remote: 'origin' }) }) }}
                              >
                                ↑
                              </IconButton>
                            )}
                            {!branch.head && branch.remote !== true && (
                              <IconButton
                                title={t('scm.deleteBranch')}
                                danger
                                disabled={busy !== undefined}
                                onClick={() => {
                                  void (async () => {
                                    const ok = await confirmDialog({
                                      title: t('scm.deleteBranchTitle'),
                                      text: branch.name,
                                      danger: true,
                                      okText: t('files.delete'),
                                    })
                                    if (!ok) return
                                    await guard('branch', async () => {
                                      await branchOp(alias, repoRoot, { kind: 'delete', name: branch.name, force: false })
                                    })
                                  })()
                                }}
                              >
                                <IconTrash size={13} />
                              </IconButton>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {remoteOpen && (
                  <div className="rvs-subpanel">
                    <div className="rvs-subpanel-head">
                      <span>{t('scm.remotes')}</span>
                      <span className="rvs-einfo-spacer" />
                      <IconButton title={t('common.close')} onClick={() => setRemoteOpen(false)}><IconClose size={11} /></IconButton>
                    </div>
                    {remotes.map(remote => (
                      <div key={`${remote.name}:${remote.kind}`} className="rvs-scm-item" style={{ cursor: 'default', paddingLeft: 4 }}>
                        <span className="rvs-scm-path" title={remote.url}>{remote.name} <span className="rvs-scm-dir">{remote.kind}</span></span>
                        {remote.kind === 'fetch' && (
                          <span className="rvs-scm-actions" style={{ display: 'flex' }}>
                            <IconButton
                              title={t('scm.removeRemote')}
                              danger
                              disabled={busy !== undefined}
                              onClick={() => { void guard('remote', async () => { await remoteOp(alias, repoRoot, { kind: 'remove', name: remote.name }) }) }}
                            >
                              <IconTrash size={13} />
                            </IconButton>
                          </span>
                        )}
                      </div>
                    ))}
                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      <input
                        className="rvs-input"
                        placeholder={t('scm.remoteName')}
                        value={remoteForm.name}
                        onChange={(e) => setRemoteForm(prev => ({ ...prev, name: e.target.value }))}
                      />
                      <input
                        className="rvs-input"
                        placeholder={t('scm.remoteUrl')}
                        value={remoteForm.url}
                        onChange={(e) => setRemoteForm(prev => ({ ...prev, url: e.target.value }))}
                      />
                      <button
                        type="button"
                        className="rvs-chip primary"
                        disabled={remoteForm.name.trim() === '' || remoteForm.url.trim() === '' || busy !== undefined}
                        onClick={() => {
                          const form = { name: remoteForm.name.trim(), url: remoteForm.url.trim() }
                          setRemoteForm({ name: '', url: '' })
                          void guard('remote', async () => { await remoteOp(alias, repoRoot, { kind: 'add', ...form }) })
                        }}
                      >
                        {t('scm.addRemote')}
                      </button>
                    </div>
                  </div>
                )}
              </div>,
            )}

            {section(
              'shortcut',
              t('scm.more'),
              undefined,
              undefined,
              () => <div style={{ padding: '4px 10px 10px' }}>
                <button type="button" className="rvs-chip" onClick={() => props.onOpenHistory()}>{t('tab.history')} →</button>
              </div>,
            )}
          </>
        )}
      </div>
    </div>
  )
}
