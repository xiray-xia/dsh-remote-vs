/**
 * The history panel's commit pane: the selected commit in the three views the
 * DSH-better-sidebar changes pane exposes — `提交详情` (the card), `内容` (the
 * files the commit touched) and `差异` (its patch).
 *
 * Deliberately better than the reference pane in the places a narrow sidebar
 * hurts most:
 *  - a sticky patch toolbar (previous/next file, current file, wrap toggle,
 *    copy) so a long diff never loses the reader's position or the controls;
 *  - sticky file headers per block, because "which file am I looking at" was
 *    the reference's biggest scroll cost;
 *  - `内容` groups files by directory with collapsible folders and a path
 *    filter, instead of a flat wall of paths;
 *  - right-click opens a real menu on every changed file (open in the editor,
 *    show in the diff, copy the path / the file patch) — the editor's own
 *    gesture, not a second mental model;
 *  - expand/restore the pane to full height, and copy the commit message,
 *    without leaving the panel.
 *
 * Frameless by design: the split, the frame and the pane height belong to the
 * history panel, so this fills whatever box it is handed and scrolls itself.
 * Read-only: a commit's patch is history, so the only mutations are "check this
 * commit out" (confirmed) and copying — staging/reverting lives on worktree
 * diffs.
 *
 * The patch is loaded lazily: a reader of 提交详情 must not pay a `git show
 * --patch` round trip per clicked commit, and the pane asks for it only while
 * the 差异 tab is on screen.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import type { GitCommit, GitCommitFile } from '../../protocol.ts'
import type { Lang } from '../i18n.ts'
import {
  ContextMenu,
  FileIcon,
  FolderIcon,
  IconButton,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconClose,
  IconCollapse,
  IconCopy,
  IconDiff,
  IconExpand,
  IconUser,
  IconWrap,
  MiniSpinner,
  copyText,
  fullTime,
  gitStatusClass,
  relTime,
  toast,
  useContextMenu,
} from '../vsc/kit.tsx'
import {
  HISTORY_TABS,
  autoFoldCommitPatch,
  blockForPath,
  buildCommitPatch,
  groupCommitFiles,
  refBadgeClass,
  refBadgeLabel,
  splitCommitPatch,
  stepHistoryTab,
  stepPath,
  type CommitPatchFile,
  type HistoryTab,
  type PatchRow,
} from './commit-model.ts'

/** Translator shape shared by every view (`makeT` returns the same). */
type Translate = (key: string) => string

/** Where the reader's wrap preference lives (one profile-wide UI choice). */
const WRAP_KEY = 'dsh-remote-vs.historyWrap'

function readWrap(): boolean {
  try {
    // Wrap is ON by default: in a ~400px column the two 42px line-number
    // gutters leave ~250px of text, and horizontal scrolling to read any
    // ordinary line is the first thing that reads as "broken". Only an explicit
    // user choice to turn it off is persisted.
    return localStorage.getItem(WRAP_KEY) !== '0'
  } catch {
    return true
  }
}

function writeWrap(value: boolean): void {
  try {
    localStorage.setItem(WRAP_KEY, value ? '1' : '0')
  } catch {
    // Ignore: a blocked localStorage must not break the pane.
  }
}

export interface CommitPaneProps {
  commit: GitCommit
  tab: HistoryTab
  onTab: (next: HistoryTab) => void
  onClose: () => void
  /** True while the pane covers the whole panel instead of its usual split. */
  expanded: boolean
  onToggleExpand: () => void
  /** Message text below the subject line ('' = none, or the read failed). */
  body: string
  /** `git show --name-status` rows; undefined while the read is in flight. */
  files: GitCommitFile[] | undefined
  /** Set when the file-list read failed (the 内容 tab shows it). */
  filesError: string | undefined
  /** Raw `git show --patch` text; undefined until the 差异 tab asks for it. */
  patch: string | undefined
  /** The remote read hit its byte cap: the parsed prefix is NOT the whole diff. */
  patchTruncated: boolean
  patchLoading: boolean
  patchError: string | undefined
  /** A file selected in 内容 (or a patch header), highlighted in 差异. */
  focusPath: string | undefined
  onFocusPath: (path: string) => void
  /** `origPath` is a rename source: the editor drill-down must diff BOTH paths. */
  onOpenFile: (path: string, origPath?: string) => void
  onCheckout: () => void
  onReload: () => void
  t: Translate
  lang: Lang
}

