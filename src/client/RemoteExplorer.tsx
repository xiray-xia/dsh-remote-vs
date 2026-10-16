/**
 * Remote file explorer, VS Code style: per-type icons, git status letters and
 * name tinting, ignored-path greying, right-click file operations, multi
 * select, drag & drop and inline create / rename.
 *
 * The tree stays lazy — one SFTP listing per expanded directory — so git
 * precedence (directory roll-up, ignored inheritance) is computed from the
 * status path set instead of from materialized children; see `scm/status-map`.
 * The `@文件` insertion and the row hover affordance are kept from the
 * previous explorer, and `insertRemoteReference` still writes into the
 * on-screen session's composer draft.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { copyIntoCommand, joinAbs, moveToCommand } from '../fs-ops.ts'
import type { RemoteFileEntry } from '../protocol.ts'
import { api } from './api.ts'
import { insertRemoteReference, sameLocalDir } from './composer.ts'
import { repoRelative, useExplorer } from './store.tsx'
import { useRemoteChatTarget } from './use-remote-chat-target.ts'
import {
  IconButton,
  IconChevronDown,
  IconChevronRight,
  IconNewFolder,
  IconPlus,
  IconRefresh,
  ContextMenu,
  FileIcon,
  FolderIcon,
  baseName,
  confirmDialog,
  copyText,
  gitLetter,
  gitStatusClass,
  isPreviewOnlyFile,
  promptDialog,
  toast,
  useContextMenu,
  type MenuEntry,
} from './vsc/kit.tsx'

interface Clipboard {
  paths: string[]
  mode: 'copy' | 'cut'
}

interface CreateState {
  dir: string
  kind: 'file' | 'folder'
}

function dirKey(alias: string, dir: string): string {
  return `${alias}:${dir}`
}

export function RemoteExplorer(props: { showHidden: boolean; onToggleHidden: () => void; visible: boolean }): ReactNode {
  const store = useExplorer()
  const { t, alias, root, repoRoot, marks } = store
  const ctx = store.ctx
  const [listings, setListings] = useState<Record<string, RemoteFileEntry[]>>({})
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | undefined>(undefined)
  const [renaming, setRenaming] = useState<string | undefined>(undefined)
  const [creating, setCreating] = useState<CreateState | undefined>(undefined)
  const [clipboard, setClipboard] = useState<Clipboard | undefined>(undefined)
  const [dropTarget, setDropTarget] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const dragPaths = useRef<string[]>([])
  const menu = useContextMenu()

  const chatTarget = useRemoteChatTarget(store.ctx)
  const viewedAliasPath = store.workspace !== undefined ? store.aliasPaths[store.workspace.id] : undefined
  const chatEnabled = chatTarget.sessionId !== undefined
    && chatTarget.sessionWorkspacePath !== undefined
    && viewedAliasPath !== undefined
    && sameLocalDir(chatTarget.sessionWorkspacePath, viewedAliasPath)

  const loadDir = useCallback(async (dir: string, force = false): Promise<void> => {
    if (alias === '') return
    const key = dirKey(alias, dir)
    // NOTE: a cached listing is deliberately NOT reused here. The old form was
    // `setListings(prev => prev[key] === undefined ? prev : prev)`, an identity
    // update that changed nothing and read like a cache short-circuit; every
    // caller therefore re-lists, which is what the tree relies on after a
    // write. (The `force` flag only distinguishes caller intent.)
    void force
    setLoading(prev => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
    try {
      const entries = await api.fileOp.list(alias, dir)
      setListings(prev => ({ ...prev, [key]: entries }))
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), true)
    } finally {
      setLoading(prev => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }, [alias])

  // Root listing + refresh on the shared revision bump (git writes, saves...).
  const revision = store.revision
  /**
   * The binding this tree was listed from and the revision it was listed at.
   * A parked panel stays MOUNTED behind `display:none`, so a write made off
   * screen is not lost by parking: it only leaves these two behind, and the
   * tree catches up in a single pass as soon as the panel is on screen again.
   */
  const listedBinding = useRef('')
  const listedRevision = useRef(revision)

  useEffect(() => {
    // `visible === false` covers both ways in: the panel is parked behind
    // `display:none`, or the whole surface is hidden (`RemoteRoot` measures it).
    if (root === '' || props.visible === false) return
    const rebind = listedBinding.current !== dirKey(alias, root)
    if (!rebind && revision === listedRevision.current) return
    listedBinding.current = dirKey(alias, root)
    listedRevision.current = revision
    // `expanded` is keyed by absolute path, so a binding change has to DROP the
    // previous workspace's directories. The old add-only form kept them, and
    // every later write listed those paths under the NEW alias — a failed
    // request each, plus the error toast that goes with it.
    if (rebind) setExpanded(new Set([root]))
    // Root plus every open directory, once each: `expanded` always holds the
    // root, and listing it separately on top of the loop listed it twice. They
    // are fired concurrently — each one opens its own SFTP session host side.
    for (const dir of new Set(rebind ? [root] : [root, ...expanded])) void loadDir(dir, true)
    // `expanded` is deliberately not a dependency: opening a directory lists it
    // itself, so re-listing the whole tree per expand would put the bug back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, root, alias, props.visible, loadDir])

  const rowsOf = useCallback((dir: string): RemoteFileEntry[] | undefined => {
    const rows = listings[dirKey(alias, dir)]
    if (rows === undefined) return undefined
    const visible = props.showHidden ? rows : rows.filter(entry => !entry.name.startsWith('.'))
    return [...visible].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }, [listings, alias, props.showHidden])

  /** Flatten the loaded part of the tree in pre-order (shift-select spans it). */
  const flatten = useCallback((dir: string, out: string[] = []): string[] => {
    for (const entry of rowsOf(dir) ?? []) {
      out.push(entry.path)
      if (entry.isDir && expanded.has(entry.path)) flatten(entry.path, out)
    }
    return out
  }, [rowsOf, expanded])

  const toggleDir = (entry: RemoteFileEntry): void => {
    if (!entry.isDir) return
    const isOpen = expanded.has(entry.path)
    setExpanded(prev => {
      const next = new Set(prev)
      if (isOpen) next.delete(entry.path)
      else next.add(entry.path)
      return next
    })
    if (!isOpen) void loadDir(entry.path)
  }

  /** Open one path: previews for images, diffs for changed text files. */
  const openEntry = useCallback((entry: RemoteFileEntry): void => {
    if (entry.isDir) {
      toggleDir(entry)
      return
    }
    if (isPreviewOnlyFile(entry.path)) {
      store.openFile(entry.path)
      return
    }
    const rel = repoRelative(repoRoot, entry.path)
    if (rel === '') {
      store.openFile(entry.path)
      return
    }
    const fileMark = marks.files.get(rel)
    const untracked = fileMark === '?'
    const stagedLetter = store.buckets.staged.find(item => item.path === rel)?.status
    if (fileMark !== undefined || stagedLetter !== undefined) {
      store.openDiff(rel, stagedLetter !== undefined && (fileMark === undefined || fileMark === stagedLetter), untracked)
      return
    }
    store.openFile(entry.path)
  }, [marks, repoRoot, store])

  // ------------------------------------------------------------- selection

  const selectRow = (entry: RemoteFileEntry, event: React.MouseEvent): void => {
    const additive = event.ctrlKey || event.metaKey
    const range = event.shiftKey
    if (range && anchor !== undefined) {
      const order = flatten(root)
      const from = order.indexOf(anchor)
      const to = order.indexOf(entry.path)
      if (from >= 0 && to >= 0) {
        const slice = order.slice(Math.min(from, to), Math.max(from, to) + 1)
        setSelected(new Set(slice))
        if (entry.isDir) toggleDir(entry)
        return
      }
    }
    if (additive) {
      setSelected(prev => {
        const next = new Set(prev)
        if (next.has(entry.path)) next.delete(entry.path)
        else next.add(entry.path)
        return next
      })
      setAnchor(entry.path)
      if (entry.isDir) toggleDir(entry)
      return
    }
    setSelected(new Set([entry.path]))
    setAnchor(entry.path)
    if (entry.isDir) toggleDir(entry)
    else openEntry(entry)
  }

  const selectedEntries = useMemo(() => {
    const out: RemoteFileEntry[] = []
    const walk = (dir: string): void => {
      for (const entry of rowsOf(dir) ?? []) {
        if (selected.has(entry.path)) out.push(entry)
        if (entry.isDir && expanded.has(entry.path)) walk(entry.path)
      }
    }
    walk(root)
    return out
  }, [rowsOf, selected, expanded, root])

  const baseDirFor = (): string => {
    const first = selectedEntries[0]
    if (first === undefined) return root
    return first.isDir ? first.path : first.path.split('/').slice(0, -1).join('/') || '/'
  }

  // ------------------------------------------------------------ operations

  const refreshDirs = useCallback(async (dirs: string[]): Promise<void> => {
    for (const dir of dirs) await loadDir(dir, true)
  }, [loadDir])

  const doCreate = async (name: string): Promise<void> => {
    const state = creating
    setCreating(undefined)
    if (state === undefined || name.trim() === '') return
    let target: string
    try {
      target = joinAbs(state.dir, name)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), true)
      return
    }
    setBusy(true)
    try {
      if (state.kind === 'file') await api.fileOp.write(alias, target, '')
      else await api.fileOp.mkdir(alias, target)
      setExpanded(prev => new Set(prev).add(state.dir))
      await refreshDirs([state.dir])
      await store.afterWrite()
      toast(`${t('files.created')} ${target}`)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), true)
    } finally {
      setBusy(false)
    }
  }

  const doRename = async (entry: RemoteFileEntry, name: string): Promise<void> => {
    setRenaming(undefined)
    if (name.trim() === '' || name === entry.name) return
    let target: string
    try {
      target = joinAbs(entry.path.split('/').slice(0, -1).join('/') || '/', name)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), true)
      return
    }
    setBusy(true)
    try {
      await api.fileOp.rename(alias, entry.path, target)
      // Re-key the path-indexed state. `expanded`, `selected`, `anchor` and
      // the `listings` cache are all keyed by absolute path, so a renamed
      // directory used to collapse (the new path was never in `expanded`), keep
      // its selection pointing at a path that no longer exists, and strand a
      // stale listing under the old key forever.
      const from = entry.path
      const movePath = (path: string): string =>
        path === from || path.startsWith(`${from}/`) ? `${target}${path.slice(from.length)}` : path
      setExpanded(prev => new Set([...prev].map(movePath)))
      setSelected(prev => new Set([...prev].map(movePath)))
      setAnchor(prev => (prev === undefined ? undefined : movePath(prev)))
      setListings(prev => {
        const next: Record<string, RemoteFileEntry[]> = {}
        for (const [key, value] of Object.entries(prev)) {
          const prefix = dirKey(alias, '')
          if (!key.startsWith(prefix)) {
            next[key] = value
            continue
          }
          next[dirKey(alias, movePath(key.slice(prefix.length)))] = value
        }
        return next
      })
      await refreshDirs([baseDirFor()])
      await store.afterWrite()
      toast(`${t('files.renamed')} ${target}`)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), true)
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async (entries: RemoteFileEntry[]): Promise<void> => {
    if (entries.length === 0) return
    const first = entries[0] as RemoteFileEntry
    const label = entries.length === 1 ? first.path : `${entries.length} ${t('files.items')}`
    const ok = await confirmDialog({
      title: t('files.deleteTitle'),
      text: t('files.deleteConfirm').replace('{target}', label),
      danger: true,
      okText: t('files.delete'),
    })
    if (!ok) return
    setBusy(true)
    const failed: string[] = []
    for (const entry of entries) {
      try {
        await api.fileOp.rm(alias, entry.path, entry.isDir)
      } catch (error) {
        failed.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    setBusy(false)
    setSelected(new Set())
    await refreshDirs([...new Set(entries.map(entry => entry.path.split('/').slice(0, -1).join('/') || '/'))])
    await store.afterWrite()
    if (failed.length > 0) toast(failed.join('\n'), true)
    else toast(t('files.deleted'))
  }

  const doPaste = async (intoDir: string): Promise<void> => {
    const clip = clipboard
    if (clip === undefined || clip.paths.length === 0) return
    setBusy(true)
    const failed: string[] = []
    for (const source of clip.paths) {
      if (source === intoDir || intoDir.startsWith(`${source}/`)) {
        failed.push(`${source}: ${t('files.pasteIntoSelf')}`)
        continue
      }
      if (source.split('/').slice(0, -1).join('/') === intoDir && clip.mode === 'cut') {
        failed.push(`${source}: ${t('files.pasteSameDir')}`)
        continue
      }
      const command = clip.mode === 'copy' ? copyIntoCommand(source, intoDir) : moveToCommand(source, intoDir)
      try {
        const result = await api.exec(alias, command, 60_000)
        if (!result.success) failed.push(`${baseName(source)}: ${result.stderr.trim() || t('files.pasteFailed')}`)
      } catch (error) {
        failed.push(`${baseName(source)}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    setBusy(false)
    if (clip.mode === 'cut') setClipboard(undefined)
    await refreshDirs([intoDir, baseDirFor()])
    await store.afterWrite()
    if (failed.length > 0) toast(failed.join('\n'), true)
    else toast(clip.mode === 'copy' ? t('files.copied') : t('files.moved'))
  }

  const doDrop = async (intoDir: string, event: React.DragEvent): Promise<void> => {
    event.preventDefault()
    setDropTarget(undefined)
    const sources = dragPaths.current
    dragPaths.current = []
    if (sources.length === 0) return
    setBusy(true)
    const failed: string[] = []
    for (const source of sources) {
      if (source === intoDir || intoDir.startsWith(`${source}/`)) {
        failed.push(`${baseName(source)}: ${t('files.moveIntoSelf')}`)
        continue
      }
      if (source.split('/').slice(0, -1).join('/') === intoDir) continue
      try {
        const result = await api.exec(alias, moveToCommand(source, intoDir), 60_000)
        if (!result.success) failed.push(`${baseName(source)}: ${result.stderr.trim() || t('files.pasteFailed')}`)
      } catch (error) {
        failed.push(`${baseName(source)}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    setBusy(false)
    await refreshDirs([intoDir, baseDirFor()])
    await store.afterWrite()
    if (failed.length > 0) toast(failed.join('\n'), true)
    else toast(t('files.moved'))
  }

  // ---------------------------------------------------------- context menu

  const openMenu = (event: React.MouseEvent, entry: RemoteFileEntry | undefined): void => {
    event.preventDefault()
    event.stopPropagation()
    if (entry !== undefined && !selected.has(entry.path)) {
      setSelected(new Set([entry.path]))
      setAnchor(entry.path)
    }
    // Both of these were nested ternaries — the project's own review checklist
    // forbids them, and they sat exactly where the multi-select / context-menu
    // semantics are decided, which is the worst place to make a reader decode
    // a two-level conditional.
    const multi = entry !== undefined && selected.has(entry.path) && selected.size > 1
    const targets = entry === undefined ? [] : (multi ? selectedEntries : [entry])
    let dir = root
    if (entry !== undefined) {
      dir = entry.isDir ? entry.path : (entry.path.split('/').slice(0, -1).join('/') || '/')
    }
    const entries: MenuEntry[] = [
      { label: t('files.newFile'), onSelect: () => setCreating({ dir, kind: 'file' }) },
      { label: t('files.newFolder'), onSelect: () => setCreating({ dir, kind: 'folder' }) },
      {
        label: t('files.pasteHere'),
        onSelect: () => { void doPaste(dir) },
        disabled: clipboard === undefined,
        hint: clipboard === undefined ? undefined : `${clipboard.paths.length}`,
      },
    ]
    if (entry !== undefined) {
      entries.push({ label: t('files.open'), onSelect: () => openEntry(entry), separated: true })
      if (!entry.isDir && isPreviewOnlyFile(entry.path)) {
        entries.push({ label: t('files.openAsText'), onSelect: () => store.openFile(entry.path) })
      }
      // "Find in Folder…" (VS Code's explorer entry): scope the content search
      // to this directory — or to the file's own directory when a file is the
      // target — and jump to the search panel.
      entries.push({
        label: t('files.findInFolder'),
        onSelect: () => store.requestSearch({ mode: 'content', scope: dir }),
      })
      if (!entry.isDir) {
        entries.push({ label: t('files.searchNameHere'), onSelect: () => store.requestSearch({ mode: 'name', scope: dir }) })
      }
      if (targets.length === 1) {
        entries.push({ label: t('files.rename'), onSelect: () => setRenaming(entry.path) })
      }
      entries.push({ label: t('files.copy'), onSelect: () => { setClipboard({ paths: targets.map(item => item.path), mode: 'copy' }); toast(t('files.copiedClipboard')) } })
      entries.push({ label: t('files.cut'), onSelect: () => { setClipboard({ paths: targets.map(item => item.path), mode: 'cut' }); toast(t('files.cutClipboard')) } })
      entries.push({
        label: t('files.delete') + (targets.length > 1 ? ` (${targets.length})` : ''),
        onSelect: () => { void doDelete(targets) },
        danger: true,
      })
      entries.push({ label: t('files.copyRel'), onSelect: () => { void copyText(targets.map(item => repoRelative(repoRoot, item.path) || item.path).join('\n')); toast(t('files.copiedClipboard')) }, separated: true })
      entries.push({ label: t('files.copyAbs'), onSelect: () => { void copyText(targets.map(item => item.path).join('\n')); toast(t('files.copiedClipboard')) } })
      entries.push({
        label: t('files.referenceFile'),
        onSelect: () => {
          if (chatTarget.sessionId === undefined) return
          for (const item of targets) {
            insertRemoteReference(ctx, chatTarget.sessionId, repoRoot ?? root, item.path, item.isDir)
          }
        },
        disabled: !chatEnabled,
        separated: true,
      })
    }
    entries.push({
      label: props.showHidden ? t('files.hideHidden') : t('files.showHidden'),
      onSelect: props.onToggleHidden,
      separated: true,
    })
    entries.push({ label: t('files.collapseAll'), onSelect: () => setExpanded(new Set([root])) })
    entries.push({ label: t('files.refresh'), onSelect: () => { void loadDir(root, true) } })
    menu.open(event.clientX, event.clientY, entries)
  }

  // -------------------------------------------------------------- rendering

  const statusFor = useCallback((entry: RemoteFileEntry): string | undefined => {
    const rel = repoRelative(repoRoot, entry.path)
    if (rel === '') return undefined
    if (entry.isDir) return marks.dirs.get(rel)
    return marks.files.get(rel)
  }, [repoRoot, marks])

  const ignoredFor = useCallback((entry: RemoteFileEntry): boolean => {
    const rel = repoRelative(repoRoot, entry.path)
    if (rel === '') return false
    return entry.isDir ? marks.ignoredDirs.has(rel) : marks.ignored.has(rel)
  }, [repoRoot, marks])

  const renderDir = (dir: string, depth: number): ReactNode => {
    const rows = rowsOf(dir)
    const key = dirKey(alias, dir)
    if (rows === undefined && loading.has(key)) {
      return <div className="rvs-empty" style={{ paddingLeft: 12 + depth * 14 }}>{t('common.loading')}</div>
    }
    return (
      <>
        {creating?.dir === dir && (
          <CreateRow
            depth={depth}
            kind={creating.kind}
            onCommit={(value) => { void doCreate(value) }}
            onCancel={() => setCreating(undefined)}
            fileIcon={<FileIcon path="name.ts" size={15} />}
            folderIcon={<FolderIcon path="name" open={false} size={15} />}
            t={t}
          />
        )}
        {(rows ?? []).map((entry) => {
          const isOpen = expanded.has(entry.path)
          const status = statusFor(entry)
          const ignored = ignoredFor(entry)
          const isSelected = selected.has(entry.path)
          const clip = clipboard !== undefined && clipboard.mode === 'cut' && clipboard.paths.includes(entry.path)
          return (
            <div key={entry.path}>
              <div
                className={[
                  'rvs-node',
                  isSelected ? 'selected' : '',
                  clip ? 'cut' : '',
                  dropTarget === entry.path ? 'drop-target' : '',
                ].filter(Boolean).join(' ')}
                style={{ paddingLeft: 8 + depth * 14 }}
                title={entry.path}
                draggable
                onClick={(e) => selectRow(entry, e)}
                onDoubleClick={() => { if (!entry.isDir) store.openFile(entry.path) }}
                onContextMenu={(e) => openMenu(e, entry)}
                onDragStart={(e) => {
                  dragPaths.current = selected.has(entry.path) ? [...selected] : [entry.path]
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', entry.path)
                }}
                onDragOver={(e) => {
                  if (!entry.isDir) return
                  const source = dragPaths.current[0]
                  if (source === undefined) return
                  if (entry.path === source || entry.path.startsWith(`${source}/`)) return
                  e.preventDefault()
                  setDropTarget(entry.path)
                }}
                onDragLeave={() => { setDropTarget(current => (current === entry.path ? undefined : current)) }}
                onDrop={(e) => { if (entry.isDir) void doDrop(entry.path, e) }}
              >
                <span className="rvs-node-icon">
                  {entry.isDir
                    ? <FolderIcon path={entry.path} open={isOpen} size={15} />
                    : <FileIcon path={entry.path} size={15} />}
                </span>
                {renaming === entry.path
                  ? (
                    <RenameInput
                      initial={entry.name}
                      onCommit={(value) => { void doRename(entry, value) }}
                      onCancel={() => setRenaming(undefined)}
                    />
                  )
                  : (
                    <span className={`rvs-node-name ${status !== undefined ? `rvs-git-${gitStatusClass(status)}` : ''}`} style={ignored && status === undefined ? { opacity: .5 } : undefined}>
                      {entry.name}
                    </span>
                  )}
                {status !== undefined && (
                  <span className={`rvs-git-letter rvs-letter-${gitStatusClass(status)}`}>{gitLetter(status)}</span>
                )}
                {entry.isSymlink && <span className="rvs-hit-dir" title={t('files.symlink')}>↩</span>}
                <span className="rvs-node-actions">
                  <button
                    type="button"
                    className="rvs-hbtn"
                    title={chatEnabled ? t('files.referenceFile') : t('files.refDisabled')}
                    disabled={!chatEnabled}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (chatTarget.sessionId === undefined) return
                      insertRemoteReference(ctx, chatTarget.sessionId, repoRoot ?? root, entry.path, entry.isDir)
                    }}
                  >
                    @
                  </button>
                </span>
              </div>
              {entry.isDir && isOpen && renderDir(entry.path, depth + 1)}
            </div>
          )
        })}
      </>
    )
  }

  const rootLabel = root === '' ? '' : root
  return (
    <div className="rvs-pane grow">
      <div className="rvs-header">
        <span className="rvs-title">{t('tab.files')}</span>
        <IconButton title={t('files.newFile')} onClick={() => setCreating({ dir: root, kind: 'file' })}>
          <IconPlus size={14} />
        </IconButton>
        <IconButton title={t('files.newFolder')} onClick={() => setCreating({ dir: root, kind: 'folder' })}>
          <IconNewFolder size={14} />
        </IconButton>
        <IconButton title={t('files.collapseAll')} onClick={() => setExpanded(new Set([root]))}>
          <IconChevronRight size={13} />
        </IconButton>
        <IconButton
          title={t('files.refresh')}
          onClick={() => { void loadDir(root, true) }}
          disabled={busy || loading.has(dirKey(alias, root))}
        >
          <IconRefresh size={14} />
        </IconButton>
        <IconButton title={props.showHidden ? t('files.hideHidden') : t('files.showHidden')} onClick={props.onToggleHidden}>
          <IconChevronDown size={13} />
        </IconButton>
      </div>
      <div
        className="rvs-scroll"
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelected(new Set())
        }}
      >
        <div className="rvs-tree" onContextMenu={(e) => openMenu(e, undefined)}>
          <div className="rvs-empty" style={{ textAlign: 'left', padding: '2px 8px', direction: 'rtl', unicodeBidi: 'plaintext' }} title={rootLabel}>
            <code style={{ fontSize: 11 }}>{rootLabel}</code>
          </div>
          {root !== '' && renderDir(root, 0)}
          {root === '' && <div className="rvs-empty">{t('files.selectWorkspace')}</div>}
        </div>
      </div>
      {menu.menu !== undefined && (
        <ContextMenu x={menu.menu.x} y={menu.menu.y} entries={menu.menu.entries} onClose={menu.close} />
      )}
    </div>
  )
}

