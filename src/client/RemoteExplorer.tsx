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
import { api, uploadFile } from './api.ts'
import { insertRemoteReference, sameLocalDir } from './composer.ts'
import { repoRelative, useExplorer } from './store.tsx'
import { planUpload, withDroppedDirs, type DroppedFile } from './upload-plan.ts'
import { collectDroppedFiles, type EntryLike } from './upload-source.ts'
import { useRemoteChatTarget } from './use-remote-chat-target.ts'
import {
  IconButton,
  IconChevronDown,
  IconChevronRight,
  IconNewFolder,
  IconPlus,
  IconRefresh,
  IconUpload,
  ContextMenu,
  FileIcon,
  FolderIcon,
  baseName,
  confirmDialog,
  copyText,
  gitLetter,
  gitStatusClass,
  isPreviewOnlyFile,
  MiniSpinner,
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

/**
 * How long one conflict probe may take before it is treated as "no conflict".
 *
 * The probe runs before any byte is sent, so an unbounded wait there is
 * indistinguishable from a drop that did nothing. A skipped probe costs one 409
 * round trip at most, which the host answers anyway.
 */
const PROBE_DEADLINE_MS = 8_000

/** Resolve `promise` or `undefined` after `ms` (never rejects). */
function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(() => {
      dropLog('deadline', { label, ms })
      resolve(undefined)
    }, ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(undefined)
      },
    )
  })
}

function dirKey(alias: string, dir: string): string {
  return `${alias}:${dir}`
}

/**
 * Console trace for the drag & drop path.
 *
 * A drop that the page accepts but this pane never sees leaves NO other trace:
 * no bar, no error, no failed request. That makes "拖拽上传不生效" impossible to
 * diagnose from a screenshot, so every hop logs one prefixed line (visible in
 * DevTools, ignorable otherwise).
 */
/** Viewport point of a drag event, when the browser reported one. */
function pointerOf(event: Event): { x: number; y: number } | undefined {
  if (!('clientX' in event)) return undefined
  const { clientX, clientY } = event as DragEvent
  if (typeof clientX !== 'number' || typeof clientY !== 'number') return undefined
  // A synthetic event without coordinates (0,0) would otherwise claim the
  // top-left corner of the pane.
  if (clientX === 0 && clientY === 0) return undefined
  return { x: clientX, y: clientY }
}

function dropLog(step: string, data: unknown): void {
  // eslint-disable-next-line no-console
  console.info('[dsh-remote-vs] drop', step, data)
}

/** Bytes as a short human string ("1.4 MB", "820 KB"). */
function shortSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/**
 * The upload bar text: file counter, percent and transferred bytes.
 *
 * The percentage is the point — this host moves single-digit MB/s, so a batch of
 * large logs is a minutes-long transfer, and a counter that only advances per
 * file looks exactly like a hung explorer (2026-10-20 user report: "一直上传
 * 中，也不能取消" — the bar was also still up during the 60 s git refresh).
 */
function formatUploadLabel(
  t: (key: string) => string,
  upload: { phase: 'preparing' | 'waiting' | 'uploading'; done: number; total: number; name: string; loaded: number; size: number },
): string {
  // Each phase names itself: "读取拖放内容" while a folder tree is walked,
  // "等待确认覆盖 N" while the conflict modal is up, then the transfer. A bar that
  // keeps claiming the first phase is what made a working drop look dead —
  // the conflict modal can sit unanswered forever (2026-10-20).
  if (upload.phase === 'preparing') return t('files.uploadPreparing')
  if (upload.phase === 'waiting') return `${t('files.uploadWaiting')} ${upload.name}`
  const counter = `${upload.done + 1}/${upload.total}`
  if (upload.size <= 0) return `${t('files.uploading')} ${counter} · ${upload.name}`
  const percent = Math.min(100, Math.floor((upload.loaded / upload.size) * 100))
  return `${t('files.uploading')} ${counter} · ${percent}% · ${shortSize(upload.loaded)}/${shortSize(upload.size)} · ${upload.name}`
}

/** How many directory listings stay cached; each one is a whole directory. */
const LISTING_CACHE_KEEP = 50

/**
 * Insert one listing as the newest, so "the first key is the oldest" stays
 * true and `trimListings` can evict from the front.
 */