const TAB_LABELS: Record<HistoryTab, string> = {
  details: 'history.details',
  content: 'history.content',
  diff: 'history.diff',
}

/** One `内容` row's path spelling: renames keep both sides visible. */
function fileLabel(file: GitCommitFile): string {
  if (file.origPath === undefined) return file.path
  return `${file.origPath} → ${file.path}`
}

/** Rename/copy blocks show both sides in the patch header too. */
function blockLabel(file: CommitPatchFile): string {
  if (file.oldPath === file.path) return file.path
  return `${file.oldPath} → ${file.path}`
}

export function CommitPane(props: CommitPaneProps): ReactNode {
  const { commit, tab, t } = props
  const [wrap, setWrap] = useState<boolean>(readWrap)
  const toggleWrap = (): void => {
    const next = !wrap
    setWrap(next)
    writeWrap(next)
  }
  const onStripKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = stepHistoryTab(tab, event.key)
    if (next === undefined) return
    event.preventDefault()
    props.onTab(next)
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus()
  }
  /**
   * Escape closes the pane from anywhere inside it — except from the filter
   * input (where Escape means "leave my typing alone") and while a context
   * menu is open (the menu owns that Escape; closing both layers at once is a
   * surprise nobody asked for).
   */
  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return
    if ((event.target as HTMLElement).tagName === 'INPUT') return
    if (typeof document !== 'undefined' && document.querySelector('.rvs-menu') !== null) return
    event.stopPropagation()
    props.onClose()
  }
  return (
    <div className="rvs-hpane-body" onKeyDown={onRootKeyDown}>
      <div className="rvs-htabs">
        <div className="rvs-hpane-tablist" role="tablist" aria-label={t('history.paneLabel')} onKeyDown={onStripKeyDown}>
          {HISTORY_TABS.map(id => (
            <button
              key={id}
              type="button"
              role="tab"
              data-tab={id}
              id={`rvs-htab-${id}`}
              aria-selected={tab === id}
              aria-controls={`rvs-htab-${id}-panel`}
              tabIndex={tab === id ? 0 : -1}
              className={`rvs-htab${tab === id ? ' active' : ''}`}
              onClick={() => { props.onTab(id) }}
            >
              {t(TAB_LABELS[id])}
            </button>
          ))}
        </div>
        <span className="rvs-htabs-spacer" />
        <code className="rvs-hhash-mini" title={commit.hash}>{commit.hash.slice(0, 7)}</code>
        <IconButton
          title={props.expanded ? t('history.restore') : t('history.expand')}
          onClick={props.onToggleExpand}
        >
          {props.expanded ? <IconCollapse size={12} /> : <IconExpand size={12} />}
        </IconButton>
        <IconButton title={t('history.close')} onClick={props.onClose}>
          <IconClose size={11} />
        </IconButton>
      </div>
      <DetailsTab {...props} hidden={tab !== 'details'} />
      <ContentTab {...props} hidden={tab !== 'content'} />
      <DiffTab {...props} hidden={tab !== 'diff'} wrap={wrap} onToggleWrap={toggleWrap} />
    </div>
  )
}

/**
 * All three bodies stay mounted and are hidden with `hidden`, not unmounted:
 * the 差异 tab's scroll position and parsed patch survive a look at 提交详情,
 * and the lazy patch load keeps its state instead of restarting on every tab
 * flip.
 */