/** Inline "new file / new folder" row (first child of its directory). */
function CreateRow(props: {
  depth: number
  kind: 'file' | 'folder'
  onCommit: (value: string) => void
  onCancel: () => void
  fileIcon: ReactNode
  folderIcon: ReactNode
  /** Translator, passed in: this component has no store scope of its own. */
  t: (key: string) => string
}): ReactNode {
  return (
    <div className="rvs-node" style={{ paddingLeft: 8 + props.depth * 14 }} onClick={(e) => e.stopPropagation()}>
      <span className="rvs-node-icon">{props.kind === 'folder' ? props.folderIcon : props.fileIcon}</span>
      <RenameInput
        initial=""
        placeholder={props.kind === 'folder' ? props.t('files.folderPlaceholder') : props.t('files.filePlaceholder')}
        onCommit={props.onCommit}
        onCancel={props.onCancel}
      />
    </div>
  )
}

/** Shared inline input (create + rename). */
function RenameInput(props: {
  initial: string
  placeholder?: string
  onCommit: (value: string) => void
  onCancel: () => void
}): ReactNode {
  const [value, setValue] = useState(props.initial)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => {
    const input = ref.current
    if (input === null) return
    input.focus()
    const dot = props.initial.lastIndexOf('.')
    if (dot > 0) input.setSelectionRange(0, dot)
    else input.select()
  }, [props.initial])

  const commit = (): void => {
    if (done.current) return
    done.current = true
    props.onCommit(value)
  }
  const cancel = (): void => {
    if (done.current) return
    done.current = true
    props.onCancel()
  }

  return (
    <input
      ref={ref}
      className="rvs-rename-input"
      value={value}
      placeholder={props.placeholder}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit() } else if (e.key === 'Escape') { e.preventDefault(); cancel() }
        e.stopPropagation()
      }}
      onBlur={() => {
        // A blur after Enter/Escape is a no-op; an empty create row is dropped.
        if (value.trim() === '') cancel()
        else commit()
      }}
    />
  )
}
