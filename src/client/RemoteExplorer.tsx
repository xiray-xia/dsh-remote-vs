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
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { copyIntoCommand, joinAbs, moveToCommand } from '../fs-ops.ts'
import { MAX_SELECTION_DOWNLOAD, type RemoteFileEntry } from '../protocol.ts'
import { api, uploadFile } from './api.ts'
import { startDownload, startSelectionDownload } from './downloads.ts'
import { useConnectionStatus, isConnectionFailure } from './connection.ts'
import { createDragExpander, type DragExpander } from './drag-expand.ts'
import { insertRemoteReference, sameLocalDir } from './composer.ts'
import { ListingRequests } from './listing-requests.ts'
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
  ExplorerFileIcon,
  ExplorerFolderIcon,
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
 * Whether a "show this folder" request still needs to be processed.
 *
 * The store keeps the request object after it has been handled, and this effect
 * re-runs whenever `root`/`loadDir` change (workspace switch, offline flip). No
 * consumed marker meant switching back to a workspace replayed the OLD reveal:
 * it re-expanded the ancestor chain and scrolled away from wherever the user was.
 */
export function shouldConsumeReveal(lastId: number, id: number): boolean {
  return lastId !== id
}

/**
 * Whether a remote WRITE may start.
 *
 * Uploads hold one `AbortController` slot and a batch can run for minutes; a
 * second upload used to overwrite that slot (the first became uncancellable and
 * the two progress bars overwrote each other), and paste/delete could interleave
 * with the transfer. Serializing writes through one flag is the smallest fix;
 * read-only browsing stays allowed.
 */
export function writeAllowed(transferActive: boolean): boolean {
  return !transferActive
}

/**
 * Whether the write ENTRIES (new file/folder, upload, paste, delete) are
 * disabled right now.
 *
 * @param transferActive - is a write batch currently holding the slot?
 *
 * This is a named function, not an inline expression, because the expression it
 * replaces was a double negative that inverted itself:
 * `!writeAllowed(upload === undefined)` passes `true` ("busy") exactly when
 * nothing is uploading, so the whole write menu was greyed out while idle and
 * came alive during an upload — while the toolbar's own buttons, which test
 * `upload !== undefined` directly, disagreed with it on the same screen. Two
 * surfaces, one state, opposite answers.
 */
export function writeEntriesDisabled(transferActive: boolean): boolean {
  return !writeAllowed(transferActive)
}

/** True when `path` is `prefix` itself or a descendant of it. */
export function pathUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

/**
 * Where a copy/cut/move of `sourcePath` into `intoDir` lands.
 *
 * `fs-ops`' commands copy/move the entry KEEPING its basename, so the new path
 * is `intoDir/<basename>`; the explorer needs it to re-key its path indexes.
 */
export function destinationOfMove(intoDir: string, sourcePath: string): string {
  const trimmed = sourcePath.replace(/\/+$/, '')
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return `${intoDir.replace(/\/+$/, '')}/${base}`
}

/**
 * Drop every path that is (or lives under) a removed path from a path-keyed set.
 *
 * `expanded` / `selected` / `anchor` are absolute-path indexes. Renaming re-keys
 * them (see `rekeyPaths`), but deleting or moving a subtree used to leave the
 * old paths behind: the root refresh effect then re-listed directories that no
 * longer exist on every revision bump (one failed SFTP request and one error
 * toast each), and `trimListings` protected those dead keys from eviction.
 */
export function withoutPaths(set: Set<string>, removed: readonly string[]): Set<string> {
  if (removed.length === 0) return set
  const next = new Set<string>()
  let changed = false
  for (const path of set) {
    if (removed.some(root => pathUnder(path, root))) {
      changed = true
      continue
    }
    next.add(path)
  }
  return changed ? next : set
}

/** Re-key a path-keyed set after a rename/move of `from` to `to`. */
export function rekeyPaths(set: Set<string>, from: string, to: string): Set<string> {
  const next = new Set<string>()
  let changed = false
  for (const path of set) {
    if (pathUnder(path, from)) {
      next.add(`${to}${path.slice(from.length)}`)
      changed = true
    } else {
      next.add(path)
    }
  }
  return changed ? next : set
}

/**
 * Drop cached listings for removed paths.
 *
 * Same reason as `withoutPaths`, for the listing cache: a dead key would keep a
 * whole directory's rows in memory forever (plus a requested-but-failing list
 * on every refresh), while `trimListings` still counts it against the 50-entry
 * budget of LIVE directories.
 */
export function withoutListingPaths(
  listings: Record<string, RemoteFileEntry[]>,
  alias: string,
  removed: readonly string[],
): Record<string, RemoteFileEntry[]> {
  if (removed.length === 0) return listings
  const prefix = dirKey(alias, '')
  const next: Record<string, RemoteFileEntry[]> = {}
  let changed = false
  for (const [key, rows] of Object.entries(listings)) {
    const path = key.startsWith(prefix) ? key.slice(prefix.length) : key
    if (removed.some(root => pathUnder(path, root))) {
      changed = true
      continue
    }
    next[key] = rows
  }
  return changed ? next : listings
}