function DetailsTab(props: CommitPaneProps & { hidden: boolean }): ReactNode {
  const { commit, body, files, t, lang } = props
  const copyHash = (): void => {
    void copyText(commit.hash).then(() => toast(t('history.copiedHash')))
  }
  const copyMessage = (): void => {
    const text = body === '' ? commit.subject : `${commit.subject}\n\n${body}`
    void copyText(text).then(() => toast(t('history.copiedMessage')))
  }
  return (
    <div
      className="rvs-hbody rvs-scroll"
      hidden={props.hidden}
      role="tabpanel"
      id="rvs-htab-details-panel"
      aria-labelledby="rvs-htab-details"
    >
      <div className="rvs-hsubject">{commit.subject === '' ? commit.hash.slice(0, 7) : commit.subject}</div>
      <div className="rvs-hmeta">
        <span className="rvs-hmeta-icon"><IconUser size={12} /></span>
        <span className="rvs-hmeta-value">{commit.author}{commit.email === '' ? '' : ` <${commit.email}>`}</span>
      </div>
      <div className="rvs-hmeta">
        <span className="rvs-hmeta-icon"><IconClock size={12} /></span>
        <span className="rvs-hmeta-value">{fullTime(commit.date)} · {relTime(commit.date, lang)}</span>
      </div>
      <div className="rvs-hmeta">
        <code className="rvs-hhash">{commit.hash}</code>
        <IconButton title={t('history.copyHash')} onClick={copyHash}>
          <IconCopy size={12} />
        </IconButton>
      </div>
      {files !== undefined && (
        <div className="rvs-hmeta">
          <span className="rvs-hmeta-icon"><IconDiff size={12} /></span>
          <span className="rvs-hmeta-value">{t('history.filesCount').replace('{n}', String(files.length))}</span>
        </div>
      )}
      <div className="rvs-hmeta">
        <span className="rvs-hmeta-label">{t('history.parents')}</span>
        {parentsOf(commit)}
      </div>
      {commit.refs.length > 0 && (
        <div className="rvs-hrefs">
          {commit.refs.map(ref => (
            <span key={ref} className={`rvs-ref-badge${refBadgeClass(ref)}`}>{refBadgeLabel(ref)}</span>
          ))}
        </div>
      )}
      {body === '' ? null : <div className="rvs-hmsg">{body}</div>}
      <div className="rvs-hfooter">
        <button type="button" className="rvs-chip" onClick={props.onCheckout}>{t('scm.checkout')}</button>
        <button type="button" className="rvs-chip" onClick={copyMessage}>{t('history.copyMessage')}</button>
      </div>
    </div>
  )
}

/** Parent hashes as short chips; a root commit says so with an em dash. */
function parentsOf(commit: GitCommit): ReactNode {
  if (commit.parents.length === 0) return <span className="rvs-hdash">—</span>
  return commit.parents.map((parent, index) => (
    <code key={`${parent}:${index}`} className="rvs-hparent" title={parent}>{parent.slice(0, 7)}</code>
  ))
}

