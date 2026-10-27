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
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
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
  stashOp,
  syncRepo,
} from './actions.ts'
import type { ChangeEntry } from './status-map.ts'
import { rowVerb } from './status-map.ts'
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
  ContextMenu,
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
  useContextMenu,
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
  /** Right-click menu of one change row (the floating-editor entry). */
  const menu = useContextMenu()

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

  /**
   * How much of the repository a verb's success invalidates.
   *
   * `all` used to be the answer for EVERY write, which cost three
   * repository-wide git commands (stash list, branches, remotes) per click even
   * when none of them could have changed — on a large repository that is the
   * difference between a click and a coffee break. The extras are reloaded
   * where they can actually change: a stash / branch / remote verb, a sync
   * (which moves ahead/behind), the panel's own ⟳, or the first paint after a
   * repository switch.
   *
   * `status` is for the verbs that move the working tree but touch nothing the
   * extras hold (commit, amend, discard). Stage / unstage do not come through
   * here at all: the store moves the row locally and ONE path-limited status
   * confirms it (see `stageOptimistic`).
   */
  const guard = async (
    action: string,
    body: () => Promise<void>,
    refresh: 'all' | 'status' = 'all',
  ): Promise<void> => {
    setBusy(action)
    try {
      await body()
      if (refresh === 'all') await refreshAll()
      else if (refresh === 'status') await store.afterWrite()
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
    // A discard moves worktree rows only: the stash / branch / remote lists
    // cannot have changed, so the extras stay out of it.
    await guard('discard', async () => {
      if (entry.status === '?') await discardPaths(alias, repoRoot, [], [entry.path])
      else await discardPaths(alias, repoRoot, [entry.path], [])
      toast(t('scm.discarded'))
    }, 'status')
  }

  /**
   * Stage / unstage, the fast way: the row moves between sections at once and
   * ONE path-limited `git status` confirms it — no repository-wide status, no
   * extras (see `store.stageOptimistic`).
   *
   * Deliberately NOT wrapped in `guard`: that helper holds `busy` — and with it
   * every row's buttons — until its refresh is done, which is exactly what made
   * a click feel like a freeze. It would also stop the next click from reaching
   * the same debounce window, so a burst of files could never coalesce into one
   * check. The optimistic move IS the feedback; a verb that failed is rolled
   * back by the store and reported here.
   *
   * The verb is a NAME, not a boolean: `store.stageOptimistic` takes the target
   * state, and a row handler that passed its own section flag straight through
   * would silently invert the action (see `rowVerb`).
   */
  const applyStage = (paths: readonly string[], verb: 'stage' | 'unstage'): void => {
    if (repoRoot === undefined || paths.length === 0) return
    void store.stageOptimistic(paths, verb === 'stage').catch((error: unknown) => { toast(messageOf(error), true) })
  }

  /** The row's own button: `isStaged` is the section it is in, so the verb is the other one. */
  const stageOne = (entry: ChangeEntry, isStaged: boolean): void => {
    applyStage([entry.path], rowVerb(isStaged))
  }

  /** Open one change: previews for images, diffs otherwise. */
  const openChange = (entry: ChangeEntry): void => {
    // A directory row has no single diff. Untracked ones expand instead (see
    // `changeRow`); a STAGED one (which real git reports per file, never as
    // `dir/`) has nothing to open, so the click stays a no-op rather than
    // opening an empty diff pane.
    if (entry.path.endsWith('/')) return
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

  /**
   * The same destination as `openChange`, but in the floating editor.
   *
   * Kept in step with `openChange` on purpose: a conflicted path and a
   * preview-only file are opened as FILES (there is no usable diff), everything
   * else as the working-tree diff the row click would show.
   */
  const openChangeInFloat = (entry: ChangeEntry): void => {
    if (entry.path.endsWith('/')) return
    const abs = `${repoRoot?.replace(/\/+$/, '') ?? store.root}/${entry.path}`
    if (entry.status === 'U' || isPreviewOnlyFile(entry.path)) {
      store.openInFloatEditor(abs)
      return
    }
    store.openDiffInFloatEditor(entry.path, entry.staged, entry.status === '?')
  }

  /** Right-click on one change row: the floating-editor entry. */
  const openRowMenu = (event: ReactMouseEvent, entry: ChangeEntry): void => {
    event.preventDefault()
    event.stopPropagation()
    menu.open(event.clientX, event.clientY, [
      {
        label: t('files.openInFloat'),
        onSelect: () => openChangeInFloat(entry),
        disabled: !store.floatAvailable || entry.path.endsWith('/'),
      },
    ])
  }

  const doCommit = async (): Promise<void> => {
    if (repoRoot === undefined || message.trim() === '') return
    // A commit is a real state transition and the user expects to wait for it:
    // the full status stays. The extras do not — a commit changes no stash,
    // branch or remote.
    await guard('commit', async () => {
      await commitAll(alias, repoRoot, message)
      setMessage('')
      try {
        localStorage.removeItem(MSG_KEY)
      } catch {
        // Ignore.
      }
      toast(t('scm.committed'))
    }, 'status')
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
    // Same as a commit: a real state transition, no extras involved.
    await guard('amend', async () => {
      await commitAll(alias, repoRoot, next, true)
      toast(t('scm.committed'))
    }, 'status')
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

  /**
   * One row. `depth > 0` means it is a file inside an expanded untracked
   * directory: same row, indented, and still fully actionable (staging such a
   * file adds it to "staged changes" — see `store.applyLocalStage`).
   *
   * An UNTRACKED DIRECTORY row (`dir/`) is the one row whose click does not
   * open a diff: it expands instead, because `-u normal` reported the directory
   * alone and its files are otherwise invisible.
   */
  const changeRow = (entry: ChangeEntry, isStaged: boolean, depth = 0): ReactNode => {
    const expandable = !isStaged && entry.path.endsWith('/')
    const expanded = expandable && store.untrackedDirs.has(entry.path)
    const activate = (): void => {
      if (!expandable) {
        openChange(entry)
        return
      }
      void store.toggleUntrackedDir(entry.path).catch((error: unknown) => { toast(messageOf(error), true) })
    }
    return (
      <div
        key={`${isStaged ? 's' : 'u'}:${entry.path}`}
        className="rvs-scm-item"
        role="button"
        tabIndex={0}
        style={depth === 0 ? undefined : { paddingLeft: `${22 + depth * 12}px` }}
        title={expandable ? `${entry.path}\n${t('scm.dirToggle')}` : `${entry.path}\n${t('scm.openHint')}`}
        onClick={activate}
        onContextMenu={(event) => openRowMenu(event, entry)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') activate() }}
      >
        {/* The chevron slot is reserved on EVERY row (11px), so a directory row
            and its files stay in one column instead of shifting by an icon. */}
        <span className={`rvs-chevron${expanded ? ' open' : ''}`} style={{ width: 11 }} aria-hidden="true">
          {expandable ? <IconChevronRight size={11} /> : null}
        </span>
        <span className="rvs-node-icon">{expandable ? <IconFolder size={14} /> : <FileIcon path={entry.path} size={14} />}</span>
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
  }

  /**
   * Rows plus the contents of any expanded untracked directory, in place.
   *
   * The depth cap is defensive: `-uall` answers with files (measured), so a
   * directory row can only appear nested if a future git answers differently —
   * the renderer then recurses on the same rule instead of looping forever.
   */
  const changeRows = (entries: readonly ChangeEntry[], depth = 0): ReactNode =>
    entries.map(entry => (
      <Fragment key={`${depth}:${entry.path}`}>
        {changeRow(entry, false, depth)}
        {depth < 8
          ? changeRows(store.untrackedDirs.get(entry.path) ?? [], depth + 1)
          : null}
      </Fragment>
    ))

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
                while the reason sat unread in store.gitError. The budget is
                part of that honesty: on a large remote tree the wait is
                minutes, and a bare "Loading…" reads as a hang. */}
            {store.gitError !== undefined
              ? store.gitError
              : store.repoMissing
                ? t('git.hint')
                : `${t('common.loading')} ${store.gitBusy ? `— ${t('scm.loadingSlow')} (≤${Math.round(store.gitDeadlineMs / 1000)}s)` : ''}`}
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
                onClick={() => { void applyStage(conflicts.map(item => item.path), 'stage') }}
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
                    onClick={() => { void applyStage(changes.map(item => item.path), 'stage') }}
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
                : <div>{changeRows(changes)}</div>),
            )}

            {staged.length > 0 && section(
              'staged',
              t('scm.staged'),
              staged.length,
              <IconButton
                title={t('scm.unstageAll')}
                disabled={busy !== undefined}
                onClick={() => { void applyStage(staged.map(item => item.path), 'unstage') }}
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
      {menu.menu !== undefined && (
        <ContextMenu x={menu.menu.x} y={menu.menu.y} entries={menu.menu.entries} onClose={menu.close} />
      )}
    </div>
  )
}