/** Re-key cached listings after a rename/move (memo keys are `alias:path`). */
export function rekeyListings(
  listings: Record<string, RemoteFileEntry[]>,
  alias: string,
  from: string,
  to: string,
): Record<string, RemoteFileEntry[]> {
  const prefix = dirKey(alias, '')
  const next: Record<string, RemoteFileEntry[]> = {}
  let changed = false
  for (const [key, rows] of Object.entries(listings)) {
    if (!key.startsWith(prefix)) {
      next[key] = rows
      continue
    }
    const path = key.slice(prefix.length)
    if (pathUnder(path, from)) {
      next[dirKey(alias, `${to}${path.slice(from.length)}`)] = rows
      changed = true
    } else {
      next[key] = rows
    }
  }
  return changed ? next : listings
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
 * Hover intent before a directory's listing is prefetched: long enough that
 * sweeping the pointer across the tree does not fire a request per row, short
 * enough that arriving at a folder and clicking it finds the listing warm.
 */
const PREFETCH_HOVER_MS = 150

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

/**
 * One rendered line of the flattened tree.
 *
 * The tree is rendered as a FLAT pre-order list (not nested components): the
 * rows of a large directory then each own one memoized component whose props are
 * primitives, so a selection change, an upload progress tick or an unrelated
 * store publish only re-renders the rows that actually changed. Nesting the
 * recursion in JSX made every row a child of its parent row, which defeated
 * `memo` (the children element was new on every render).
 */
export type ExplorerRow =
  | { kind: 'entry'; entry: RemoteFileEntry; depth: number }
  | { kind: 'create'; dir: string; createKind: 'file' | 'folder'; depth: number }
  /** An expanded directory whose listing is not available yet (loading/offline). */
  | { kind: 'pending'; dir: string; depth: number; reason: 'loading' | 'offline' }

/**
 * What double-clicking a row should open.
 *
 * `undefined` for a directory: `store.openFile()` has no type guard of its own,
 * so handing it a directory path produced an editor tab whose Host read answers
 * `not a file: … is a directory` — and the click also switched the surface to
 * the editor. The guard lives here (and is applied in the row action) so every
 * caller inherits it; the pre-refactor renderer had the same check inline.
 */
export function rowOpenTarget(entry: RemoteFileEntry): string | undefined {
  return entry.isDir ? undefined : entry.path
}

/**
 * Flatten the loaded part of the tree into pre-order rows.
 *
 * Pure: the gate drives it with a synthetic `rowsOf`/`isExpanded` pair. The
 * depth of a directory's entries is its own depth + 1 (same indentation the
 * recursive renderer used), and the inline "new file/folder" row is emitted
 * before that directory's children.
 *
 * `placeholderOf` makes an expanded directory with no listing yet emit a
 * `pending` row. Before the flat rewrite the recursive renderer did this for
 * EVERY directory; after it only the root had a placeholder, so expanding a
 * cold (or offline) directory showed nothing until the listing landed.
 */
export function buildVisibleRows(input: {
  root: string
  rowsOf: (dir: string) => RemoteFileEntry[] | undefined
  isExpanded: (path: string) => boolean
  creating?: { dir: string; kind: 'file' | 'folder' }
  placeholderOf?: (dir: string) => 'loading' | 'offline' | undefined
}): ExplorerRow[] {
  if (input.root === '') return []
  const out: ExplorerRow[] = []
  const walk = (dir: string, depth: number): void => {
    const creating = input.creating
    if (creating?.dir === dir) out.push({ kind: 'create', dir, createKind: creating.kind, depth })
    for (const entry of input.rowsOf(dir) ?? []) {
      out.push({ kind: 'entry', entry, depth })
      if (!entry.isDir || !input.isExpanded(entry.path)) continue
      const children = input.rowsOf(entry.path)
      if (children === undefined) {
        const reason = input.placeholderOf?.(entry.path)
        if (reason !== undefined) out.push({ kind: 'pending', dir: entry.path, depth: depth + 1, reason })
        continue
      }
      walk(entry.path, depth + 1)
    }
  }
  walk(input.root, 0)
  return out
}

/**
 * Where a keyboard move from `currentPath` lands.
 *
 * Pure so the a11y gate can pin the tree navigation without mounting React:
 * `up`/`down` walk the flat visible rows, `parent` finds the enclosing directory
 * row (if it is still visible), `child` the first row under a directory.
 */
export function rowKeyboardTarget(
  rows: readonly ExplorerRow[],
  currentPath: string,
  intent: 'up' | 'down' | 'parent' | 'child',
): string | undefined {
  const entries = rows.filter((row): row is Extract<ExplorerRow, { kind: 'entry' }> => row.kind === 'entry')
  const at = entries.findIndex(row => row.entry.path === currentPath)
  if (at < 0) return undefined
  if (intent === 'up') return entries[at - 1]?.entry.path
  if (intent === 'down') return entries[at + 1]?.entry.path
  const current = entries[at] as { depth: number }
  if (intent === 'child') {
    const next = entries[at + 1]
    return next !== undefined && next.depth > current.depth ? next.entry.path : undefined
  }
  for (let index = at - 1; index >= 0; index -= 1) {
    const candidate = entries[index] as { depth: number; entry: RemoteFileEntry }
    if (candidate.depth < current.depth) return candidate.entry.path
  }
  return undefined
}

/**
 * Which row should own the tree's Tab stop.
 *
 * The roving tabindex puts `tabIndex={0}` on exactly ONE row (the focused one),
 * so a focused path that stops existing — the row was deleted, renamed, or its
 * directory collapsed — leaves every row at -1 and the whole tree unreachable by
 * keyboard. This keeps a stop alive: an existing focused row wins, otherwise the
 * first row does, otherwise none (empty tree).
 *
 * Pure, so the gate can pin the fallback without mounting React.
 */
export function nextFocusPath(rows: readonly ExplorerRow[], focusedPath: string | undefined): string | undefined {
  const entries = rows.filter((row): row is Extract<ExplorerRow, { kind: 'entry' }> => row.kind === 'entry')
  if (focusedPath !== undefined && entries.some(row => row.entry.path === focusedPath)) return focusedPath
  return entries[0]?.entry.path
}

/** Handlers one row needs, held in a ref so a memoized row never re-renders for them. */
export interface ExplorerRowActions {
  select: (entry: RemoteFileEntry, event: React.MouseEvent) => void
  openFile: (entry: RemoteFileEntry) => void
  hoverDir: (path: string | undefined) => void
  openMenu: (event: React.MouseEvent, entry: RemoteFileEntry) => void
  contextMenu: (event: React.MouseEvent, entry: RemoteFileEntry) => void
  startDrag: (entry: RemoteFileEntry) => void
  dragOver: (entry: RemoteFileEntry, event: React.DragEvent) => void
  dragLeave: (entry: RemoteFileEntry) => void
  dropOn: (entry: RemoteFileEntry, event: React.DragEvent) => void
  commitRename: (entry: RemoteFileEntry, name: string) => void
  cancelRename: () => void
  reference: (entry: RemoteFileEntry) => void
  /** Keyboard navigation: ↑↓←→/Home/End/Enter/Space/Shift+F10 live in the parent. */
  keyDown: (entry: RemoteFileEntry, event: React.KeyboardEvent) => void
  focusPath: (path: string) => void
}

interface ExplorerRowProps {
  entry: RemoteFileEntry
  depth: number
  status: string | undefined
  ignored: boolean
  isSelected: boolean
  isOpen: boolean
  isCut: boolean
  isDropTarget: boolean
  isRenaming: boolean
  isFocused: boolean
  chatEnabled: boolean
  /** Precomputed so `t` (whose identity may change with a store publish) is not a prop. */
  referenceTitle: string
  symlinkTitle: string
  actions: MutableRefObject<ExplorerRowActions>
}

/**
 * One tree row.
 *
 * Memoized on primitive props: the parent re-renders on every store publish and
 * on each upload-progress tick, and without this every one of those re-rendered
 * the whole expanded tree (a 20 000-entry directory means 20 000 rows).
 */
export const ExplorerRowView = memo(function ExplorerRowView(props: ExplorerRowProps): ReactNode {
  const { entry, depth, status, ignored, isSelected, isOpen, isCut, isDropTarget, isRenaming, isFocused, chatEnabled, actions } = props
  const { openMenu } = actions.current
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={isSelected}
      // Directories expose their expansion; files have no aria-expanded.
      {...(entry.isDir ? { 'aria-expanded': isOpen } : {})}
      tabIndex={isFocused ? 0 : -1}
      onFocus={() => actions.current.focusPath(entry.path)}
      onKeyDown={(e) => actions.current.keyDown(entry, e)}
      className={[
        'rvs-node',
        isSelected ? 'selected' : '',
        isCut ? 'cut' : '',
        isDropTarget ? 'drop-target' : '',
        isFocused ? 'focused' : '',
      ].filter(Boolean).join(' ')}
      style={{ paddingLeft: 8 + depth * 14 }}
      title={entry.path}
      // Read by the document-level capture drop listeners, which live
      // outside React's tree and cannot see component state.
      data-rvs-path={entry.path}
      data-rvs-dir={entry.isDir ? '1' : '0'}
      draggable
      onClick={(e) => actions.current.select(entry, e)}
      onDoubleClick={() => actions.current.openFile(entry)}
      // Hover-intent prefetch: a directory the pointer rests on gets its
      // listing warmed, so the click that follows paints instead of
      // waiting one round trip. Leave/collapse cancels the pending one.
      onMouseEnter={() => { if (entry.isDir) actions.current.hoverDir(entry.path) }}
      onMouseLeave={() => actions.current.hoverDir(undefined)}
      // Right-click opens on POINTERDOWN — the first event of the
      // gesture — so the menu is already mounted before any later
      // event of the same click (a platform may replay mousedown, and
      // a background git refresh may scroll) can close it. The
      // contextmenu fallback covers surfaces that only send that
      // (touch long-press).
      onPointerDown={(e) => { if (e.button === 2) openMenu(e, entry) }}
      onContextMenu={(e) => { actions.current.contextMenu(e, entry) }}
      onDragStart={(e) => {
        actions.current.startDrag(entry)
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', entry.path)
      }}
      onDragOver={(e) => { actions.current.dragOver(entry, e) }}
      onDragLeave={() => { actions.current.dragLeave(entry) }}
      onDrop={(e) => { actions.current.dropOn(entry, e) }}
    >
      <span className="rvs-node-icon">
        {entry.isDir
          ? <ExplorerFolderIcon path={entry.path} open={isOpen} size={16} />
          : <ExplorerFileIcon path={entry.path} size={16} />}
      </span>
      {isRenaming
        ? (
          <RenameInput
            initial={entry.name}
            onCommit={(value) => { actions.current.commitRename(entry, value) }}
            onCancel={() => actions.current.cancelRename()}
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
      {entry.isSymlink && <span className="rvs-hit-dir" title={props.symlinkTitle}>↩</span>}
      <span className="rvs-node-actions">
        <button
          type="button"
          className="rvs-hbtn"
          title={props.referenceTitle}
          disabled={!chatEnabled}
          onClick={(e) => {
            e.stopPropagation()
            actions.current.reference(entry)
          }}
        >
          @
        </button>
      </span>
    </div>
  )
})

export function RemoteExplorer(props: { showHidden: boolean; onToggleHidden: () => void; visible: boolean }): ReactNode {
  const store = useExplorer()
  const { t, alias, root, repoRoot, marks } = store
  /** The host link is down: cached rows stay, new listings cannot load. */
  const connection = useConnectionStatus()
  const offline = connection?.state === 'error'
  const ctx = store.ctx
  const [listings, setListings] = useState<Record<string, RemoteFileEntry[]>>({})
  /**
   * The same listings, readable synchronously. `prefetchDir` has to answer "is
   * this already cached?" at pointer time, and a state value would be one render
   * behind (asking again for a directory that was just listed).
   */
  const listingsRef = useRef<Record<string, RemoteFileEntry[]>>({})
  /** Set false on unmount so a listing that lands late does not touch state. */
  const alive = useRef(true)
  /** Hover-intent timer for prefetch; one pointer means one candidate. */
  const prefetchTimer = useRef<number | undefined>(undefined)
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
  /** True while a remote WRITE batch is in flight (upload/paste/delete serialization). */
  const transferRef = useRef(false)
  /**
   * `expanded` readable SYNCHRONOUSLY by the window-capture drag listeners.
   *
   * Those listeners live outside React's tree and are re-attached per binding,
   * so reading the state value from inside them would be one render stale; the
   * spring-load decision ("is this directory already open?") has to answer for
   * the tree as the pointer sees it.
   */
  const expandedRef = useRef<Set<string>>(expanded)
  expandedRef.current = expanded
  /** The latest {@link springOpen}; the expander below is created once and reads through. */
  const springOpenRef = useRef<(dir: string) => void>(() => undefined)
  /**
   * Spring-loaded folders (see `drag-expand.ts`): one instance per mounted
   * panel. Both drag paths feed it — the row's own `onDragOver` (our rows =
   * move) and the window-capture `dragover` (OS files = upload) — because those
   * are two different event deliveries, not one.
   */
  const dragExpand = useRef<DragExpander | undefined>(undefined)
  if (dragExpand.current === undefined) {
    dragExpand.current = createDragExpander(
      (dir) => springOpenRef.current(dir),
      {
        set: (callback, ms) => window.setTimeout(callback, ms),
        clear: (handle) => window.clearTimeout(handle),
      },
    )
  }
  /** Last handled "show this folder" request id (see `shouldConsumeReveal`). */
  const lastRevealId = useRef(0)
  const menu = useContextMenu()

  const chatTarget = useRemoteChatTarget(store.ctx)
  const viewedAliasPath = store.workspace !== undefined ? store.aliasPaths[store.workspace.id] : undefined
  const chatEnabled = chatTarget.sessionId !== undefined
    && chatTarget.sessionWorkspacePath !== undefined
    && viewedAliasPath !== undefined
    && sameLocalDir(chatTarget.sessionWorkspacePath, viewedAliasPath)

  /**
   * The revision this component's listing traffic is labelled with.
   *
   * A ref, not a hook dependency: a revision bump must not re-create `loadDir`
   * (the reveal/refresh effects list it, and their identity churn would re-run
   * both). Only the request-time check in `ListingRequests` reads it. It is
   * written during render on purpose (an idempotent latest-value ref): an
   * effect-synced ref is one commit stale, so a read triggered from the same
   * commit as the write could still be labelled with the previous revision.
   */
  const revisionRef = useRef(store.revision)
  revisionRef.current = store.revision
  /** Current binding, for the late-answer guard below (the memo is per alias). */
  const aliasRef = useRef(alias)

  /**
   * The in-flight listing reads (see `ListingRequests`).
   *
   * A hover prefetch and the click that follows it are the same request, and so
   * are a double click and the reveal chain's level: without the shared map each
   * one opened its own SFTP listing for the same path. A request is only shared
   * when it started at the same revision, so a read AFTER a write never gets an
   * answer issued before it.
   */
  const listingsApi = useMemo(() => new ListingRequests(
    dir => dirKey(alias, dir),
    dir => api.fileOp.list(alias, dir),
    (key, entries) => {
      // A late answer must not paint after unmount, nor write the PREVIOUS
      // workspace's cache key after a binding change.
      if (alive.current && aliasRef.current === alias) setListings(prev => withListing(prev, key, entries))
    },
  ), [alias])

  /**
   * List one directory into the tree cache.
   *
   * @returns whether the listing landed. Callers that act on the RESULT (the
   *   spring-loaded expand, which has to collapse a directory it could not read)
   *   need it; the many refresh callers ignore it.
   */
  const loadDir = useCallback(async (dir: string, force = false, silent = false): Promise<boolean> => {
    if (alias === '') return false
    // While the link is down, a listing can only produce a 45 s SSH dial (and a
    // spinner over the "no cache" placeholder). Cached rows stay; recovery
    // re-lists through the revision bump, so skipping here loses nothing.
    if (offline) return false
    const key = dirKey(alias, dir)
    // NOTE: a cached listing is deliberately NOT reused as the only source. The
    // tree relies on every caller re-listing after a write (`force` = start a
    // fresh request instead of joining one that may predate the write); a
    // PREFETCHED listing is still on screen while the revalidation runs, which
    // is what makes the open feel instant without serving stale content as
    // final.
    setLoading(prev => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
    let listed = false
    try {
      await listingsApi.request(dir, revisionRef.current, force)
      listed = true
    } catch (error) {
      // A transport failure is already on the connection chip, and the cached
      // rows are still on screen: one toast per background refresh would repeat
      // the same story until the link is back. Business failures still speak —
      // except on a SILENT read (spring-loaded expand while the pointer rests
      // on a directory): that listing was never requested by a click, so a
      // toast would interrupt with an error the user cannot act on. The real
      // open of the same directory still explains itself.
      if (!silent && !isConnectionFailure(error)) toast(error instanceof Error ? error.message : String(error), true)
    } finally {
      setLoading(prev => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
    return listed
  }, [alias, listingsApi, offline])

  /**
   * Warm the listing cache for a directory the pointer is resting on.
   *
   * The open itself still revalidates through `loadDir` (the explorer must show
   * writes made elsewhere), but with the rows already in memory the expand
   * paints immediately instead of showing a loading line for one round trip.
   * Speculative by nature, so a failure is not a toast — the real listing, when
   * the user opens it, still explains itself.
   */
  const prefetchDir = useCallback((dir: string): void => {
    if (alias === '') return
    // A speculative read while the link is down is a real SSH dial for nothing.
    if (offline) return
    const key = dirKey(alias, dir)
    if (listingsRef.current[key] !== undefined) return
    if (listingsApi.busy(dir)) return
    listingsApi.request(dir, revisionRef.current).catch(() => undefined)
  }, [alias, listingsApi, offline])

  /** Hover intent: prefetch the row under the pointer after a short rest. */
  const hoverDir = (path: string | undefined): void => {
    if (prefetchTimer.current !== undefined) {
      window.clearTimeout(prefetchTimer.current)
      prefetchTimer.current = undefined
    }
    if (path === undefined) return
    prefetchTimer.current = window.setTimeout(() => {
      prefetchTimer.current = undefined
      prefetchDir(path)
    }, PREFETCH_HOVER_MS)
  }

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
    // Consume each request exactly once: this effect also re-runs when `root`
    // or `loadDir` change, and replaying an old request re-expanded the
    // previous workspace's chain and scrolled the tree away from the user.
    if (!shouldConsumeReveal(lastRevealId.current, request.id)) return
    lastRevealId.current = request.id
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
  /** Keep the late-answer guard current for the NEXT commit's callbacks. */
  useEffect(() => {
    aliasRef.current = alias
  }, [alias])
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
    // are fired concurrently; Host side they share the alias's browse SFTP
    // session, so a refresh of a deep tree no longer opens one channel per level.
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

  /** Keep the synchronous cache view in step (prefetch reads it at pointer time). */
  useEffect(() => {
    listingsRef.current = listings
  }, [listings])

  /** A hover prefetch / late listing must not fire or paint after the panel is gone. */
  useEffect(() => {
    // Re-armed on every effect run: a StrictMode/replay remount runs
    // setup → cleanup → setup, and an `alive` that only ever got set to false
    // would freeze every listing on the second pass.
    alive.current = true
    return () => {
      alive.current = false
      dragExpand.current?.reset()
      if (prefetchTimer.current !== undefined) window.clearTimeout(prefetchTimer.current)
    }
  }, [])

  /**
   * A binding change invalidates every drag candidate: `expanded` is re-keyed to
   * the new workspace, so a countdown armed on the old tree could open a path
   * that does not even exist on the host now bound.
   */
  useEffect(() => {
    dragExpand.current?.reset()
  }, [alias, root])

  /**
   * One directory's visible, sorted rows, cached for the life of one
   * `listings`/`showHidden`/`alias` combination.
   *
   * Sorting/filtering on every request was invisible for one directory and
   * wasteful for a deep tree (the flattened list asks for every expanded
   * directory on each rebuild); the cache also gives `buildVisibleRows` a stable
   * row-array identity, which is what lets the memoized rows be reused.
   */
  const rowsOf = useMemo(() => {
    const cache = new Map<string, RemoteFileEntry[] | undefined>()
    return (dir: string): RemoteFileEntry[] | undefined => {
      if (cache.has(dir)) return cache.get(dir)
      const rows = listings[dirKey(alias, dir)]
      let sorted: RemoteFileEntry[] | undefined
      if (rows !== undefined) {
        const visible = props.showHidden ? rows : rows.filter(entry => !entry.name.startsWith('.'))
        sorted = [...visible].sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
          return a.name.localeCompare(b.name)
        })
      }
      cache.set(dir, sorted)
      return sorted
    }
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

  /**
   * Spring-open one directory under a resting drag (see `drag-expand.ts`).
   *
   * The listing is read FORCE — a file is about to land in this directory, so a
   * cached listing could hide the very file the drop is about to clash with —
   * and SILENT, because a speculative read must not paint a failure toast the
   * user never asked for. Opening an already-open directory is a no-op: the
   * expander only arms on closed rows, and a second open would restart the
   * listing for nothing.
   *
   * A FAILED read collapses the directory again. Leaving it open would show an
   * empty folder (indistinguishable from a real empty one) and — worse — the
   * directory then sits in `expanded`, so every later revision bump re-lists it
   * WITHOUT the silent flag and repeats the same error toast on every write.
   */
  const springOpen = useCallback((dir: string): void => {
    if (dir === '' || offline) return
    setExpanded(prev => {
      if (prev.has(dir)) return prev
      const next = new Set(prev)
      next.add(dir)
      return next
    })
    void loadDir(dir, true, true).then((listed) => {
      if (listed) return
      // A concurrent NON-silent re-list (a revision bump, or the user opening
      // the same row) may have SUCCEEDED while this speculative read failed;
      // collapsing then would fold a directory the tree can actually show. Only
      // collapse while the cache still holds nothing for it.
      if (listingsRef.current[dirKey(alias, dir)] !== undefined) return
      setExpanded(prev => {
        if (!prev.has(dir)) return prev
        const next = new Set(prev)
        next.delete(dir)
        return next
      })
    })
  }, [alias, offline, loadDir])
  // Written during render on purpose: an idempotent latest-value ref, exactly
  // like `revisionRef` below. The expander outlives every render, so a captured
  // copy would call into a stale `offline`/`loadDir` pair.
  springOpenRef.current = springOpen

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

  /**
   * Drop one removed subtree from every path-keyed index.
   *
   * Wired into delete (all successful removals) and into cut-paste/drag-move
   * (the sources left their old paths). Without it the removed directories stay
   * in `expanded`, so the revision-bump refresh re-lists them over SFTP on every
   * later write (business error → toast each time), and their listing keys are
   * kept alive by `trimListings`' open-directory exemption forever.
   */
  const forgetPaths = useCallback((removed: readonly string[]): void => {
    if (removed.length === 0) return
    const gone = (path: string): boolean => removed.some(root => pathUnder(path, root))
    setExpanded(prev => withoutPaths(prev, removed))
    setSelected(prev => withoutPaths(prev, removed))
    setAnchor(prev => (prev !== undefined && gone(prev) ? undefined : prev))
    setListings(prev => withoutListingPaths(prev, alias, removed))
    setRenaming(prev => (prev !== undefined && gone(prev) ? undefined : prev))
    setCreating(prev => (prev !== undefined && gone(prev.dir) ? undefined : prev))
    setDropTarget(prev => (prev !== undefined && gone(prev) ? undefined : prev))
    // The focused row may be the one being removed. Clearing it here is what
    // lets the visibility effect below re-home the roving Tab stop to the first
    // remaining row instead of leaving EVERY row at tabIndex=-1.
    setFocusedPath(prev => (prev !== undefined && gone(prev) ? undefined : prev))
    setClipboard(prev => {
      if (prev === undefined) return prev
      const paths = prev.paths.filter(path => !gone(path))
      if (paths.length === prev.paths.length) return prev
      return paths.length === 0 ? undefined : { ...prev, paths }
    })
  }, [alias])

  /** Re-key every path-keyed index after a rename/move of `from` to `to`. */
  const movePathIndex = useCallback((from: string, to: string): void => {
    const moved = (path: string): string => (pathUnder(path, from) ? `${to}${path.slice(from.length)}` : path)
    setExpanded(prev => rekeyPaths(prev, from, to))
    setSelected(prev => rekeyPaths(prev, from, to))
    setAnchor(prev => (prev === undefined ? undefined : moved(prev)))
    setListings(prev => rekeyListings(prev, alias, from, to))
    setRenaming(prev => (prev === undefined ? undefined : moved(prev)))
    setCreating(prev => (prev === undefined ? undefined : { ...prev, dir: moved(prev.dir) }))
    // A rename/move must carry the Tab stop with the row it belongs to.
    setFocusedPath(prev => (prev === undefined ? undefined : moved(prev)))
  }, [alias])

  const doCreate = async (name: string): Promise<void> => {
    // Remote writes are serialized: an upload in flight owns the single
    // abort slot, so no second write batch may start beside it.
    if (!writeAllowed(transferRef.current)) {
      toast(t('files.transferBusy'), true)
      return
    }
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
    // Remote writes are serialized: an upload in flight owns the single
    // abort slot, so no second write batch may start beside it.
    if (!writeAllowed(transferRef.current)) {
      toast(t('files.transferBusy'), true)
      return
    }
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
      movePathIndex(entry.path, target)
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
    // Remote writes are serialized: an upload in flight owns the single
    // abort slot, so no second write batch may start beside it.
    if (!writeAllowed(transferRef.current)) {
      toast(t('files.transferBusy'), true)
      return
    }
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
    /** Entries that really disappeared on the remote — their subtree is pruned. */
    const removed: string[] = []
    for (const entry of entries) {
      try {
        await api.fileOp.rm(alias, entry.path, entry.isDir)
        removed.push(entry.path)
      } catch (error) {
        failed.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    setBusy(false)
    // Drop the removed subtrees from `expanded`/`selected`/`listings` BEFORE any
    // refresh: `store.afterWrite()` bumps the revision, and the root effect
    // re-lists every expanded directory — the deleted ones would each answer
    // with a business error and a toast, on every write for the rest of the
    // session.
    forgetPaths(removed)
    await refreshDirs([...new Set(entries.map(entry => entry.path.split('/').slice(0, -1).join('/') || '/'))])
    await store.afterWrite()
    if (failed.length > 0) toast(failed.join('\n'), true)
    else toast(t('files.deleted'))
  }

  const doPaste = async (intoDir: string): Promise<void> => {
    const clip = clipboard
    if (clip === undefined || clip.paths.length === 0) return
    // Remote writes are serialized: an upload in flight owns the single
    // abort slot, so no second write batch may start beside it.
    if (!writeAllowed(transferRef.current)) {
      toast(t('files.transferBusy'), true)
      return
    }
    setBusy(true)
    const failed: string[] = []
    /** Cut sources that really moved: their path-indexed state follows them. */
    const moved: Array<{ from: string; to: string }> = []
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
        else if (clip.mode === 'cut') moved.push({ from: source, to: destinationOfMove(intoDir, source) })
      } catch (error) {
        failed.push(`${baseName(source)}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    setBusy(false)
    // A moved source no longer exists at its old path: re-key (rather than drop)
    // its expanded/selected/listing state, exactly like a rename.
    for (const source of moved) movePathIndex(source.from, source.to)
    if (clip.mode === 'cut') setClipboard(undefined)
    await refreshDirs([intoDir, baseDirFor()])
    await store.afterWrite()
    if (failed.length > 0) toast(failed.join('\n'), true)
    else toast(clip.mode === 'copy' ? t('files.copied') : t('files.moved'))
  }

  const doDrop = async (intoDir: string, event: React.DragEvent): Promise<void> => {
    event.preventDefault()
    // Remote writes are serialized: an upload in flight owns the single
    // abort slot, so no second write batch may start beside it.
    if (!writeAllowed(transferRef.current)) {
      toast(t('files.transferBusy'), true)
      return
    }
    setDropTarget(undefined)
    const sources = dragPaths.current
    dragPaths.current = []
    if (sources.length === 0) return
    setBusy(true)
    const failed: string[] = []
    const moved: Array<{ from: string; to: string }> = []
    for (const source of sources) {
      if (source === intoDir || intoDir.startsWith(`${source}/`)) {
        failed.push(`${baseName(source)}: ${t('files.moveIntoSelf')}`)
        continue
      }
      if (source.split('/').slice(0, -1).join('/') === intoDir) continue
      try {
        const result = await api.exec(alias, moveToCommand(source, intoDir), 60_000)
        if (!result.success) failed.push(`${baseName(source)}: ${result.stderr.trim() || t('files.pasteFailed')}`)
        else moved.push({ from: source, to: destinationOfMove(intoDir, source) })
      } catch (error) {
        failed.push(`${baseName(source)}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    setBusy(false)
    for (const source of moved) movePathIndex(source.from, source.to)
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
    // One write batch at a time: a second upload would overwrite the single
    // `uploadAbort` slot (the first then cannot be cancelled) and the two
    // progress bars would fight over one state object.
    if (!writeAllowed(transferRef.current)) {
      toast(t('files.transferBusy'), true)
      return
    }
    transferRef.current = true
    /**
     * The plan runs BEFORE the transfer's own try/finally, so a throw here used
     * to leave the write lock ON: `transferRef` stayed true and the upload bar
     * stayed up, which disables every write entry (new file/folder, upload,
     * paste, and DELETE) with nothing on screen explaining why — and it stayed
     * that way until the page was reloaded. Release the lock on the way out so a
     * bad batch is a toast, not a permanently greyed-out menu.
     */
    let plan: ReturnType<typeof withDroppedDirs>
    try {
      plan = withDroppedDirs(planUpload(entries), extraDirs)
    } catch (error) {
      uploadAbort.current = undefined
      transferRef.current = false
      setUpload(undefined)
      setBusy(false)
      toast(error instanceof Error ? error.message : String(error), true)
      return
    }
    dropLog('plan', { files: plan.files.length, dirs: plan.dirs.length, skipped: plan.skipped.length })
    if (plan.files.length === 0 && plan.dirs.length === 0) {
      if (plan.skipped.length > 0) toast(t('files.uploadSkipped'), true)
      transferRef.current = false
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
        transferRef.current = false
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
      transferRef.current = false
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
    // Remote writes are serialized: an upload in flight owns the single
    // abort slot, so no second write batch may start beside it.
    if (!writeAllowed(transferRef.current)) {
      toast(t('files.transferBusy'), true)
      return
    }
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
    /**
     * The DIRECTORY row under the pointer, or undefined.
     *
     * Same hit stack as `dropDirFromEvent` (the shell paints a full-screen
     * "drop here" overlay during a file drag, so `event.target` is that
     * overlay, never the row), but this one answers "which closed directory is
     * the pointer resting on" for spring-loading. A FILE row answers undefined:
     * a drop there lands in its parent directory, which is already open.
     */
    const hoverDirOf = (event: DragEvent): string | undefined => {
      const point = pointerOf(event)
      if (point === undefined) return undefined
      for (const element of document.elementsFromPoint(point.x, point.y)) {
        const row = element.closest('[data-rvs-path]')
        if (row === null) continue
        const path = row.getAttribute('data-rvs-path') ?? ''
        if (path === '') continue
        return row.getAttribute('data-rvs-dir') === '1' ? path : undefined
      }
      return undefined
    }
    /**
     * Feed the spring-load expander from an OS-file drag.
     *
     * `dragover` fires continuously while the pointer rests, which is exactly
     * the signal the expander wants: it ignores a repeat for the row already
     * counting down and only restarts when the pointer moves to another row.
     * RESET rather than `leave` on a file row or the pane background: the
     * pointer left the candidate and there is no path to name it by here.
     */
    const trackHover = (event: DragEvent): void => {
      const dir = hoverDirOf(event)
      if (dir !== undefined && !expandedRef.current.has(dir)) dragExpand.current?.hover(dir)
      else dragExpand.current?.reset()
    }
    const onDragEnter = (event: DragEvent): void => {
      if (!isFileDrag(event.dataTransfer) || !overPane(event)) return
      claim(event)
      setDropTarget(root)
      setDropHint(root)
      trackHover(event)
    }
    const onDragOver = (event: DragEvent): void => {
      if (!isFileDrag(event.dataTransfer) || !overPane(event)) return
      claim(event)
      setDropTarget(root)
      setDropHint(root)
      trackHover(event)
    }
    const onDrop = (event: DragEvent): void => {
      // The gesture is over whichever way it ends: no spring-load may fire
      // after the drop it was preparing for.
      dragExpand.current?.reset()
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
      // Two different events share this name, and only the first is a leave:
      //  - the pointer moved to another element (relatedTarget is set). The
      //    shell's drag overlay fires these for unrelated targets and they used
      //    to clear the hint mid-drag, so they are ignored.
      //  - the drag ENDED without a drop (Esc, or a drop refused elsewhere)
      //    while the pointer is still inside the pane: overPane() is true and
      //    relatedTarget is null. A drag that started in ANOTHER document (the
      //    OS file manager) never sends `dragend` here — its source node is not
      //    in this document — so this is the ONLY event that can end that
      //    gesture, and it must clear the countdown (otherwise the folder opens
      //    650 ms after the user cancelled).
      if (overPane(event) && event.relatedTarget !== null) return
      dragExpand.current?.reset()
      setDropTarget(undefined)
      setDropHint(undefined)
    }
    /**
     * The end of a drag whose SOURCE is in this document (our tree rows): a
     * drop, Esc, or a drop outside the pane. OS-file drags end in
     * `onDragLeave` instead (see there). Clearing `dragPaths` matters because a
     * cancelled move leaves the old selection in it, and the next drag would
     * then treat a stale row as its move source.
     */
    const onDragEnd = (): void => {
      dragExpand.current?.reset()
      dragPaths.current = []
      setDropTarget(undefined)
      setDropHint(undefined)
    }
    window.addEventListener('dragenter', onDragEnter, true)
    window.addEventListener('dragover', onDragOver, true)
    window.addEventListener('drop', onDrop, true)
    window.addEventListener('dragleave', onDragLeave, true)
    window.addEventListener('dragend', onDragEnd, true)
    return () => {
      dragExpand.current?.reset()
      window.removeEventListener('dragenter', onDragEnter, true)
      window.removeEventListener('dragover', onDragOver, true)
      window.removeEventListener('drop', onDrop, true)
      window.removeEventListener('dragleave', onDragLeave, true)
      window.removeEventListener('dragend', onDragEnd, true)
    }
    // `uploadFromDataTransfer` closes over the current alias/root/plan state, so
    // the listeners are re-attached whenever that identity would change.
  }, [root, alias, uploadFromDataTransfer])

  // ------------------------------------------------------------- download

  /**
   * Download one remote file, or one directory as a `.tar.gz`.
   *
   * Everything after the click (stat preflight, save dialog, progress, cancel,
   * completion/failure) lives in `downloads.ts`, so the transfer keeps running
   * when this panel is hidden or unmounted.
   */
  const downloadEntry = (entry: RemoteFileEntry): void => {
    startDownload(alias, entry.path, { name: entry.name, directory: entry.isDir })
  }

  // ---------------------------------------------------------- context menu

  /**
   * Begin inline creation in `dir`.
   *
   * The create row is rendered only under an EXPANDED directory (the flat row
   * builder walks expanded nodes), so asking for "New file" on a collapsed
   * folder used to set state nobody could see — the menu looked dead until the
   * user expanded it by hand. Expand (and list) the target first.
   */
  const startCreate = useCallback((dir: string, kind: 'file' | 'folder'): void => {
    if (dir !== '' && dir !== root && !expanded.has(dir)) {
      setExpanded(prev => new Set(prev).add(dir))
      void loadDir(dir)
    }
    setCreating({ dir, kind })
  }, [root, expanded, loadDir])

  const openMenu = (event: React.MouseEvent, entry: RemoteFileEntry | undefined): void => {
    event.preventDefault()
    event.stopPropagation()
    /** One write batch at a time (see `writeEntriesDisabled`). */
    const transferBusy = writeEntriesDisabled(upload !== undefined)
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
      { label: t('files.newFile'), onSelect: () => startCreate(dir, 'file'), disabled: transferBusy },
      { label: t('files.newFolder'), onSelect: () => startCreate(dir, 'folder'), disabled: transferBusy },
      {
        label: t('files.uploadFile'),
        onSelect: () => {
          uploadInto.current = dir
          filePicker.current?.click()
        },
        disabled: transferBusy,
      },
      {
        label: t('files.uploadFolder'),
        onSelect: () => {
          uploadInto.current = dir
          folderPickerHandle.current?.click()
        },
        disabled: transferBusy,
      },
      {
        label: t('files.pasteHere'),
        onSelect: () => { void doPaste(dir) },
        disabled: clipboard === undefined || transferBusy,
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
        disabled: transferBusy,
      })
      entries.push({ label: t('files.copyRel'), onSelect: () => { void copyText(targets.map(item => repoRelative(repoRoot, item.path) || item.path).join('\n')); toast(t('files.copiedClipboard')) }, separated: true })
      entries.push({ label: t('files.copyAbs'), onSelect: () => { void copyText(targets.map(item => item.path).join('\n')); toast(t('files.copiedClipboard')) } })
      entries.push({
        label: t('files.download') + (targets.length > 1 ? ` (${targets.length})` : ''),
        onSelect: () => {
          if (targets.length === 1) {
            downloadEntry(entry)
            return
          }
          if (targets.length > MAX_SELECTION_DOWNLOAD) {
            toast(t('downloads.tooMany'), true)
            return
          }
          // One archive for the whole selection: the user answers ONE save
          // dialog instead of one per entry, and mixed files/directories work.
          startSelectionDownload(alias, targets.map(item => item.path))
        },
      })
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

  /** The right-click menu's `contextmenu` fallback (touch long-press only). */
  const onRowContextMenu = (e: React.MouseEvent, entry: RemoteFileEntry): void => {
    e.preventDefault()
    if (menu.menu === undefined) openMenu(e, entry)
  }

  /**
   * Keyboard focus (roving tabindex).
   *
   * The rows are leaf `memo` components, so moving focus is an index walk over
   * the flat visible rows plus a DOM lookup by `data-rvs-path`: before this the
   * tree had no keyboard path at all (no focusable row, no arrow/Enter/Esc
   * handling), which made the explorer unusable without a pointer.
   */
  const [focusedPath, setFocusedPath] = useState<string | undefined>(undefined)
  const visibleRowsRef = useRef<ExplorerRow[]>([])
  const focusRow = (path: string | undefined): void => {
    // `undefined` means an arrow key hit an edge: keep the current stop instead
    // of blanking it (the visibility effect only re-homes a path that stopped
    // existing — a no-op move must not cost the tree its Tab stop).
    if (path === undefined) return
    setFocusedPath(path)
    requestAnimationFrame(() => {
      const row = Array.from(document.querySelectorAll<HTMLElement>('[data-rvs-path]'))
        .find(candidate => candidate.dataset.rvsPath === path)
      row?.focus()
    })
  }
  const onRowKeyDown = (entry: RemoteFileEntry, event: React.KeyboardEvent): void => {
    const rows = visibleRowsRef.current
    const key = event.key
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault()
      focusRow(rowKeyboardTarget(rows, entry.path, key === 'ArrowDown' ? 'down' : 'up'))
      return
    }
    if (key === 'ArrowRight' && entry.isDir) {
      event.preventDefault()
      if (!expanded.has(entry.path)) {
        toggleDir(entry)
        focusRow(entry.path)
        return
      }
      focusRow(rowKeyboardTarget(rows, entry.path, 'child') ?? entry.path)
      return
    }
    if (key === 'ArrowLeft') {
      event.preventDefault()
      if (entry.isDir && expanded.has(entry.path)) {
        toggleDir(entry)
        focusRow(entry.path)
        return
      }
      focusRow(rowKeyboardTarget(rows, entry.path, 'parent') ?? entry.path)
      return
    }
    if (key === 'Enter') {
      event.preventDefault()
      openEntry(entry)
      return
    }
    if (key === ' ' || key === 'Spacebar') {
      event.preventDefault()
      setSelected(new Set([entry.path]))
      setAnchor(entry.path)
      return
    }
    if (key === 'Home' || key === 'End') {
      event.preventDefault()
      const entries = rows.filter(row => row.kind === 'entry')
      const target = key === 'Home' ? entries[0] : entries[entries.length - 1]
      if (target !== undefined) focusRow(target.entry.path)
      return
    }
    if ((key === 'F10' && event.shiftKey) || key === 'ContextMenu') {
      event.preventDefault()
      const row = Array.from(document.querySelectorAll<HTMLElement>('[data-rvs-path]'))
        .find(candidate => candidate.dataset.rvsPath === entry.path)
      const rect = row?.getBoundingClientRect()
      openMenu({
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
        clientX: rect === undefined ? 0 : rect.left,
        clientY: rect === undefined ? 0 : rect.bottom,
      } as unknown as React.MouseEvent, entry)
    }
  }

  /**
   * Live row handlers, read through a ref.
   *
   * The rows are `memo`ized on primitive props; handing them a new callback
   * object every render would invalidate every row on every parent render,
   * which is exactly the cost this file is trying to avoid.
   */
  const rowActions = useRef<ExplorerRowActions>({
    select: () => undefined,
    openFile: () => undefined,
    hoverDir: () => undefined,
    openMenu: () => undefined,
    contextMenu: () => undefined,
    startDrag: () => undefined,
    dragOver: () => undefined,
    dragLeave: () => undefined,
    dropOn: () => undefined,
    commitRename: () => undefined,
    cancelRename: () => undefined,
    reference: () => undefined,
    keyDown: () => undefined,
    focusPath: () => undefined,
  })
  rowActions.current = {
    select: selectRow,
    openFile: (entry) => {
      // The row passes the WHOLE entry: a directory must not reach
      // `store.openFile` (it has no type guard, so the Host would answer
      // "not a file" and the editor surface would be switched for nothing).
      const target = rowOpenTarget(entry)
      if (target !== undefined) store.openFile(target)
    },
    hoverDir,
    openMenu,
    contextMenu: onRowContextMenu,
    startDrag: (entry) => {
      dragPaths.current = selected.has(entry.path) ? [...selected] : [entry.path]
    },
    dragOver: (entry, e) => {
      // An OS file drag targets this row's DIRECTORY: a drop on a file row
      // means "put it beside that file" (what the user means when they aim at a
      // file in the list). The real handling of an OS drag lives in the
      // window-capture listener below; this branch keeps React's own path sane.
      if (isFileDrag(e.dataTransfer)) {
        e.preventDefault()
        e.stopPropagation()
        setDropTarget(entry.path)
        setDropHint(entry.isDir ? entry.path : (entry.path.split('/').slice(0, -1).join('/') || '/'))
        return
      }
      const source = dragPaths.current[0]
      // `text/plain` is what our own `onDragStart` sets (`ExplorerRowView`) and
      // what a DOM drag of a row therefore carries. Requiring it keeps a stale
      // source — left behind by a cancelled move before `onDragEnd` clears it —
      // from turning an unrelated text drag over the tree into a "move" target.
      const legalTarget = entry.isDir
        && source !== undefined
        && e.dataTransfer !== null
        && [...e.dataTransfer.types].includes('text/plain')
        && entry.path !== source
        && !entry.path.startsWith(`${source}/`)
      if (legalTarget) {
        e.preventDefault()
        setDropTarget(entry.path)
        // Spring-loaded folders: a CLOSED directory under a resting drag opens
        // after the delay; an already-open one has nothing left to reveal.
        if (expanded.has(entry.path)) dragExpand.current?.reset()
        else dragExpand.current?.hover(entry.path)
        return
      }
      // Any other row disarms the countdown: the pointer is not resting on a
      // directory it could open (a move into itself is refused above too).
      dragExpand.current?.reset()
    },
    dragLeave: (entry) => {
      dragExpand.current?.leave(entry.path)
      setDropTarget(current => (current === entry.path ? undefined : current))
    },
    dropOn: (entry, e) => {
      // The drop is the end of the gesture even when it is refused: never let
      // the countdown open a folder after its own drop landed.
      dragExpand.current?.reset()
      if (isFileDrag(e.dataTransfer)) {
        const into = entry.isDir ? entry.path : (entry.path.split('/').slice(0, -1).join('/') || '/')
        handleDrop(into, e)
        return
      }
      if (entry.isDir) void doDrop(entry.path, e)
    },
    commitRename: (entry, name) => { void doRename(entry, name) },
    cancelRename: () => setRenaming(undefined),
    reference: (entry) => {
      if (chatTarget.sessionId === undefined) return
      insertRemoteReference(ctx, chatTarget.sessionId, repoRoot ?? root, entry.path, entry.isDir)
    },
    keyDown: onRowKeyDown,
    focusPath: (path) => { setFocusedPath(path) },
  }

  /**
   * The loaded tree as a flat pre-order list.
   *
   * Rebuilt only when the shape of the tree can have changed (a listing, an
   * expansion, the create row, a binding) — not on selection, upload progress or
   * a store publish. The memoized rows then skip the re-render themselves.
   */
  const visibleRows = useMemo(() => buildVisibleRows({
    root,
    rowsOf,
    isExpanded: path => expanded.has(path),
    ...(creating === undefined ? {} : { creating }),
    // A cold/or offline directory that was just expanded must say so IN PLACE
    // (the root's own placeholder below only covers the workspace root).
    placeholderOf: (dir) => (offline ? 'offline' : loading.has(dirKey(alias, dir)) ? 'loading' : undefined),
  }), [root, rowsOf, expanded, creating, offline, loading, alias])
  // Keyboard navigation reads the current flat list synchronously.
  visibleRowsRef.current = visibleRows

  /**
   * Keep a Tab stop on screen.
   *
   * The roving tabindex puts `tabIndex=0` only on `focusedPath`'s row. Deleting
   * that row, renaming it, collapsing its parent or switching bindings used to
   * leave every row at -1: the tree stayed visible but keyboard users could no
   * longer Tab into it (the pointer was the only way back). Re-home the path to
   * the first remaining row; an empty tree keeps `undefined`.
   */
  useEffect(() => {
    const next = nextFocusPath(visibleRows, focusedPath)
    if (next === focusedPath) return
    setFocusedPath(next)
    if (next === undefined) return
    // Do not yank DOM focus while the user is typing elsewhere; this only
    // restores the roving stop (the row is focusable again).
  }, [visibleRows, focusedPath])

  const renderDir = (dir: string, depth: number): ReactNode => {
    const rows = rowsOf(dir)
    const key = dirKey(alias, dir)
    if (rows === undefined && offline) {
      // Checked BEFORE the loading line: a request that was already in flight
      // when the link dropped would otherwise show "loading" for its own
      // deadline and hide the honest answer.
      return <div className="rvs-empty" style={{ paddingLeft: 12 + depth * 14 }}>{t('files.offline')}</div>
    }
    if (rows === undefined && loading.has(key)) {
      return <div className="rvs-empty" style={{ paddingLeft: 12 + depth * 14 }}>{t('common.loading')}</div>
    }
    // Per-render constants, not per-row ones: the strings and the clipboard set
    // are identical for every row, and computing them inside the map is real
    // work when the tree has tens of thousands of rows.
    const referenceTitle = chatEnabled ? t('files.referenceFile') : t('files.refDisabled')
    const symlinkTitle = t('files.symlink')
    const cutPaths = clipboard !== undefined && clipboard.mode === 'cut' ? new Set(clipboard.paths) : undefined
    return (
      <>
        {visibleRows.map(row => {
          if (row.kind === 'create') {
            return (
              <CreateRow
                key={`create:${row.dir}`}
                depth={row.depth}
                kind={row.createKind}
                onCommit={(value) => { void doCreate(value) }}
                onCancel={() => setCreating(undefined)}
                // 16 px to match the tree rows and the local sidebar's tree, and
                // a nameless sheet for the file: the row has no path yet, so
                // claiming a type (the old hard-coded `name.ts`) would paint
                // every "new file" row TS-blue.
                fileIcon={<ExplorerFileIcon path="untitled" size={16} />}
                folderIcon={<ExplorerFolderIcon path="name" open={false} size={16} />}
                t={t}
              />
            )
          }
          if (row.kind === 'pending') {
            // Same copy/order as the root placeholder (offline before loading).
            return (
              <div key={`pending:${row.dir}`} className="rvs-empty" style={{ paddingLeft: 12 + row.depth * 14 }}>
                {row.reason === 'offline' ? t('files.offline') : t('common.loading')}
              </div>
            )
          }
          return (
            <ExplorerRowView
              key={row.entry.path}
              entry={row.entry}
              depth={row.depth}
              status={statusFor(row.entry)}
              ignored={ignoredFor(row.entry)}
              isSelected={selected.has(row.entry.path)}
              isOpen={expanded.has(row.entry.path)}
              isCut={cutPaths !== undefined && cutPaths.has(row.entry.path)}
              isDropTarget={dropTarget === row.entry.path}
              isRenaming={renaming === row.entry.path}
              isFocused={focusedPath === row.entry.path}
              chatEnabled={chatEnabled}
              referenceTitle={referenceTitle}
              symlinkTitle={symlinkTitle}
              actions={rowActions}
            />
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
        <IconButton title={t('files.newFile')} onClick={() => startCreate(root, 'file')} disabled={upload !== undefined}>
          <IconPlus size={14} />
        </IconButton>
        <IconButton title={t('files.newFolder')} onClick={() => startCreate(root, 'folder')} disabled={upload !== undefined}>
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
          if (!writeAllowed(transferRef.current)) return
          const dir = uploadInto.current || root
          const blobs = new Map<string, Blob>(picked.map(file => [file.name, file]))
          // A rejection here would be an unhandled one (this is not the drop
          // path, which does catch): the picker must report its failure the same
          // way the drop does.
          void runUpload(dir, picked.map(file => ({ rel: file.name, size: file.size })), blobs, [])
            .catch((error: unknown) => { toast(error instanceof Error ? error.message : String(error), true) })
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
          if (!writeAllowed(transferRef.current)) return
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
        // The empty area BELOW the tree belongs to the scroll box, not to
        // .rvs-tree, so a right-click there used to open the browser's own
        // menu: the explorer's background actions were unreachable.
        onPointerDown={(e) => { if (e.button === 2 && e.target === e.currentTarget) openMenu(e, undefined) }}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return
          e.preventDefault()
          if (menu.menu === undefined) openMenu(e, undefined)
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
        <div
          className="rvs-tree"
          role="tree"
          aria-label={t('tab.files')}
          aria-multiselectable="true"
          onPointerDown={(e) => { if (e.button === 2) openMenu(e, undefined) }}
          onContextMenu={(e) => {
            e.preventDefault()
            if (menu.menu === undefined) openMenu(e, undefined)
          }}
        >
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