function ContentTab(props: CommitPaneProps & { hidden: boolean }): ReactNode {
  const { files, filesError, t } = props
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>())
  const menu = useContextMenu()
  // A filter typed for one commit must not follow the selection to the next:
  // "没有匹配的文件" on a 2-file commit looked like the commit was empty.
  useEffect(() => {
    setFilter('')
    setCollapsed(new Set<string>())
  }, [props.commit.hash])
  const filtered = useMemo(() => {
    if (files === undefined) return undefined
    const needle = filter.trim().toLowerCase()
    if (needle === '') return files
    return files.filter(file =>
      file.path.toLowerCase().includes(needle)
      || (file.origPath ?? '').toLowerCase().includes(needle))
  }, [files, filter])
  const groups = useMemo(() => (filtered === undefined ? [] : groupCommitFiles(filtered)), [filtered])
  const toggleDir = (dir: string): void => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })
  }
  const openFileMenu = (event: MouseEvent, file: GitCommitFile): void => {
    event.preventDefault()
    event.stopPropagation()
    menu.open(event.clientX, event.clientY, [
      { label: t('history.openInEditor'), onSelect: () => { props.onOpenFile(file.path, file.origPath) } },
      { label: t('history.viewInDiff'), onSelect: () => { props.onFocusPath(file.path) } },
      {
        label: t('history.copyPath'),
        separated: true,
        onSelect: () => { void copyText(file.path).then(() => toast(t('history.copiedPath'))) },
      },
    ])
  }
  return (
    <div
      className="rvs-hbody rvs-scroll"
      hidden={props.hidden}
      role="tabpanel"
      id="rvs-htab-content-panel"
      aria-labelledby="rvs-htab-content"
    >
      {contentBody(props, groups, filtered, filter, setFilter, collapsed, toggleDir, openFileMenu)}
      {menu.menu !== undefined && (
        <ContextMenu x={menu.menu.x} y={menu.menu.y} entries={menu.menu.entries} onClose={menu.close} />
      )}
    </div>
  )
}