function withListing(
  prev: Record<string, RemoteFileEntry[]>,
  key: string,
  entries: RemoteFileEntry[],
): Record<string, RemoteFileEntry[]> {
  const next: Record<string, RemoteFileEntry[]> = {}
  for (const [existing, value] of Object.entries(prev)) {
    if (existing !== key) next[existing] = value
  }
  next[key] = entries
  return next
}

/**
 * Drop the oldest listings past `LISTING_CACHE_KEEP`, never one that belongs to
 * an OPEN directory.
 *
 * Open ones are exempt on purpose: an evicted open directory has no rows to
 * draw from and nothing would ask for them again, so it would render as an
 * empty folder. `expanded` shrinks when a directory is collapsed (and is reset
 * on a binding change), which is exactly when its listing becomes evictable —
 * and a closed directory that comes back is simply re-listed.
 */
function trimListings(
  prev: Record<string, RemoteFileEntry[]>,
  keep: Set<string>,
): Record<string, RemoteFileEntry[]> {
  const keys = Object.keys(prev)
  const oldest = keys.length - LISTING_CACHE_KEEP
  if (oldest <= 0) return prev
  let next: Record<string, RemoteFileEntry[]> | undefined
  for (let i = 0; i < oldest; i++) {
    const key = keys[i] as string
    if (keep.has(key)) continue
    if (next === undefined) next = { ...prev }
    delete next[key]
  }
  return next ?? prev
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
  /** Non-empty while an OS FILE drag is over the tree (drop-to-upload hint). */
  const [dropHint, setDropHint] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  /**
   * Live upload batch. `done`/`total` drive the header line, `loaded`/`size` the
   * byte progress; `name` is the file currently on the wire. A silent
   * several-minute transfer of a big file is indistinguishable from a hang.
   */
  const [upload, setUpload] = useState<{
    phase: 'preparing' | 'waiting' | 'uploading'
    done: number
    total: number
    name: string
    loaded: number
    size: number
  } | undefined>(undefined)
  const dragPaths = useRef<string[]>([])
  /** Directory the pending hidden-input pick uploads into. */
  const uploadInto = useRef<string>('')
  const filePicker = useRef<HTMLInputElement>(null)
  const folderPickerHandle = useRef<HTMLInputElement | null>(null)
  /** The scroll container that owns the drop zone (capture listeners attach to document). */
  const treeRef = useRef<HTMLDivElement>(null)
  /** Abort handle for the batch on the wire (the upload bar's ✕). */
  const uploadAbort = useRef<AbortController | undefined>(undefined)
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
      setListings(prev => withListing(prev, key, entries))
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

  /**
   * "Show this folder in the tree" — raised by a search result's menu.
   *
   * Two stages, because the tree is lazy: expand every level from the root down
   * to the target (the listing of each level is fetched here) and then scroll
   * its row into view. The scroll is retried rather than delayed once: over SFTP
   * a deep level can take a moment, and the request carries a monotonic id so
   * asking for the SAME folder again still re-scrolls.
   */
  useEffect(() => {
    const request = store.revealRequest
    if (request === undefined) return
    const base = root.replace(/\/+$/, '')
    const target = request.path.replace(/\/+$/, '')
    if (target !== base && !target.startsWith(`${base}/`)) return
    const chain: string[] = []
    let walk = base
    for (const part of target.slice(base.length).split('/')) {
      if (part === '') continue
      walk = `${walk}/${part}`
      chain.push(walk)
    }
    for (const dir of chain) void loadDir(dir)
    if (chain.length > 0) {
      setExpanded((previous) => {
        const next = new Set(previous)
        for (const dir of chain) next.add(dir)
        return next
      })
    }
    let attempts = 0
    const timer = window.setInterval(() => {
      attempts += 1
      const row = Array.from(document.querySelectorAll<HTMLElement>('[data-rvs-path]'))
        .find((candidate) => candidate.dataset.rvsPath === target)
      if (row !== undefined) {
        window.clearInterval(timer)
        row.scrollIntoView({ block: 'center' })
        return
      }
      if (attempts > 20) window.clearInterval(timer)
    }, 150)
    return () => window.clearInterval(timer)
  }, [store.revealRequest, root, loadDir])

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

  /**
   * Keep the listing cache bounded. It holds one whole directory per path and
   * nothing ever dropped one: the panel is mounted for the life of the page, so
   * browsing for a day kept every directory ever listed — including a
   * `node_modules` — in memory for good. Collapsing a directory (and a binding
   * change, which clears `expanded` outright) is what makes its listing
   * evictable; `withListing` keeps the recency order this trims from the front.
   */
  useEffect(() => {
    const keep = new Set<string>()
    for (const dir of expanded) keep.add(dirKey(alias, dir))
    setListings(prev => trimListings(prev, keep))
  }, [expanded, alias, listings])

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

  // --------------------------------------------------------------- upload

  /**
   * Upload one batch into `dir`.
   *
   * The order is deliberate: plan (pure, normalizes every path) → probe the
   * batch for conflicts ONCE → ask once → create directories → send files one
   * by one. Asking per file would be unbearable for a folder drop, and
   * overwriting silently is not an option — a drop onto a source tree must not
   * clobber it without a word.
   *
   * @param dir - absolute remote directory that receives the batch.
   * @param entries - files with paths relative to `dir`.
   * @param extraDirs - directories the drop walked (keeps empty folders).
   */
  const runUpload = async (
    dir: string,
    entries: DroppedFile[],
    blobs: Map<string, Blob>,
    extraDirs: string[],
  ): Promise<void> => {
    dropLog('runUpload', { dir, alias, entries: entries.length })
    if (alias === '' || dir === '') return
    const plan = withDroppedDirs(planUpload(entries), extraDirs)
    dropLog('plan', { files: plan.files.length, dirs: plan.dirs.length, skipped: plan.skipped.length })
    if (plan.files.length === 0 && plan.dirs.length === 0) {
      if (plan.skipped.length > 0) toast(t('files.uploadSkipped'), true)
      setUpload(undefined)
      return
    }
    const remoteOf = (rel: string): string => joinAbs(dir, rel)

    // The cancel handle exists for the WHOLE batch, not just the transfer: the
    // conflict prompt is a modal that can sit unanswered, and ✕ used to do
    // nothing while it was up (2026-10-20 "不能取消").
    const controller = new AbortController()
    uploadAbort.current = controller

    // Conflict probe: one stat per file, bounded concurrency (a folder drop can
    // hold thousands of files and the host has a channel ceiling). Every probe is
    // deadline-guarded: a wedged host turned this into a silent, unbounded wait
    // (the bar sat at "正在读取拖放内容…" with nothing happening). A timeout counts
    // as "no conflict", so the upload still proceeds and the route's own 409 is
    // the backstop.
    const conflicts: string[] = []
    const probe = async (rel: string): Promise<boolean> => {
      try {
        const result = await withDeadline(api.fileOp.stat(alias, remoteOf(rel)), PROBE_DEADLINE_MS, 'stat')
        return result !== undefined
      } catch {
        return false
      }
    }
    for (let index = 0; index < plan.files.length; index += 16) {
      const slice = plan.files.slice(index, index + 16)
      const flags = await Promise.all(slice.map(file => probe(file.rel)))
      for (let offset = 0; offset < flags.length; offset += 1) {
        if (flags[offset] === true) conflicts.push(slice[offset].rel)
      }
    }
    dropLog('probe-done', { conflicts: conflicts.length, planned: plan.files.length })
    let overwrite = false
    if (conflicts.length > 0) {
      // Name the wait in the bar: an unanswered modal behind a bar that still
      // says "reading…" is indistinguishable from a dead drop zone.
      setUpload({ phase: 'waiting', done: 0, total: plan.files.length, name: `${conflicts.length}`, loaded: 0, size: 0 })
      const ok = await Promise.race([
        confirmDialog({
          title: t('files.uploadConflict'),
          text: conflicts.slice(0, 8).join('\n') + (conflicts.length > 8 ? `\n… (${conflicts.length})` : ''),
          okText: t('files.overwrite'),
        }),
        new Promise<boolean>((resolve) => {
          if (controller.signal.aborted) {
            resolve(false)
            return
          }
          controller.signal.addEventListener('abort', () => resolve(false), { once: true })
        }),
      ])
      if (!ok) {
        // ✕ during the prompt (or a dismissed modal) ends the batch here.
        uploadAbort.current = undefined
        setUpload(undefined)
        return
      }
      overwrite = true
    }

    setBusy(true)
    const failed: string[] = []
    const touched = new Set<string>([dir])
    let sent = 0
    let cancelled = false
    try {
      for (const sub of plan.dirs) {
        if (controller.signal.aborted) break
        try {
          await api.fileOp.mkdir(alias, remoteOf(sub))
          touched.add(remoteOf(sub).split('/').slice(0, -1).join('/') || '/')
        } catch (error) {
          // A failed mkdir only matters if a file below it also fails; keep the
          // message for the summary instead of aborting the whole batch.
          failed.push(`${sub}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const total = plan.files.filter(file => blobs.has(file.rel)).length
      for (const file of plan.files) {
        if (controller.signal.aborted) break
        const blob = blobs.get(file.rel)
        if (blob === undefined) {
          dropLog('missing-blob', { rel: file.rel, keys: [...blobs.keys()].slice(0, 5) })
          continue
        }
        dropLog('upload-file', { rel: file.rel, blobSize: blob.size, overwrite })
        const known = blob.size > 0 ? blob.size : (file.size > 0 ? file.size : 0)
        setUpload({ phase: 'uploading', done: sent, total, name: file.rel, loaded: 0, size: known })
        try {
          await uploadFile({
            alias,
            path: remoteOf(file.rel),
            blob,
            overwrite,
            signal: controller.signal,
            // Byte-level progress is not decoration: this host moves ~9 MB/s,
            // so a large log is a MINUTES-long transfer and a count-only bar
            // reads as a hang.
            onProgress: (progress) => {
              setUpload({
                phase: 'uploading',
                done: sent,
                total,
                name: file.rel,
                loaded: progress.loaded,
                size: progress.total > 0 ? progress.total : known,
              })
            },
          })
          const parent = remoteOf(file.rel).split('/').slice(0, -1).join('/') || '/'
          touched.add(parent)
        } catch (error) {
          if (controller.signal.aborted) {
            cancelled = true
            break
          }
          failed.push(`${file.rel}: ${error instanceof Error ? error.message : String(error)}`)
        }
        sent += 1
      }
    } finally {
      cancelled = cancelled || controller.signal.aborted
      // Clear the bar BEFORE any refresh. `afterWrite()` runs a full git status,
      // which takes ~60 s on this tree; keeping the bar up through it made a
      // finished (or cancelled) upload look stuck and made ✕ look dead.
      uploadAbort.current = undefined
      setUpload(undefined)
      setBusy(false)
    }
    // Refresh the listings the batch touched — cheap SFTP lists — and let the
    // git panel update in the background instead of gating the UI on it.
    await refreshDirs([...touched])
    void store.afterWrite()
    if (cancelled) {
      toast(`${t('files.uploadAbort')}: ${sent}/${plan.files.length}`, false)
      return
    }
    if (failed.length > 0) toast(failed.join('\n'), true)
    else toast(`${t('files.uploaded')} ${plan.files.length}`)
  }

  /** Turn a DataTransfer into relative file paths (folder drops included). */
  const uploadFromDataTransfer = useCallback(async (dir: string, transfer: DataTransfer): Promise<void> => {
    // Acknowledge the drop IMMEDIATELY. Walking a folder tree can take a while,
    // and before this line the panel showed nothing at all until the first byte
    // was sent — indistinguishable from a dead drop zone.
    setUpload({ phase: 'preparing', done: 0, total: 0, name: '', loaded: 0, size: 0 })
    const plain = [...transfer.files]
    /** Flat fallback: real drags always populate `files`, folder structure or not. */
    const uploadPlain = async (): Promise<void> => {
      if (plain.length === 0) {
        setUpload(undefined)
        // Neither entries NOR files is the one case that used to do nothing at
        // all — no bar, no error, no trace (2026-10-20). Say so instead.
        toast(`${t('files.uploadSkipped')} (${[...transfer.types].join(',')})`, true)
        return
      }
      const blobs = new Map<string, Blob>(plain.map(file => [file.name, file]))
      await runUpload(dir, plain.map(file => ({ rel: file.name, size: file.size })), blobs, [])
    }

    const items = [...transfer.items]
    const entries: EntryLike[] = []
    for (const item of items) {
      // `webkitGetAsEntry` is the only way to see a dropped FOLDER's contents;
      // `files` flattens it to nothing useful.
      const handle = item as DataTransferItem & { webkitGetAsEntry?: () => EntryLike | null }
      const entry = handle.webkitGetAsEntry?.()
      if (entry !== null && entry !== undefined) entries.push(entry)
    }
    dropLog('transfer', { entries: entries.length, files: plain.length })
    if (entries.length > 0) {
      try {
        const collected = await collectDroppedFiles(entries)
        dropLog('collected', { files: collected.files.length, dirs: collected.dirs.length })
        if (collected.files.length > 0 || plain.length === 0) {
          const blobs = new Map<string, Blob>(collected.files.map(file => [file.rel, file.blob]))
          await runUpload(dir, collected.files.map(file => ({ rel: file.rel, size: file.size })), blobs, collected.dirs)
          return
        }
        // The walk produced no files even though the drag carried some: fall
        // through to the flat list rather than doing nothing.
        dropLog('walk-empty', { entries: entries.length })
      } catch (error) {
        // The entry API is best-effort: a browser that never answers it must not
        // cost the user the upload. Log it, then use the flat list.
        dropLog('walk-failed', String(error))
      }
    }
    await uploadPlain()
    // `runUpload` is redefined on every render; routing through the latest one
    // keeps the capture listeners attached once per binding instead of being
    // torn down and rebuilt on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alias, root, refreshDirs, store, t])

  /** True when the drag carries OS files rather than one of our own rows. */
  const isFileDrag = (transfer: DataTransfer | null): boolean =>
    transfer !== null && [...transfer.types].includes('Files')

  const handleDrop = (dir: string, event: React.DragEvent): void => {
    if (!isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    setDropTarget(undefined)
    setDropHint(undefined)
    const transfer = event.dataTransfer
    void uploadFromDataTransfer(dir, transfer).catch((error: unknown) => {
      toast(error instanceof Error ? error.message : String(error), true)
    })
  }

  /**
   * Where a drop lands: the row under the pointer, else the workspace root.
   *
   * Reads the `data-rvs-*` attributes rather than React state so the capture
   * listeners below (which run OUTSIDE React's tree) resolve the same target.
   */
  const dropDirFromEvent = (event: DragEvent | Event): string => {
    const point = pointerOf(event)
    // `elementsFromPoint` rather than `event.target`: the DSH shell paints a
    // full-screen "拖动到此处即可添加" overlay over the whole window during a file
    // drag, so the event target is that overlay, NOT the row underneath it. The
    // hit stack still contains our row, so walk it.
    if (point !== undefined) {
      for (const element of document.elementsFromPoint(point.x, point.y)) {
        const row = element.closest('[data-rvs-path]')
        if (row === null) continue
        const hit = row.getAttribute('data-rvs-path') ?? ''
        if (hit === '') continue
        return row.getAttribute('data-rvs-dir') === '1' ? hit : (hit.split('/').slice(0, -1).join('/') || '/')
      }
    }
    const target = event.target
    const element = target instanceof Element ? target.closest('[data-rvs-path]') : null
    const path = element?.getAttribute('data-rvs-path') ?? ''
    if (path === '') return root
    if (element?.getAttribute('data-rvs-dir') === '1') return path
    return path.split('/').slice(0, -1).join('/') || '/'
  }

  // The drop zone defends itself on WINDOW CAPTURE (window runs before document).
  //
  // `dsh-client-ui-attachment` (and dsh-client-ui-workspace) install their own
  // document-level dragover/drop listeners. The attachment one sets
  // `dataTransfer.dropEffect = canAcceptDrop ? 'copy' : 'none'`, and since it runs
  // AFTER our React handler it overwrote our effect with 'none' — the browser
  // then cancels the drop outright and no `drop` event ever reaches the tree
  // (2026-10-20 user report: "拖拽上传也不生效"). Taking the event in the capture
  // phase makes this pane's verdict final; drags outside it (the chat composer)
  // are untouched. Window capture outranks the document-level handlers other
  // plugins install (dsh-client-ui-attachment, dsh-client-ui-workspace, and a
  // file-upload plugin that calls stopPropagation), whose registration order we
  // cannot control.)
  useEffect(() => {
    const pane = treeRef.current
    if (pane === null) return
    /**
     * Decide by POINTER POSITION, not by `event.target`.
     *
     * The chat composer paints a full-screen "拖动到此处即可添加" overlay during any
     * file drag, so a real drop's target is that overlay — outside this pane —
     * and a target test silently disowns every real drag while still passing in
     * tests that dispatch events at a row (2026-10-20, overlay screenshot).
     */
    const overPane = (event: DragEvent): boolean => {
      const point = pointerOf(event)
      if (point === undefined) return false
      const rect = pane.getBoundingClientRect()
      return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
    }
    /** Take the event away from the composer's document-level handlers. */
    const claim = (event: DragEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
    }
    const onDragEnter = (event: DragEvent): void => {
      if (!isFileDrag(event.dataTransfer) || !overPane(event)) return
      claim(event)
      setDropTarget(root)
      setDropHint(root)
    }
    const onDragOver = (event: DragEvent): void => {
      if (!isFileDrag(event.dataTransfer) || !overPane(event)) return
      claim(event)
      setDropTarget(root)
      setDropHint(root)
    }
    const onDrop = (event: DragEvent): void => {
      dropLog('drop', {
        types: event.dataTransfer === null ? null : [...event.dataTransfer.types],
        overPane: overPane(event),
        target: (event.target as Element | null)?.className?.toString().slice(0, 40) ?? null,
        items: event.dataTransfer === null ? 0 : event.dataTransfer.items.length,
        files: event.dataTransfer === null ? 0 : event.dataTransfer.files.length,
      })
      if (!isFileDrag(event.dataTransfer) || !overPane(event)) return
      const transfer = event.dataTransfer
      if (transfer === null) return
      claim(event)
      const dir = dropDirFromEvent(event)
      setDropTarget(undefined)
      setDropHint(undefined)
      void uploadFromDataTransfer(dir, transfer).catch((error: unknown) => {
        toast(error instanceof Error ? error.message : String(error), true)
      })
    }
    const onDragLeave = (event: DragEvent): void => {
      // Only when the pointer actually left the pane: the overlay's own
      // dragleave fires for unrelated targets and used to clear the hint
      // mid-drag.
      if (overPane(event)) return
      setDropTarget(undefined)
      setDropHint(undefined)
    }
    window.addEventListener('dragenter', onDragEnter, true)
    window.addEventListener('dragover', onDragOver, true)
    window.addEventListener('drop', onDrop, true)
    window.addEventListener('dragleave', onDragLeave, true)
    return () => {
      window.removeEventListener('dragenter', onDragEnter, true)
      window.removeEventListener('dragover', onDragOver, true)
      window.removeEventListener('drop', onDrop, true)
      window.removeEventListener('dragleave', onDragLeave, true)
    }
    // `uploadFromDataTransfer` closes over the current alias/root/plan state, so
    // the listeners are re-attached whenever that identity would change.
  }, [root, alias, uploadFromDataTransfer])

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
        label: t('files.uploadFile'),
        onSelect: () => {
          uploadInto.current = dir
          filePicker.current?.click()
        },
      },
      {
        label: t('files.uploadFolder'),
        onSelect: () => {
          uploadInto.current = dir
          folderPickerHandle.current?.click()
        },
      },
      {
        label: t('files.pasteHere'),
        onSelect: () => { void doPaste(dir) },
        disabled: clipboard === undefined,
        hint: clipboard === undefined ? undefined : `${clipboard.paths.length}`,
      },
    ]
    if (entry !== undefined) {
      entries.push({ label: t('files.open'), onSelect: () => openEntry(entry), separated: true })
      if (!entry.isDir) {
        // 「在悬浮编辑器中打开」: the editor surface floats above the app shell,
        // above whatever conversation view is selected. Disabled only when the
        // host has no frame-wide overlay slot to host the window (see
        // `FloatingEditorWindow`'s availability handshake).
        //
        // Deliberately opens the FILE, not the working-tree diff the adjacent
        // "Open" entry may choose for a changed file: this is the editor, and a
        // diff is not an editing surface (SCM's own entry keeps the diff
        // semantics because that list is about changes).
        entries.push({
          label: t('files.openInFloat'),
          onSelect: () => { store.openInFloatEditor(entry.path) },
          disabled: !store.floatAvailable,
        })
      }
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
                // Read by the document-level capture drop listeners, which live
                // outside React's tree and cannot see component state.
                data-rvs-path={entry.path}
                data-rvs-dir={entry.isDir ? '1' : '0'}
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
                  // An OS file drag targets this row's DIRECTORY: a drop on a
                  // file row means "put it beside that file" (what the user
                  // means when they aim at a file in the list).
                  if (isFileDrag(e.dataTransfer)) {
                    e.preventDefault()
                    e.stopPropagation()
                    setDropTarget(entry.path)
                    setDropHint(entry.isDir ? entry.path : (entry.path.split('/').slice(0, -1).join('/') || '/'))
                    return
                  }
                  if (!entry.isDir) return
                  const source = dragPaths.current[0]
                  if (source === undefined) return
                  if (entry.path === source || entry.path.startsWith(`${source}/`)) return
                  e.preventDefault()
                  setDropTarget(entry.path)
                }}
                onDragLeave={() => { setDropTarget(current => (current === entry.path ? undefined : current)) }}
                onDrop={(e) => {
                  if (isFileDrag(e.dataTransfer)) {
                    const into = entry.isDir ? entry.path : (entry.path.split('/').slice(0, -1).join('/') || '/')
                    handleDrop(into, e)
                    return
                  }
                  if (entry.isDir) void doDrop(entry.path, e)
                }}
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
          title={t('files.uploadFile')}
          onClick={() => {
            uploadInto.current = root
            filePicker.current?.click()
          }}
          disabled={alias === '' || root === '' || upload !== undefined}
        >
          <IconUpload size={14} />
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
      {upload !== undefined && (
        <div className="rvs-upload-bar">
          <MiniSpinner />
          <span className="rvs-upload-text" title={`${upload.done + 1}/${upload.total} · ${upload.name}`}>
            {formatUploadLabel(t, upload)}
          </span>
          <button
            type="button"
            className="rvs-hbtn"
            title={t('files.uploadAbort')}
            onClick={() => uploadAbort.current?.abort()}
          >
            ✕
          </button>
        </div>
      )}
      {/* Hidden pickers for the context-menu / header "Upload…" entries. The
          folder input needs `webkitdirectory`, which React does not type. */}
      <input
        ref={filePicker}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const picked = [...(e.target.files ?? [])]
          e.target.value = ''
          const dir = uploadInto.current || root
          const blobs = new Map<string, Blob>(picked.map(file => [file.name, file]))
          void runUpload(dir, picked.map(file => ({ rel: file.name, size: file.size })), blobs, [])
        }}
      />
      <input
        ref={(element) => {
          // A callback ref may not assign to the ref object of a `useRef`
          // initialised with null under this repo's strict types, so the handle
          // is kept in a mutable holder that `click()` reads.
          folderPickerHandle.current = element
          if (element !== null) element.setAttribute('webkitdirectory', '')
        }}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const picked = [...(e.target.files ?? [])]
          e.target.value = ''
          const dir = uploadInto.current || root
          const entries: DroppedFile[] = []
          const blobs = new Map<string, Blob>()
          const dirs = new Set<string>()
          for (const file of picked) {
            // `webkitRelativePath` is the folder the user picked plus the path
            // inside it; the picked folder itself becomes the top directory.
            const raw = (file as File & { webkitRelativePath?: string }).webkitRelativePath
            const rel = raw !== undefined && raw !== '' ? raw : file.name
            entries.push({ rel, size: file.size })
            blobs.set(rel, file)
            const parts = rel.split('/')
            parts.pop()
            let current = ''
            for (const part of parts) {
              current = current === '' ? part : `${current}/${part}`
              dirs.add(current)
            }
          }
          void runUpload(dir, entries, blobs, [...dirs])
        }}
      />
      <div
        ref={treeRef}
        className="rvs-scroll"
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelected(new Set())
        }}
        // Drop handlers live on the SCROLL container, not on `.rvs-tree`: when
        // the tree is shorter than the pane, the empty space below it belongs to
        // the scroll box, and dropping there (the natural target for "put it in
        // this workspace") must still work. Row handlers stop propagation, so
        // the row's directory wins when one is under the pointer.
        onDragOver={(e) => {
          if (!isFileDrag(e.dataTransfer)) return
          e.preventDefault()
          setDropTarget(root)
          setDropHint(root)
        }}
        onDragLeave={(e) => {
          if (e.target !== e.currentTarget) return
          setDropTarget(undefined)
          setDropHint(undefined)
        }}
        onDrop={(e) => handleDrop(root, e)}
      >
        <div className="rvs-tree" onContextMenu={(e) => openMenu(e, undefined)}>
          <div className="rvs-empty" style={{ textAlign: 'left', padding: '2px 8px', direction: 'rtl', unicodeBidi: 'plaintext' }} title={rootLabel}>
            <code style={{ fontSize: 11 }}>{rootLabel}</code>
          </div>
          {/* A file drag says where it will land, so a slip cannot drop a tree
              into the wrong directory unnoticed. */}
          {dropTarget !== undefined && dropHint !== undefined && (
            <div className="rvs-drop-hint" title={dropTarget}>
              {`${t('files.dropToUpload')} → ${dropTarget.split('/').slice(-1)[0] || dropTarget}`}
            </div>
          )}
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