function contentBody(
  props: CommitPaneProps,
  groups: ReturnType<typeof groupCommitFiles>,
  filtered: readonly GitCommitFile[] | undefined,
  filter: string,
  setFilter: (value: string) => void,
  collapsed: ReadonlySet<string>,
  toggleDir: (dir: string) => void,
  openFileMenu: (event: MouseEvent, file: GitCommitFile) => void,
): ReactNode {
  const { files, filesError, t } = props
  if (filesError !== undefined) {
    return (
      <>
        <div className="rvs-banner error">{filesError}</div>
        <button type="button" className="rvs-chip" onClick={props.onReload}>{t('history.reload')}</button>
      </>
    )
  }
  if (files === undefined) return <div className="rvs-empty"><MiniSpinner /> {t('common.loading')}</div>
  if (files.length === 0) return <div className="rvs-empty">{t('history.noFiles')}</div>
  const filtering = filter.trim() !== ''
  const countLabel = filtering
    ? t('history.filesCountFiltered').replace('{matched}', String(filtered?.length ?? 0)).replace('{total}', String(files.length))
    : t('history.filesCount').replace('{n}', String(files.length))
  return (
    <>
      <div className="rvs-hcontent-head">
        <span className="rvs-hcount">{countLabel}</span>
        <input
          className="rvs-input rvs-hfilter"
          placeholder={t('history.filterFiles')}
          aria-label={t('history.filterFiles')}
          value={filter}
          spellCheck={false}
          onChange={(event) => { setFilter(event.target.value) }}
        />
      </div>
      <div className="rvs-hhint">{t('history.contentHint')}</div>
      {groups.length === 0 ? <div className="rvs-empty">{t('history.noMatchFiles')}</div> : null}
      <div className="rvs-hfiles">
        {groups.map(group => (
          <div key={group.dir === '' ? '\u0000root' : group.dir}>
            {group.dir === '' ? null : (
              <div
                className="rvs-hfolder"
                role="button"
                tabIndex={0}
                title={group.dir}
                onClick={() => { toggleDir(group.dir) }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  toggleDir(group.dir)
                }}
              >
                <span className="rvs-node-icon">
                  {collapsed.has(group.dir) ? <IconChevronRight size={11} /> : <IconChevronDown size={11} />}
                </span>
                <span className="rvs-node-icon"><FolderIcon path={group.dir} open={!collapsed.has(group.dir)} size={13} /></span>
                <span className="rvs-hfolder-name">{group.dir}</span>
                <span className="rvs-hfolder-count">{group.files.length}</span>
              </div>
            )}
            {group.dir !== '' && collapsed.has(group.dir) ? null : group.files.map(file => (
              <div
                key={`${file.status}:${file.path}`}
                role="button"
                tabIndex={0}
                className={`rvs-file-row${group.dir === '' ? '' : ' indent'}${props.focusPath === file.path ? ' active' : ''}`}
                title={`${fileLabel(file)} — ${t('history.contentHint')}`}
                onClick={() => { props.onFocusPath(file.path) }}
                onContextMenu={(event) => { openFileMenu(event, file) }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  props.onFocusPath(file.path)
                }}
              >
                <span className="rvs-node-icon"><FileIcon path={file.path} size={13} /></span>
                <span className="rvs-file-path">{fileLabel(file)}</span>
                <span className={`rvs-file-status rvs-letter-${gitStatusClass(file.status)}`}>{file.status[0]}</span>
                <IconButton
                  title={t('history.openInEditor')}
                  onClick={() => { props.onOpenFile(file.path, file.origPath) }}
                  className="rvs-file-open"
                >
                  <IconDiff size={12} />
                </IconButton>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  )
}

function DiffTab(props: CommitPaneProps & { hidden: boolean; wrap: boolean; onToggleWrap: () => void }): ReactNode {
  const { t } = props
  const model = useMemo(() => buildCommitPatch(props.patch ?? ''), [props.patch])
  /** Per-file raw patch text, index-aligned with `model.files`. */
  const blocks = useMemo(() => splitCommitPatch(props.patch ?? ''), [props.patch])
  const paths = useMemo(() => model.files.map(file => file.path), [model])
  /** Folded file blocks: a commit touching one huge file should not wall off
   *  every other file behind it. Starts from the pure default-budget policy so
   *  a 40-file commit opens as a readable outline instead of a 6000-row wall. */
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set<string>(autoFoldCommitPatch(model)))
  useEffect(() => {
    setFolded(new Set<string>(autoFoldCommitPatch(model)))
  }, [model])
  const toggleFold = (path: string): void => {
    setFolded(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  const blockRefs = useRef(new Map<string, HTMLElement>())
  const menu = useContextMenu()
  const resolvedFocus = props.focusPath === undefined ? undefined : blockForPath(model, props.focusPath)
  const currentPath = resolvedFocus ?? paths[0]
  const currentIndex = currentPath === undefined ? -1 : paths.indexOf(currentPath)
  // Content-list selection jumps to its block. `model` is a dependency because
  // the blocks do not exist on the first frame after the patch lands.
  useEffect(() => {
    if (resolvedFocus === undefined) return
    blockRefs.current.get(resolvedFocus)?.scrollIntoView({ block: 'start' })
  }, [resolvedFocus, model])
  const register = (path: string) => (element: HTMLElement | null): void => {
    if (element === null) blockRefs.current.delete(path)
    else blockRefs.current.set(path, element)
  }
  const step = (direction: 1 | -1): void => {
    const next = stepPath(paths, currentPath, direction)
    if (next !== undefined) props.onFocusPath(next)
  }
  const copyBlock = (path: string): void => {
    const index = paths.indexOf(path)
    const text = index < 0 ? undefined : blocks[index]
    if (text === undefined) return
    void copyText(text).then(() => toast(t('history.copiedFilePatch')))
  }
  const copyAll = (): void => {
    if (props.patch === undefined || props.patch === '') return
    void copyText(props.patch).then(() => toast(t('history.copiedCommitPatch')))
  }
  const openBlockMenu = (event: MouseEvent, file: CommitPatchFile): void => {
    event.preventDefault()
    event.stopPropagation()
    menu.open(event.clientX, event.clientY, [
      { label: t('history.openInEditor'), onSelect: () => { props.onOpenFile(file.path, file.oldPath === file.path ? undefined : file.oldPath) } },
      {
        label: t('history.copyPath'),
        onSelect: () => { void copyText(file.path).then(() => toast(t('history.copiedPath'))) },
      },
      {
        label: t('history.copyFilePatch'),
        separated: true,
        onSelect: () => { copyBlock(file.path) },
      },
    ])
  }
  return (
    <div
      className="rvs-hbody rvs-hdiff"
      hidden={props.hidden}
      role="tabpanel"
      id="rvs-htab-diff-panel"
      aria-labelledby="rvs-htab-diff"
    >
      <div className="rvs-ptoolbar" role="toolbar" aria-label={t('history.diffToolbar')}>
        <IconButton title={t('history.prevFile')} onClick={() => { step(-1) }} disabled={paths.length === 0}>
          <IconChevronLeft size={13} />
        </IconButton>
        <IconButton title={t('history.nextFile')} onClick={() => { step(1) }} disabled={paths.length === 0}>
          <IconChevronRight size={13} />
        </IconButton>
        <span className="rvs-pfile-index">{currentIndex < 0 ? '–' : `${currentIndex + 1}/${paths.length}`}</span>
        <span className="rvs-pfile-name" title={currentPath ?? ''}>{currentPath ?? '–'}</span>
        <IconButton
          title={t('history.wrap')}
          className={props.wrap ? 'active' : ''}
          onClick={props.onToggleWrap}
        >
          <IconWrap size={13} />
        </IconButton>
        {(model.truncated || props.patchTruncated) && (
          <span className="rvs-ptruncated" title={t('history.patchTruncated')}>✂</span>
        )}
        <IconButton
          title={t('history.copyCommitPatch')}
          onClick={copyAll}
          disabled={props.patch === undefined || props.patch === ''}
        >
          <IconCopy size={13} />
        </IconButton>
      </div>
      <div className="rvs-pscroll rvs-scroll">
        {diffBody(props, model, blocks, props.wrap, folded, toggleFold, register, openBlockMenu)}
      </div>
      {menu.menu !== undefined && (
        <ContextMenu x={menu.menu.x} y={menu.menu.y} entries={menu.menu.entries} onClose={menu.close} />
      )}
    </div>
  )
}

function diffBody(
  props: CommitPaneProps,
  model: ReturnType<typeof buildCommitPatch>,
  blocks: string[],
  wrap: boolean,
  folded: ReadonlySet<string>,
  toggleFold: (path: string) => void,
  register: (path: string) => (element: HTMLElement | null) => void,
  openBlockMenu: (event: MouseEvent, file: CommitPatchFile) => void,
): ReactNode {
  const { t } = props
  if (props.patchError !== undefined) {
    return (
      <>
        <div className="rvs-banner error">{props.patchError}</div>
        <button type="button" className="rvs-chip" onClick={props.onReload}>{t('history.reload')}</button>
      </>
    )
  }
  if (props.patch === undefined) {
    // A read in flight says so; a marker left by a superseded read is NOT a
    // finished patch (the reported empty-diff bug), so it offers a retry
    // instead of the silent blank the old branch rendered.
    if (props.patchLoading) return <div className="rvs-empty"><MiniSpinner /> {t('common.loading')}</div>
    return (
      <>
        <div className="rvs-empty">{t('history.patchNotLoaded')}</div>
        <button type="button" className="rvs-chip" onClick={props.onReload}>{t('history.reload')}</button>
      </>
    )
  }
  if (model.files.length === 0) return <div className="rvs-empty">{t('history.noTextDiff')}</div>
  return (
    <>
      <div className="rvs-patch">
        {model.files.map((file, index) => (
          <PatchBlock
            key={`${file.status}:${file.path}`}
            file={file}
            active={props.focusPath === file.path || props.focusPath === file.oldPath}
            register={register(file.path)}
            wrap={wrap}
            folded={folded.has(file.path)}
            hasPatch={blocks[index] !== undefined}
            onFocus={() => { props.onFocusPath(file.path) }}
            onOpen={() => { props.onOpenFile(file.path, file.oldPath === file.path ? undefined : file.oldPath) }}
            onToggleFold={() => { toggleFold(file.path) }}
            onMenu={(event) => { openBlockMenu(event, file) }}
            t={t}
          />
        ))}
      </div>
      {model.truncated || props.patchTruncated ? <div className="rvs-empty">{t('history.patchTruncated')}</div> : null}
    </>
  )
}

function PatchBlock(props: {
  file: CommitPatchFile
  active: boolean
  register: (element: HTMLElement | null) => void
  wrap: boolean
  folded: boolean
  hasPatch: boolean
  onFocus: () => void
  onOpen: () => void
  onToggleFold: () => void
  onMenu: (event: MouseEvent) => void
  t: Translate
}): ReactNode {
  const { file, t } = props
  return (
    <section
      ref={props.register}
      className={`rvs-patch-file${props.active ? ' active' : ''}${props.folded ? ' folded' : ''}`}
      data-path={file.path}
    >
      <header className="rvs-patch-head" title={blockLabel(file)} onClick={props.onFocus} onContextMenu={props.onMenu}>
        <span
          className={`rvs-patch-chevron${props.folded ? '' : ' open'}`}
          role="button"
          tabIndex={0}
          aria-expanded={!props.folded}
          aria-label={props.folded ? t('history.unfoldFile') : t('history.foldFile')}
          title={props.folded ? t('history.unfoldFile') : t('history.foldFile')}
          onClick={(event) => {
            event.stopPropagation()
            props.onToggleFold()
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            event.stopPropagation()
            props.onToggleFold()
          }}
        >
          <IconChevronRight size={11} />
        </span>
        <FileIcon path={file.path} size={13} />
        <span className="rvs-patch-path">{blockLabel(file)}</span>
        <span className={`rvs-patch-letter rvs-letter-${gitStatusClass(file.status)}`}>{file.status[0]}</span>
        <span className="rvs-patch-counts">
          <span className="rvs-patch-add-count">+{file.added}</span>
          <span className="rvs-patch-del-count">−{file.deleted}</span>
        </span>
        <span onClick={(event) => { event.stopPropagation() }}>
          <IconButton title={t('history.openInEditor')} onClick={props.onOpen}>
            <IconDiff size={13} />
          </IconButton>
        </span>
      </header>
      {props.folded ? null : patchBlockBody(file, props.wrap, props.hasPatch, t)}
    </section>
  )
}

/**
 * One block's body: binary note, a cap-specific note, "no text change", or the
 * hunk rows.
 *
 * The cap case is distinct on purpose: a file whose rows all fell past
 * `PATCH_ROW_CAP` has `rows.length === 0` but a non-zero `+/−` header, and the
 * plain "没有文本改动" copy there was a lie the header itself contradicted.
 */
function patchBlockBody(file: CommitPatchFile, wrap: boolean, hasPatch: boolean, t: Translate): ReactNode {
  if (file.binary) return <div className="rvs-patch-note">{t('history.binaryFile')}</div>
  if (file.rows.length === 0) {
    return <div className="rvs-patch-note">{file.truncated ? t('history.fileNotRendered') : t('history.noTextDiff')}</div>
  }
  return (
    <div className={`rvs-patch-rows${wrap ? ' wrap' : ''}${hasPatch ? '' : ' partial'}`}>
      {file.rows.map((row, index) => <PatchLine key={index} row={row} />)}
      {file.truncated && <div className="rvs-patch-note">{t('history.patchTruncated')}</div>}
    </div>
  )
}

function PatchLine(props: { row: PatchRow }): ReactNode {
  const { row } = props
  if (row.kind === 'skip') return <div className="rvs-patch-skip">⋯</div>
  return (
    <div className={`rvs-patch-row ${row.kind}`}>
      <span className="rvs-patch-num">{row.oldLine ?? ''}</span>
      <span className="rvs-patch-num">{row.newLine ?? ''}</span>
      <span className="rvs-patch-sign">{signOf(row)}</span>
      <span className="rvs-patch-text">{row.text}</span>
    </div>
  )
}

function signOf(row: PatchRow): string {
  if (row.kind === 'add') return '+'
  if (row.kind === 'del') return '-'
  return ' '
}
