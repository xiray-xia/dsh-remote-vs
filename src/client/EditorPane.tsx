/**
 * The editor area: one tab strip for code files, previews and diffs, an info
 * row, the body, and (in the full-width conversation-view variant) a status bar.
 *
 * The chrome follows the local sidebar plugin's editor (same tab strip, info
 * row, empty states, status bar, image preview and editor background tokens),
 * while every remote-only capability stays exactly where it was: the remote
 * read/write routes, the save-conflict banner and its on-demand difference, the
 * diff tabs, markdown/HTML previews, session change marks and the offline
 * read-only degradation.
 *
 * Three variants share this component, chosen from the store's effective
 * surface — never from a prop, so a surface can never mount two live buffers:
 *  - `sidebar`: the docked pane — a FULL-COLUMN rail page and the default seat
 *    (opening a file switches the rail to it; closing the last file switches
 *    back to the directory);
 *  - `center`: the conversation-view tab next to 对话 / 轨迹 (optional, full
 *    width, breadcrumb + status bar);
 *  - `float`: the frame-wide floating window (its own font zoom applies).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { api, fileReadTimeoutMs } from './api.ts'
import { clientDeadlineFor } from '../timeouts.ts'
import { diffText, type TextHunk } from '../changes/text-diff.ts'
import { CodeEditor, type CodeEditorCaret, type CodeEditorHandle, type CodeEditorViewState } from './CodeEditor.tsx'
import { ConnectionStatusChip } from './ConnectionStatus.tsx'
import { isConnectionFailure, useConnectionStatus } from './connection.ts'
import { sameLocalDir } from './composer.ts'
import { editorViewStateOf, pruneEditorViewStates, registerLiveEditor, rememberEditorViewState } from './live-editor.ts'
import { useRemoteChatTarget } from './use-remote-chat-target.ts'
import { useExplorer, gotoChange, markChangeStale, repoRelative, undoChange, type EditorTab } from './store.tsx'
import { blockIdForMark, isStoredBlockConfirmed, toggleStoredBlock, type ConfirmStorage } from './changes/block-confirm.ts'
import { changeOriginForTab } from './changes/undo-target.ts'
import type { ChangeMark } from './vsc/change-marks.ts'
import { DiffView } from './scm/DiffView.tsx'
import { loadBlame, loadFileHistory } from './scm/actions.ts'
import { isCommittedBlame, planBlameWindow, type BlameLine, type FileHistoryCommit } from './blame-model.ts'
import { Btn } from './ui.tsx'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { langLabel, langFromPath } from './vsc/tokenize.ts'
import { FOREIGN_TARGET, installSaveShortcut, isModalLayerOpen } from './vsc/save-shortcut.ts'
import { OutlinePanel } from './OutlinePanel.tsx'
import type { OutlineEntry } from './outline-model.ts'
import { Breadcrumb } from './vsc/breadcrumb.tsx'
import { ImagePreview } from './vsc/image-preview.tsx'
import { hasTextSource, isBytePreview, previewKindLabel, previewKindOf, type PreviewKind } from './vsc/preview-model.ts'
import { BytePreview, SvgPreview, TablePreview } from './vsc/preview-document.tsx'
import { isDarkScheme, subscribeColorScheme } from './theme.ts'
import {
  editorSettingsSnapshot,
  stepFontSize,
  subscribeEditorSettings,
  updateEditorSettings,
  type EditorSettings,
} from './vsc/editor-settings.ts'
import { detectIndentLabel } from './vsc/editor-langs.ts'
import {
  IconButton,
  IconClose,
  IconCode,
  IconCollapse,
  IconDiff,
  IconExpand,
  IconFloat,
  IconRefresh,
  IconSave,
  IconWrap,
  MiniSpinner,
  Segmented,
  baseName,
  confirmDialog,
  mimeFor,
  toast,
} from './vsc/kit.tsx'

/** How many hunks of a conflict diff are rendered before the rest is summarised. */
const CONFLICT_DIFF_HUNKS = 20

/**
 * 「大纲」是否可用：一个真正的文本文件 tab，读完且没读错，不是二进制/图片。
 *
 * 预览模式（markdown/HTML）也排除：那时 CodeMirror 被 CSS 隐藏，跳过去虽然改了
 * 选区，屏幕上却什么也看不到 —— 一个看起来没反应的按钮比没有按钮更糟。
 */
function outlineAvailable(tab: EditorTab | undefined): tab is EditorTab {
  if (tab === undefined || tab.kind !== 'file') return false
  if (tab.image || tab.binary || tab.loading || tab.error !== undefined) return false
  return !(tab.preview && hasTextSource(previewKindOf(tab.fullPath)))
}

const BLAME_PREF_KEY = 'dsh-remote-vs.editor.blame'
const EMPTY_BLAME: ReadonlyMap<number, BlameLine> = new Map()

/** Inline blame is OFF by default; the user opts in and the choice survives a reload. */
function readBlamePreference(): boolean {
  try {
    return localStorage.getItem(BLAME_PREF_KEY) === '1'
  } catch {
    return false
  }
}

function writeBlamePreference(value: boolean): void {
  try {
    localStorage.setItem(BLAME_PREF_KEY, value ? '1' : '0')
  } catch {
    // Private mode: the preference simply does not persist.
  }
}

/** Number of lines a loaded buffer has (the last empty line still counts). */
function lineCountOf(text: string): number {
  if (text === '') return 1
  let count = 1
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1
  }
  return count
}

/**
 * Reject a remote call that never answers.
 *
 * The host route has its own caps, but a stuck TCP/SSH round trip would
 * otherwise leave the conflict-difference button spinning forever with no way to
 * tell what happened. Same rule (and same shape) the store uses for its reads.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} (${Math.round(ms / 1000)}s)`)), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** "the remote file changed at …, N bytes" — or that it is gone entirely. */
function conflictVersion(t: (key: string) => string, conflict: { mtime: number | null; size: number | null }): string {
  if (conflict.mtime === null) return t('editor.conflictDeleted')
  const base = t('editor.conflictBody').replace('{time}', new Date(conflict.mtime).toLocaleString())
  return conflict.size === null ? base : `${base} · ${conflict.size} B`
}

/**
 * The note above a conflict diff.
 *
 * An EMPTY hunk list has two very different causes — the contents are identical
 * (only the timestamp moved) or the remote read failed — and rendering neither
 * one leaves the user staring at a blank box that reads as "no differences".
 */
function conflictDiffNote(t: (key: string) => string, payload: { error?: string; hunks: TextHunk[] }): string {
  if (payload.error !== undefined) return payload.error
  if (payload.hunks.length === 0) return t('editor.conflictSame')
  return t('editor.conflictDiffHead')
}

/** Which i18n key describes the tab's save state. */
function tabStatusKey(tab: { loading: boolean; saving: boolean; dirty: boolean }): string {
  if (tab.loading) return 'common.loading'
  if (tab.saving) return 'editor.saving'
  if (tab.dirty) return 'editor.unsaved'
  return 'editor.saved'
}

/** Which `rvs-status` modifier the save state uses. */
function tabStatusClass(tab: { loading: boolean; saving: boolean; dirty: boolean }): string {
  if (tab.loading || tab.saving) return 'saving'
  return tab.dirty ? 'dirty' : 'saved'
}

/**
 * 悬浮撤销按钮的文案。
 *
 * 删除锚点那一行其实已经不在文件里了，说「撤销这处改动」会让人以为要改一行现存的内容，
 * 所以它有自己的说法。措辞留在 i18n 里、由这里选 key：`undo-affordance` 只负责把
 * `kind` 交出来，扩展本身不写文案。两条 key 都是字面量调用，`i18n-check` 才能把
 * "字典里有、没人用" 也查出来（拼在模板串里或走运行时查表就查不到）。
 */
function undoActionLabel(t: (key: string) => string, kind: 'add' | 'mod' | 'del'): string {
  return kind === 'del' ? t('changes.undoActionDelete') : t('changes.undoAction')
}

/** Tab icon: diffs, images and text files each get their own glyph. */
function tabIcon(tab: { kind: string; image: boolean }): ReactNode {
  if (tab.kind === 'diff') return <IconDiff size={11} />
  if (tab.image) return <span>▣</span>
  return <span>▪</span>
}

/**
 * The React `key` of one code editor — the tab's identity PLUS its reload nonce.
 *
 * `CodeEditor` reads `initial` exactly ONCE (on mount), so a re-read of the
 * remote file can only reach the live buffer by remounting it. `store.reloadTab`
 * bumps the nonce after it stores the new text, which turns "new bytes arrived"
 * into a key change instead of a dead prop update: without it the mounted
 * buffer kept showing the pre-reload content while the file on disk had the new
 * one, and the next Ctrl+S wrote the stale bytes back over the file.
 *
 * Exported so a self-check can assert the key really moves (and that it moves
 * only when a reload happened).
 */
export function editorKey(tab: { id: string; reloadNonce?: number }): string {
  return `${tab.id}:${tab.reloadNonce ?? 0}`
}

/** How many decoded images stay cached; each entry is a whole file. */
const IMAGE_CACHE_KEEP = 4
/**
 * One image larger than this is displayed but never retained: the read route
 * allows 8 MiB, which is ~11 MB of base64 parked in the page, and a picture
 * that big is not worth the second that re-reading it costs.
 */
const IMAGE_CACHE_MAX_URL = 2 * 1024 * 1024

/**
 * Insert one entry as the newest, then drop the oldest past the cap.
 *
 * The image tables were the only thing in this pane that grew with the number
 * of pictures looked at and never gave anything back: the pane stays mounted
 * for the life of the page, so every image ever previewed kept its data URL.
 */
function rememberRecent(prev: Record<string, string>, path: string, value: string): Record<string, string> {
  const next: Record<string, string> = {}
  // Re-inserting has to MOVE an existing key to the end: object key order is
  // insertion order, and the keys the cap drops are the first ones.
  for (const [key, item] of Object.entries(prev)) {
    if (key !== path) next[key] = item
  }
  next[path] = value
  const keys = Object.keys(next)
  for (const key of keys.slice(0, Math.max(0, keys.length - IMAGE_CACHE_KEEP))) delete next[key]
  return next
}

/** Drop every oversized entry except the image that is on screen right now. */
function dropOversized(prev: Record<string, string>, keep: string | undefined): Record<string, string> {
  const dropped = Object.keys(prev).filter(key => key !== keep && prev[key].length > IMAGE_CACHE_MAX_URL)
  if (dropped.length === 0) return prev
  const next = { ...prev }
  for (const key of dropped) delete next[key]
  return next
}

/**
 * Cache key of one image PREVIEW: the path PLUS the tab's reload nonce.
 *
 * The base64 payload is a snapshot of one read. Keying by path alone kept
 * painting the old bytes after a reload (and after a reconnect's background
 * re-read of an inactive tab, which has no cache-clearing effect running); the
 * nonce changes with every successful re-read, so a stale entry is simply never
 * looked up again and ages out of the bounded cache.
 */
function imageCacheKey(tab: { fullPath: string; reloadNonce?: number }): string {
  return `${tab.fullPath}@${tab.reloadNonce ?? 0}`
}

/** Which chrome variant this mount renders (see the file header). */
type EditorVariant = 'sidebar' | 'center' | 'float'

/** React binding for the shared editor view preferences. */
function useEditorSettings(): EditorSettings {
  return useSyncExternalStore(subscribeEditorSettings, editorSettingsSnapshot, editorSettingsSnapshot)
}

/** One status-bar entry. */
function StatusItem(props: { title?: string; error?: boolean; children: ReactNode; onClick?: () => void }): ReactNode {
  const className = `rvs-status-item${props.error === true ? ' rvs-status-error' : ''}`
  if (props.onClick === undefined) {
    return <span className={className} title={props.title}>{props.children}</span>
  }
  return (
    <button type="button" className={`${className} rvs-status-btn`} title={props.title} onClick={props.onClick}>
      {props.children}
    </button>
  )
}

/**
 * Bottom status bar (full-width variant only, like the sidebar plugin).
 *
 * Left is "where am I" (language, line:column, selection size, indent); right is
 * "how is it shown" (wrap, font size, save state) plus the file encoding. Wrap
 * and font size are CLICKABLE on purpose: those are the two display switches a
 * reader changes often, and making them hunt through a menu would be worse.
 */
function StatusBar(props: {
  t: (key: string) => string
  diff: boolean
  caret: CodeEditorCaret | undefined
  language: string
  indent: string | undefined
  wrap: boolean
  fontSize: number
  readOnly: boolean
  dirty: boolean
  loading: boolean
  saving: boolean
  error: string | undefined
}): ReactNode {
  const caret = props.caret
  const t = props.t
  const saveLabel = props.loading
    ? t('common.loading')
    : props.saving
      ? t('editor.statusSaving')
      : props.dirty
        ? t('editor.unsaved')
        : t('editor.statusClean')
  return (
    <div className="rvs-statusbar">
      <div className="rvs-status-left">
        {props.diff ? (
          <>
            <StatusItem title={t('editor.diffTitle')}>{t('editor.diffTitle')}</StatusItem>
            <StatusItem title={t('editor.diffReadOnlyTitle')}>{t('editor.statusReadOnly')}</StatusItem>
          </>
        ) : (
          <>
            <StatusItem title={t('editor.statusLanguage')}>{props.language}</StatusItem>
            <StatusItem title={t('editor.statusPosition')}>
              {t('editor.statusPositionValue')
                .replace('{line}', String(caret?.line ?? 1))
                .replace('{column}', String(caret?.column ?? 1))}
            </StatusItem>
            {caret !== undefined && caret.selected > 0 && (
              <StatusItem title={t('editor.statusSelected')}>
                {t('editor.statusSelectedValue').replace('{count}', String(caret.selected))}
              </StatusItem>
            )}
            {props.indent !== undefined && <StatusItem title={t('editor.statusIndent')}>{props.indent}</StatusItem>}
          </>
        )}
      </div>
      <div className="rvs-status-right">
        {props.error !== undefined && (
          <StatusItem title={props.error} error>
            {t('editor.statusError')}
          </StatusItem>
        )}
        {props.diff ? null : (
          <>
            {props.readOnly && (
              <StatusItem title={t('editor.statusReadOnlyTitle')}>{t('editor.statusReadOnly')}</StatusItem>
            )}
            <StatusItem
              title={t('editor.statusWrapToggle')}
              onClick={() => updateEditorSettings({ wrap: !props.wrap })}
            >
              {props.wrap ? t('editor.statusWrapOn') : t('editor.statusWrapOff')}
            </StatusItem>
            <StatusItem title={t('editor.statusFont')}>{`${props.fontSize}px`}</StatusItem>
            <StatusItem title={t('editor.statusSaved')}>{saveLabel}</StatusItem>
          </>
        )}
        <StatusItem title={t('editor.statusEncoding')}>UTF-8</StatusItem>
      </div>
    </div>
  )
}

export function EditorPane(props: { visible: boolean }): ReactNode {
  const store = useExplorer()
  const { t, tabs, activeTab, alias } = store
  // Commands run in `repoRoot`, not in the workspace root: a repository that
  // lives in a subdirectory (`repoSubdir`) would otherwise get a workspace-
  // relative path and fail with `no such path`.
  const repoRel = activeTab === undefined ? '' : repoRelative(store.repoRoot, activeTab.fullPath)
  const settings = useEditorSettings()
  /**
   * Which chrome this mount renders. Derived from the store's EFFECTIVE surface
   * (float wins over the base mount), never from a prop: the same component is
   * mounted by the sidebar, the conversation view and the floating window, and
   * exactly one of them may own the live buffer.
   */
  const variant: EditorVariant = store.editorSurface === 'center'
    ? 'center'
    : store.editorSurface === 'float' ? 'float' : 'sidebar'
  const center = variant === 'center'
  // The floating window owns its own Ctrl+wheel zoom (a property of the window,
  // see FloatingEditorWindow), so the shared preference is set on the other two
  // surfaces only.
  const fontStyle = variant === 'float'
    ? undefined
    : ({ '--rvs-editor-font-size': `${settings.fontSize}px` } as CSSProperties)
  // Jump targets of the file on screen; empty when it carries no change data.
  const changeHunks = activeTab?.changeSet?.hunks ?? []
  const chat = useRemoteChatTarget(store.ctx)
  const viewedAliasPath = store.workspace !== undefined ? store.aliasPaths[store.workspace.id] : undefined
  const chatEnabled = chat.sessionId !== undefined
    && chat.sessionWorkspacePath !== undefined
    && viewedAliasPath !== undefined
    && sameLocalDir(chat.sessionWorkspacePath, viewedAliasPath)
  /**
   * The link to this workspace's host is down.
   *
   * Tabs keep their loaded content in memory, so the editor still has something
   * to show — but nothing can be written, and a reload would replace the buffer
   * with an error. The pane therefore degrades to a read-only view of what it
   * already has, with a banner that says so (Phase 2 of the connection work).
   */
  const connection = useConnectionStatus()
  const offline = connection?.state === 'error'

  /**
   * The tab strip's roving focus stops, by tab id.
   *
   * The strip is ONE Tab stop (WAI-ARIA tabs): ←/→ and Home/End move the
   * selection inside it, and only the active tab carries `tabIndex={0}`. A map
   * (not refs on the elements) because the strip is rebuilt from the store on
   * every render, and a keydown must be able to focus a SIBLING that is not the
   * one it fired on.
   */
  const tabElements = useRef(new Map<string, HTMLDivElement>())

  // Image data URL cache, keyed by path (remote reads are not free). Bounded —
  // see `rememberRecent` / `dropOversized`.
  const [images, setImages] = useState<Record<string, string>>({})
  const [imageError, setImageError] = useState<Record<string, string>>({})
  /**
   * How many syntax-token spans the editor produced for the active file.
   * `0` means the file rendered with no grammar (or an old client bundle is
   * loaded), which a screenshot alone cannot distinguish from a CSS problem —
   * so the number sits next to the build stamp in the info bar.
   */
  const [tokenCount, setTokenCount] = useState<number | undefined>(undefined)
  useEffect(() => {
    setTokenCount(undefined)
  }, [activeTab?.id])
  /** Caret readout for the status bar; reset when the file changes. */
  const [caret, setCaret] = useState<CodeEditorCaret | undefined>(undefined)
  useEffect(() => {
    setCaret(undefined)
  }, [activeTab?.id])

  // --- inline blame + per-file history -------------------------------------
  const [blameOn, setBlameOn] = useState<boolean>(readBlamePreference)
  const [blameRows, setBlameRows] = useState<ReadonlyMap<number, BlameLine>>(EMPTY_BLAME)
  const [blameViewport, setBlameViewport] = useState<{ from: number; to: number } | undefined>(undefined)
  const [blameError, setBlameError] = useState<string | undefined>(undefined)
  const blameTicket = useRef(0)
  const blameRequested = useRef(new Set<string>())
  const blameFailed = useRef('')
  const blameViewportTimer = useRef<number | undefined>(undefined)
  const [fileHistoryOpen, setFileHistoryOpen] = useState(false)
  const [fileHistoryRows, setFileHistoryRows] = useState<FileHistoryCommit[]>([])
  const [fileHistoryLoading, setFileHistoryLoading] = useState(false)
  const [fileHistoryError, setFileHistoryError] = useState<string | undefined>(undefined)

  // A new buffer (or an edited one) invalidates both windows and their line
  // numbers; the next viewport report starts a fresh read.
  useEffect(() => {
    blameTicket.current += 1
    blameRequested.current.clear()
    blameFailed.current = ''
    setBlameViewport(undefined)
    setBlameRows(EMPTY_BLAME)
    setBlameError(undefined)
    setFileHistoryOpen(false)
    setFileHistoryRows([])
    setFileHistoryError(undefined)
  }, [activeTab?.id, activeTab?.dirty, activeTab?.reloadNonce])

  const toggleBlame = useCallback(() => {
    setBlameOn(current => {
      const next = !current
      writeBlamePreference(next)
      return next
    })
  }, [])

  /**
   * One `-L` read per uncovered viewport window.
   *
   * `blameRequested` is the cheap "this exact window was already asked for"
   * guard; it is cleared on a buffer/dirty change, and a failed read deletes its
   * key so a later scroll can retry it. Only one request may be in flight —
   * CodeMirror scroll events are frequent and the exec channel is shared.
   */
  useEffect(() => {
    const tab = activeTab
    if (
      !blameOn || tab === undefined || tab.kind !== 'file' || tab.loading || tab.dirty || tab.binary || tab.truncated || tab.preview
      || isBytePreview(previewKindOf(tab.fullPath))
      || alias === '' || store.repoRoot === undefined || repoRel === '' || blameViewport === undefined
    ) {
      setBlameRows(EMPTY_BLAME)
      return
    }
    const total = lineCountOf(tab.text)
    const failureKey = `${tab.id}:${tab.reloadNonce ?? 0}:${repoRel}:${blameOn ? '1' : '0'}`
    if (blameFailed.current === failureKey) return
    const window = planBlameWindow(
      blameViewport.from,
      blameViewport.to,
      total,
      new Set(blameRows.keys()),
    )
    if (window === undefined) return
    const { from, to } = window
    const key = `${tab.id}:${tab.reloadNonce ?? 0}:${from}:${to}`
    if (blameRequested.current.has(key)) return
    blameRequested.current.add(key)
    const ticket = ++blameTicket.current
    const controller = new AbortController()
    void loadBlame(alias, store.repoRoot, repoRel, from, to, { signal: controller.signal })
      .then((rows) => {
        if (ticket !== blameTicket.current) return
        setBlameRows((previous) => {
          const next = new Map(previous)
          for (const row of rows) next.set(row.line, row)
          return next
        })
        setBlameError(undefined)
      })
      .catch((error: unknown) => {
        blameRequested.current.delete(key)
        if (controller.signal.aborted) return
        if (ticket !== blameTicket.current) return
        blameFailed.current = failureKey
        setBlameError(error instanceof Error ? error.message : String(error))
      })
    return () => { controller.abort() }
  }, [
    activeTab?.id,
    activeTab?.dirty,
    activeTab?.reloadNonce,
    blameOn,
    blameRows,
    blameViewport?.from,
    blameViewport?.to,
    alias,
    repoRel,
    store.repoRoot,
  ])

  const onEditorViewport = useCallback((first: number, last: number) => {
    if (blameViewportTimer.current !== undefined) window.clearTimeout(blameViewportTimer.current)
    blameViewportTimer.current = window.setTimeout(() => {
      blameViewportTimer.current = undefined
      setBlameViewport(previous => (
        previous !== undefined && previous.from === first && previous.to === last
          ? previous
          : { from: first, to: last }
      ))
    }, 140)
  }, [])
  useEffect(() => () => {
    if (blameViewportTimer.current !== undefined) window.clearTimeout(blameViewportTimer.current)
  }, [])

  useEffect(() => {
    const tab = activeTab
    if (!fileHistoryOpen || tab === undefined || tab.kind !== 'file' || alias === '' || store.repoRoot === undefined || repoRel === '') {
      setFileHistoryRows([])
      setFileHistoryError(undefined)
      setFileHistoryLoading(false)
      return
    }
    let cancelled = false
    setFileHistoryLoading(true)
    setFileHistoryError(undefined)
    void loadFileHistory(alias, store.repoRoot, repoRel, 100)
      .then((rows) => {
        if (cancelled) return
        setFileHistoryRows(rows)
        setFileHistoryLoading(false)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setFileHistoryError(error instanceof Error ? error.message : String(error))
        setFileHistoryLoading(false)
      })
    return () => { cancelled = true }
  }, [fileHistoryOpen, activeTab?.id, activeTab?.dirty, alias, repoRel, store.repoRoot])

  useEffect(() => {
    if (!fileHistoryOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setFileHistoryOpen(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [fileHistoryOpen])

  /**
   * The "see the difference" payload of a refused save.
   *
   * Read on DEMAND (the 409 only carries the version, not the bytes): showing
   * the remote content requires one more read, and doing that for every save
   * would pay for a comparison the user mostly never asks for.
   */
  const [conflictDiff, setConflictDiff] = useState<{
    tabId: string
    remoteMtime: number | null
    hunks: TextHunk[]
    /** The remote read itself failed: say so instead of claiming "no changes". */
    error?: string
  } | undefined>(undefined)
  useEffect(() => {
    const tab = activeTab
    // A hidden pane may not spend a remote read on a picture nobody can see.
    // The effect re-runs when `visible` flips back, which is where the read
    // then happens — this is the ONE thing `visible` buys an editor pane that
    // is parked behind `display:none`; the body itself has to stay mounted
    // (see the editor host below), so it cannot be gated wholesale.
    if (props.visible === false) return
    if (tab === undefined || !tab.image || alias === '') return
    // A capped read has no decodable payload: skip the read entirely so a
    // partial base64 never becomes a cached (undecodable) data URL. The
    // "too large" notice is rendered from `truncated` instead.
    if (tab.truncated) return
    // Keyed by path + reload nonce, so a re-read shows the new bytes and a
    // truncated read never caches a partial payload (see `imageCacheKey`).
    const key = imageCacheKey(tab)
    if (images[key] !== undefined || imageError[key] !== undefined) return
    let cancelled = false
    void (async () => {
      try {
        const read = await api.fileOp.read(alias, tab.fullPath)
        if (cancelled) return
        if (read.base64 === undefined) {
          setImageError(prev => rememberRecent(prev, key, t('editor.imageFailed')))
          return
        }
        setImages(prev => rememberRecent(prev, key, `data:${mimeFor(tab.fullPath)};base64,${read.base64}`))
      } catch (error) {
        if (!cancelled) {
          setImageError(prev => rememberRecent(prev, key, error instanceof Error ? error.message : String(error)))
        }
      }
    })()
    return () => { cancelled = true }
  }, [activeTab, alias, images, imageError, t, props.visible])

  /**
   * An oversized image is shown but not cached, so it may only live as long as
   * its tab is the one on screen: leaving that tab hands its megabytes back
   * instead of parking them until the page is reloaded.
   */
  useEffect(() => {
    setImages(prev => dropOversized(prev, activeTab === undefined ? undefined : imageCacheKey(activeTab)))
  }, [activeTab?.fullPath, activeTab?.reloadNonce])

  const closeWithGuard = async (tab: EditorTab): Promise<void> => {
    if (tab.dirty) {
      const ok = await confirmDialog({
        title: t('editor.closeDirty'),
        text: tab.rel,
        danger: true,
        okText: t('editor.discardClose'),
      })
      if (!ok) return
    }
    store.closeTab(tab.id)
  }

  /**
   * Re-read one tab, refusing to throw away unsaved edits first.
   *
   * `reloadTab` replaces the buffer with the remote bytes; on a dirty tab that
   * is the same data loss as closing without the guard, but it used to happen
   * with no prompt at all (the toolbar button sits right next to Save).
   */
  const reloadWithGuard = async (tab: EditorTab): Promise<void> => {
    if (tab.dirty) {
      const ok = await confirmDialog({
        title: t('editor.reloadDirty'),
        text: tab.rel,
        danger: true,
        okText: t('editor.discardReload'),
      })
      if (!ok) return
    }
    await store.reloadTab(tab.id)
  }

  /**
   * The preview inputs as STABLE primitives, not the tab object.
   *
   * `patchTab` builds a fresh tab object for every change (`dirty`, `saving`,
   * `activeHunk`, `reloadNonce`…) while leaving `text` and the render-mode flags
   * alone. Keying the two preview memos below on the tab therefore re-parsed a
   * whole Markdown/HTML document whenever the user saved, jumped to a change or
   * toggled a dot — a parse per action, for text that had not moved. A string's
   * identity is stable while its contents are, so `text` + the flags is the key
   * that actually means "the preview source changed".
   */
  const previewText = activeTab?.text
  const previewIsHtml = activeTab?.html === true
  const previewIsMarkdown = activeTab?.markdown === true
  const previewVisible = activeTab?.preview === true
  const previewKind: PreviewKind = activeTab?.kind === 'file' ? previewKindOf(activeTab.fullPath) : 'text'
  const bytePreview = isBytePreview(previewKind)

  const darkScheme = useSyncExternalStore(subscribeColorScheme, isDarkScheme)

  const htmlDoc = useMemo(() => {
    if (!previewIsHtml) return ''
    const dark = darkScheme
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      'img-src data: blob:',
      'font-src data:',
      'media-src data: blob:',
      "form-action 'none'",
      "base-uri 'none'",
    ].join('; ')
    return [
      '<!doctype html><meta charset="utf-8">',
      `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
      '<style>',
      `:root{color-scheme:${dark ? 'dark' : 'light'}}`,
      `html,body{background:${dark ? '#1e1e1e' : '#ffffff'};color:${dark ? '#d4d4d4' : '#1f1f1f'}}`,
      'body{margin:14px;font:14px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow-wrap:break-word}',
      'img,video,canvas{max-width:100%;height:auto}',
      'table{border-collapse:collapse}',
      `td,th{border:1px solid ${dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.12)'};padding:4px 8px}`,
      'pre{overflow:auto}',
      '</style>',
      previewText ?? '',
    ].join('')
  }, [previewIsHtml, previewText, darkScheme])

  /** Stable labels identity: the platform renderer keys its cache on it. */
  const markdownLabels = useMemo(() => ({
    code: {
      copyLabel: t('preview.copyCode'),
      copiedLabel: t('preview.copied'),
    },
    footnotes: t('preview.footnotes'),
  }), [t])

  /**
   * Markdown preview through the host's platform renderer (the same one the
   * chat uses): GFM tables, code highlighting and footnotes come for free and
   * raw HTML in a remote document is not inserted into the app DOM.
   */
  const markdownPreview = useMemo(() => {
    if (!previewIsMarkdown || !previewVisible || previewText === undefined) return null
    return (
      <div className="rvs-preview-scroll">
        {activeTab?.truncated === true && <div className="rvs-preview-banner">{t('preview.truncated')}</div>}
        <div className="rvs-preview-markdown rvs-markdown" data-preview-path={activeTab?.fullPath ?? ''}>
          <MarkdownText text={previewText} labels={markdownLabels} variant="body" />
        </div>
      </div>
    )
  }, [previewIsMarkdown, previewVisible, previewText, markdownLabels, activeTab?.fullPath, activeTab?.truncated, t])

  /**
   * The status bar's indent hint, derived from the loaded text.
   *
   * Memoised on the tab: the status bar re-renders on every caret move, and
   * scanning 200 lines per arrow key would be free in theory and wasteful in
   * practice.
   */
  const indentLabel = useMemo(() => {
    if (activeTab === undefined || activeTab.kind !== 'file' || activeTab.binary) return undefined
    return detectIndentLabel(activeTab.text)
  }, [activeTab])

  // The editor owns the live buffer; the save path pulls it imperatively
  // instead of mirroring every keystroke into React state.
  const editorRef = useRef<CodeEditorHandle>(null)
  /** Editor body container: anchors the Ctrl+wheel zoom listener. */
  const bodyRef = useRef<HTMLDivElement>(null)

  /**
   * Scroll + caret per tab, so re-selecting a tab returns to where it was.
   *
   * `CodeEditor` is keyed by tab id, so switching files remounts it — a fresh
   * buffer rather than the previous file's undo stack, which is what we want,
   * but it also reset the scroll and the caret.
   *
   * The map lives in `live-editor.ts`, NOT in a `useRef` here, because the pane
   * is unmounted when the editor floats out (and again when it docks back): a
   * per-component map would lose the position on the one surface swap that
   * most needs it. It survives there for the same reason the store does.
   *
   * Keyed by tab id alone, which is safe because only ONE `EditorPane` is ever
   * mounted: the centre surface when the host has a `conversation.view` slot,
   * the floating window while the editor floats, otherwise the sidebar
   * fallback. With two live editors for the same tab the hidden one would
   * report its untouched scrollTop 0 and overwrite the visible one's, snapping
   * every switch back to the top — so `RemoteRoot`, `RemoteEditorView` and the
   * floating window all gate their mounts on `editorSurface` and must keep
   * doing so.
   *
   * The editor REPORTS its position (see `CodeEditor`'s `onViewState`) instead
   * of this component reading it back through `editorRef`, because the ref is
   * already `null` by the time any cleanup here could run: React clears a
   * child's ref before running the parent's cleanup. `.spike/tabswitch-check.mjs`
   * reproduces the failed variants and pins the working wiring.
   */
  /**
   * Store a reading under the tab that produced it.
   *
   * The tab id comes FROM the report, never from "which tab is active now":
   * React unmounts the outgoing editor and mounts the incoming one in the same
   * commit, so the incoming editor's first report (scrollTop 0) arrives while
   * this component still sees the OUTGOING tab as active. Keying on that
   * overwrote the position just saved for the tab being left — the map held
   * `App.tsx: 1656` and then flipped back to 0, so every switch landed at the
   * top.
   *
   * No dependency on the active tab either: the callback has to be able to
   * accept a report for any tab.
   */
  const rememberViewState = useCallback((tabId: string, state: CodeEditorViewState): void => {
    rememberEditorViewState(tabId, state)
  }, [])

  /**
   * Closed tabs may not keep their scroll + caret. The map is keyed by tab id
   * and is only ever written: a session that opened a few hundred files would
   * otherwise hold a state object for every one of them, long after the tab is
   * gone.
   */
  useEffect(() => {
    pruneEditorViewStates(new Set(tabs.map(tab => tab.id)))
  }, [tabs])

  /**
   * True only while the CodeMirror instance for the active tab is mounted.
   *
   * The editor used to be conditionally unmounted in preview mode, which made
   * `getContent()` return undefined; the save path then fell back to the
   * tab's loaded text and wrote the PRE-EDIT bytes back to the remote file
   * while reporting success. Refusing to save without a live buffer is the
   * load-bearing half of that fix — the editor staying mounted (below) is the
   * other half, so switching preview no longer drops unsaved edits either.
   */
  const editorMounted =
    activeTab !== undefined
    && activeTab.kind === 'file'
    && !activeTab.image
    && !activeTab.binary
    && !activeTab.loading
    && activeTab.error === undefined

  /**
   * Advertise the live editor so the store can snapshot it before a surface
   * flip (see `captureLiveEditor`): the floating window is a different mount of
   * the SAME pane, so switching to it unmounts this component.
   *
   * The getter is `() => editorRef.current`, not the handle itself: the handle
   * only exists after `CodeEditor` mounts, and it is cleared before the
   * cleanup that would otherwise run here.
   */
  useEffect(() => {
    if (!editorMounted || activeTab === undefined) return
    return registerLiveEditor(activeTab.id, () => editorRef.current)
  }, [editorMounted, activeTab?.id])

  /**
   * Ctrl/Cmd + wheel changes the editor font size (same feel as the floating
   * window's zoom).
   *
   * A native listener, not React's `onWheel`: React attaches its wheel handler
   * as passive at the root, so `preventDefault()` is ignored and the page
   * zooms instead. Scoped to the editor body, so the tree/terminal keep their
   * own gestures.
   */
  useEffect(() => {
    const element = bodyRef.current
    if (element === null) return
    const onWheel = (event: WheelEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return
      event.preventDefault()
      const direction = event.deltaY < 0 ? 1 : -1
      updateEditorSettings({ fontSize: stepFontSize(editorSettingsSnapshot().fontSize, direction) })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
    // Re-attach when the body container appears (it does not exist in the empty
    // state) so the first opened file still gets the zoom.
  }, [tabs.length])

  const saveActive = async (): Promise<void> => {
    const tab = activeTab
    if (tab === undefined) return
    if (offline) {
      // Writing now can only fail; say why instead of surfacing a socket error.
      toast(t('connection.saveBlocked'), true)
      return
    }
    const text = editorRef.current?.getContent()
    if (text === undefined) {
      // Never let the store fall back to stale text: that destroys the edit.
      toast(t('editor.needSource'), true)
      return
    }
    // The store advances the disk baseline and re-derives the dirty flag on the
    // MOUNTED editor through the module-level registration (see
    // `markLiveEditorSaved`), so this works even when the pane is remounted
    // while the write is in flight. Nothing is left to do here beyond handing
    // it the live buffer.
    await store.saveTab(tab.id, text)
  }

  /**
   * Overwrite a remote file this buffer was refused on.
   *
   * A separate, explicitly confirmed action: the whole point of the guard is
   * that nobody loses the other writer's work WITHOUT being told. Once the user
   * has been told and still chooses their own version, that is their call — but
   * it is a decision made on screen, never a default.
   */
  const overwriteConflict = async (tab: EditorTab): Promise<void> => {
    /**
     * The live buffer, from whichever surface owns this tab: the file editor's
     * CodeMirror mount when it is up, otherwise the tab's own handoff copy —
     * which is where a DIFF pane keeps its text (its CodeEditor reports every
     * change through `onBuffer`). An empty tab text is refused rather than
     * written: for a diff pane that would save an empty file over the part of
     * the tree the diff was about.
     */
    const text = editorRef.current?.getContent() ?? (tab.text === '' ? undefined : tab.text)
    if (text === undefined) {
      toast(t('editor.needSource'), true)
      return
    }
    const ok = await confirmDialog({
      title: t('editor.conflictOverwriteTitle'),
      text: tab.rel,
      danger: true,
      okText: t('editor.conflictOverwrite'),
    })
    if (!ok) return
    setConflictDiff(undefined)
    await store.saveTab(tab.id, text, { force: true })
  }

  /**
   * Compare the remote's CURRENT bytes with the live buffer, in place.
   *
   * The 409 carries only the version, not the content, so this costs one read —
   * paid on demand rather than on every save, because most conflicts are
   * resolved by "reload" or by re-typing on top of the new version without ever
   * looking at the difference.
   */
  const showConflictDiff = async (tab: EditorTab): Promise<void> => {
    const local = editorRef.current?.getContent() ?? tab.text
    try {
      // Bounded like every other remote read: a Host that never answers must not
      // leave this button spinning forever with no message.
      const read = await withDeadline(
        api.fileOp.read(alias, tab.fullPath),
        clientDeadlineFor(fileReadTimeoutMs()),
        t('editor.readTimeout'),
      )
      setConflictDiff({
        tabId: tab.id,
        remoteMtime: read.mtime,
        // Remote is the BEFORE side: '+' lines are what this buffer would add on
        // top of what the other writer left behind.
        hunks: diffText(read.text ?? '', local).hunks,
      })
    } catch (error) {
      // The remote could not be read (deleted, permission, link down). Say that
      // instead of showing an empty diff, which would read as "no differences".
      setConflictDiff({
        tabId: tab.id,
        remoteMtime: null,
        hunks: [],
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Latest `saveActive`, for the window-level shortcut.
   *
   * The listener is installed ONCE and must act on the current render's tab /
   * offline state, never on the render that happened to register it.
   */
  const saveActiveRef = useRef(saveActive)
  saveActiveRef.current = saveActive
  /** The tab the shortcut would save right now (kept fresh by the line above). */
  const saveShortcutTabRef = useRef<EditorTab | undefined>(activeTab)
  saveShortcutTabRef.current = activeTab

  /**
   * Keep Ctrl/Cmd+S working when the caret is NOT inside CodeMirror.
   *
   * The editor's own keymap only fires while its view has focus, so after
   * clicking the tab strip / info row / a sidebar panel the keystroke did
   * nothing — silently, while the save button's title advertises `(Ctrl+S)`.
   * The installer runs in the bubble phase and steps aside when CodeMirror
   * already handled the key (`defaultPrevented`), so a focused editor still
   * saves exactly once. Everything downstream is the existing save path
   * (`saveActive` → `store.saveTab`), so the offline / truncated guards and the
   * per-tab save queue apply unchanged.
   *
   * Only the VISIBLE surface registers: several `EditorPane`s can stay mounted at
   * once (every native session tab keeps its `RemoteRoot` alive, and the
   * sidebar/centre/floating surfaces overlap during a swap). The module already
   * dedupes to ONE window listener and dispatches to a single surface; gating on
   * `visible` additionally keeps a hidden pane from being the one that answers.
   */
  useEffect(() => {
    if (!props.visible) return
    return installSaveShortcut(() => {
      // A themed dialog owns its input: saving the file behind it would surprise.
      if (typeof document !== 'undefined' && document.querySelector('.rvs-modal-mask') !== null) return undefined
      const tab = saveShortcutTabRef.current
      // Working-tree diffs are `DiffView`'s own onSave contract; previews have no
      // buffer at all. `saveActive` would misreport both.
      if (tab === undefined || tab.kind !== 'file' || tab.image || tab.binary || isBytePreview(previewKindOf(tab.fullPath))) return undefined
      return () => { void saveActiveRef.current() }
    })
  }, [props.visible])

  // --- 符号大纲（Ctrl+Shift+O）---------------------------------------------
  /**
   * 打开中的大纲。
   *
   * 存的是「打开那一刻的实时缓冲区全文」，而不是 `tabId` + 每次渲染再去读 ——
   * 面板打开期间焦点在筛选框里，缓冲区不可能再变，所以一份快照足够；把全文放进
   * state 也让 `OutlinePanel` 的 `useMemo` 有稳定输入（不会每帧重扫文件）。
   *
   * `tabId` 留在里面是为了自检：换 tab 时旧大纲不能继续挂在屏幕上的新文件上。
   */
  const [outline, setOutline] = useState<{ tabId: string; path: string; text: string } | undefined>(undefined)

  // 换 tab / 重载后旧大纲的行号已经不属于屏幕上的文件了：直接关掉，绝不猜。
  useEffect(() => {
    setOutline(undefined)
  }, [activeTab?.id, activeTab?.reloadNonce])
  // Hiding this surface (panel switch, rail tab, float window) must take the
  // portal down with it: the mask is `position: fixed` and would otherwise stay
  // painted over whatever surface replaced this one.
  useEffect(() => {
    if (!props.visible) setOutline(undefined)
  }, [props.visible])

  const openOutline = useCallback(() => {
    const tab = saveShortcutTabRef.current
    if (!outlineAvailable(tab)) return
    // 实时 buffer 优先：`tab.text` 是加载时的字节，输入从来没有回写进去
    // （见下方 editor host 的注释）。dirty 文件只有这里能拿到正确内容。
    setOutline({ tabId: tab.id, path: tab.fullPath, text: editorRef.current?.getContent() ?? tab.text })
  }, [])
  const closeOutline = useCallback(() => { setOutline(undefined) }, [])

  /**
   * 跳转：复用现有的「选中行区间 + 滚到中央 + 点灯」，1-based 行号。
   *
   * 跳转放到下一个 task：浮层卸载时会把焦点还给打开它的按钮（portal 的常规
   * 做法，见 QuickOpen），先 `revealRange` 再卸载的话，焦点会被那一步抢回去，
   * 用户接着敲的字就落空了。等卸载稳定后再把焦点交给编辑器。
   */
  const jumpToOutline = useCallback((entry: OutlineEntry) => {
    setOutline(undefined)
    window.setTimeout(() => { editorRef.current?.revealRange(entry.line, entry.line) }, 0)
  }, [])

  // window 监听用 ref 取最新值：effect 只为可见性重装，不随每次渲染重装。
  const openOutlineRef = useRef(openOutline)
  openOutlineRef.current = openOutline
  const closeOutlineRef = useRef(closeOutline)
  closeOutlineRef.current = closeOutline
  const outlineOpenRef = useRef(false)
  outlineOpenRef.current = outline !== undefined

  /**
   * Ctrl/Cmd+Shift+O：转到符号。
   *
   * 用 window 冒泡监听而不是 CodeMirror keymap：和 Ctrl+S 同理 —— 点过 tab 条、
   * 信息栏或侧栏之后光标已经不在编辑器里，keymap 根本不会触发。只在这个座位可见
   * 时安装（多个 EditorPane 可能同时挂载，隐藏的那个不该抢键）。
   *
   * 不抢别人的键：
   *  - 终端：xterm 已经把 ^O 发给远端 shell（readline 的 operate-and-get-next），
   *    再开浮层就是一次按键两个动作；
   *  - 其他输入框（聊天输入、对话框输入）与任何模态层（宿主审批、右键菜单）都保留
   *    这个键；
   *  - 不满足条件时**不** preventDefault：浏览器自己的 Ctrl+Shift+O 在别处仍是它
   *    的（我们只接管自己确实要处理的那一次按键）。
   */
  useEffect(() => {
    if (!props.visible) return
    const onKey = (event: KeyboardEvent): void => {
      // Another owner (host shortcut, an outer handler) already claimed this
      // key: bubble phase must yield, same contract as save-shortcut.ts.
      if (event.defaultPrevented) return
      const ctrlShiftO = (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey
      const altO = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
      if (!ctrlShiftO && !altO) return
      if (event.key.toLowerCase() !== 'o') return
      // 按住不放不该让浮层闪；输入法组字期间这也不是一个命令。
      if (event.repeat || event.isComposing === true) return
      // 自己开着：再按一次关闭（与 Ctrl+P 的「再按一次退出」同一习惯）。
      if (outlineOpenRef.current) {
        event.preventDefault()
        closeOutlineRef.current()
        return
      }
      if (isModalLayerOpen()) return
      const focused = document.activeElement
      if (focused instanceof HTMLElement && focused.closest('.xterm') !== null) return
      // CodeMirror 的 `.cm-content` 是 contenteditable，天然在 FOREIGN_TARGET 里：
      // 只放过**本插件编辑器**里那一份（`.rvs-editor-host` 的子树），宿主自己的
      // 聊天输入同样是 CodeMirror —— 在别人的编辑器里抢键和在别人的输入框里抢键
      // 是同一件事。
      if (focused instanceof HTMLElement
        && focused.closest(FOREIGN_TARGET) !== null
        && focused.closest('.rvs-editor-host') === null) return
      if (!outlineAvailable(saveShortcutTabRef.current)) return
      event.preventDefault()
      openOutlineRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.visible])

  if (tabs.length === 0) {
    if (center) {
      return (
        <div className="rvs-pane grow rvs-edge">
          <div className="rvs-editor-empty">
            <div className="rvs-editor-empty-glyph" aria-hidden="true">✎</div>
            <div className="rvs-editor-empty-title">{t('editor.centerEmptyTitle')}</div>
            <div className="rvs-editor-empty-hint">{t('editor.centerEmptyHint')}</div>
            <div className="rvs-editor-empty-hint" style={{ opacity: 0.7 }}>{t('editor.emptyShortcuts')}</div>
          </div>
        </div>
      )
    }
    return (
      <div className="rvs-pane grow rvs-edge">
        <div className="rvs-empty">
          <div className="rvs-empty-title">{t('editor.dockEmptyTitle')}</div>
          <div className="rvs-empty-hint">{t('editor.dockEmptyHint')}</div>
        </div>
      </div>
    )
  }

  const isDiff = activeTab?.kind === 'diff'
  /**
   * Whether the "switch to content editing" action makes sense for this diff.
   *
   * A commit drill-down compares historical blobs; opening TODAY's file from it
   * would read as editing the commit. A deletion has no content to edit (the
   * read would just fail), and a binary diff has nothing an editor can show.
   */
  const canSwitchToEdit = activeTab !== undefined
    && activeTab.kind === 'diff'
    // 会话只读 diff 不开「切换为内容编辑」：它属于会话账本，编辑入口是面板左键
    // （会带着标记打开）；这里再开一次只会打开一个没有标记的普通标签页。
    && activeTab.sessionDiff === undefined
    && activeTab.ref === undefined
    && activeTab.diff !== undefined
    && !activeTab.diff.unsupported
    && !(activeTab.diff.newText === '' && activeTab.diff.oldText !== '')
  const displayPath = activeTab?.fullPath ?? ''
  /**
   * 信息栏里那句"这一页是什么 diff"。
   *
   * 三种来源必须分得清：会话账本的只读比较、暂存区（只读）、某个提交（历史）。
   * 写成一串 if 而不是嵌套三元：三种情况各说各的，读起来不会串行。
   */
  let diffScopeLabel = ''
  if (activeTab?.kind === 'diff') {
    if (activeTab.sessionDiff !== undefined) diffScopeLabel = t('changes.diffTabLabel')
    else if (activeTab.ref !== undefined) diffScopeLabel = `${t('scm.commitDiff')} ${activeTab.ref.slice(0, 7)}`
    else if (activeTab.staged) diffScopeLabel = t('scm.stagedReadonly')
  }
  /**
   * 编辑器悬浮栏的「确认保留」（块级本地笔记，见 `changes/block-confirm.ts`）。
   *
 * 三个前提缺一不可：这一页有改动标记、标记带着块标识（建标记时带了远端绝对路径）、
 * 以及这批标记有 provenance（会话归属 —— 笔记按会话存）。任何一个缺失就不提供这个
   * 动作，悬浮栏回到"只有撤销"。
   *
   * 读写都走 `localStorage`，**不发任何请求**：这是"我看到哪儿了"的记号，不是远端
   * 事实；状态变化不经过 React（编辑器在 React 之外点它），所以每次现读。
   */
  const blockConfirm = (() => {
    const set = activeTab?.changeSet
    if (activeTab === undefined || set === undefined || set === null) return undefined
    const blocks = set.blocks
    const sessionId = changeOriginForTab(activeTab.id)?.sessionId
    if (blocks === undefined || sessionId === undefined || sessionId === '') return undefined
    const storage = (): ConfirmStorage | undefined => {
      try {
        return window.localStorage
      } catch {
        // 隐私模式 / 禁用存储：不提供这一级（而不是给一个点了不生效的按钮）。
        return undefined
      }
    }
    return {
      isConfirmed: (mark: ChangeMark): boolean => {
        const id = blockIdForMark(blocks, mark)
        const store = storage()
        return id === undefined || store === undefined ? false : isStoredBlockConfirmed(store, sessionId, id)
      },
      onToggle: (mark: ChangeMark): void => {
        const id = blockIdForMark(blocks, mark)
        const store = storage()
        if (id === undefined || store === undefined) return
        toggleStoredBlock(store, sessionId, id)
      },
      label: (): string => t('changes.confirmBlock'),
      pressedLabel: (): string => t('changes.confirmedBlock'),
    }
  })()
  const language = isDiff
    ? 'Diff'
    : activeTab?.image === true
      ? 'Image'
      : previewKindLabel(previewKind) ?? langLabel(langFromPath(activeTab?.rel ?? ''))
  const activeImageKey = activeTab === undefined ? undefined : imageCacheKey(activeTab)
  const imageSrc = activeTab !== undefined && activeTab.image && activeImageKey !== undefined
    ? images[activeImageKey]
    : undefined
  const imageFailure = activeTab !== undefined && activeTab.image && activeImageKey !== undefined
    ? imageError[activeImageKey]
    : undefined
  const caretBlame = caret === undefined ? undefined : blameRows.get(caret.line)

  return (
    <div className="rvs-pane grow rvs-edge" style={{ ...(fontStyle ?? {}), position: 'relative' }}>
      {/* Tab strip: switch / close / dirty dot / diff glyph. Middle-click closes
          too — the muscle memory shared with VS Code and browsers. */}
      <div className="rvs-etabs" role="tablist" aria-label={t('editor.tabsLabel')}>
        {tabs.map((tab, index) => {
          const active = tab.id === store.activeTabId
          const tabIsDiff = tab.kind === 'diff'
          return (
            <div
              key={tab.id}
              role="tab"
              // Roving tabindex (WAI-ARIA tabs): the strip is one Tab stop, so
              // the panel's other controls are not separated by N tab stops.
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              ref={(element) => {
                if (element === null) tabElements.current.delete(tab.id)
                else tabElements.current.set(tab.id, element)
              }}
              className={`rvs-etab${active ? ' active' : ''}${tabIsDiff ? ' rvs-etab-diff' : ''}`}
              title={tabIsDiff ? `${tab.rel}${t('editor.diffSuffix')}` : tab.fullPath}
              onClick={() => store.activateTab(tab.id)}
              onAuxClick={(event) => {
                if (event.button !== 1) return
                event.preventDefault()
                void closeWithGuard(tab)
              }}
              onKeyDown={(event) => {
                // An IME composition owns Enter/Space (the candidate list).
                if (event.nativeEvent.isComposing) return
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  store.activateTab(tab.id)
                  return
                }
                // WAI-ARIA tabs keyboard model (audit I-16): arrows walk the
                // strip, Home/End jump to its edges, wrapping at both ends, and
                // the selection follows focus — the tabs are the cheap file
                // switcher, so requiring Enter afterwards would only add a step.
                const step = event.key === 'ArrowRight'
                  ? 1
                  : event.key === 'ArrowLeft' ? -1 : undefined
                if (step === undefined && event.key !== 'Home' && event.key !== 'End') return
                event.preventDefault()
                const next = event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : (index + (step ?? 0) + tabs.length) % tabs.length
                const target = tabs[next]
                if (target === undefined) return
                store.activateTab(target.id)
                tabElements.current.get(target.id)?.focus()
              }}
            >
              <span className="rvs-etab-glyph">{tabIcon(tab)}</span>
              <span className="rvs-etab-name">
                {baseName(tab.rel)}
                {tabIsDiff && <span style={{ opacity: .6 }}>{t('editor.diffSuffix')}</span>}
              </span>
              {tab.dirty && <span className="rvs-etab-dot" title={t('editor.unsaved')} />}
              <button
                type="button"
                className="rvs-etab-close"
                title={t('common.close')}
                aria-label={t('common.close')}
                onClick={(event) => { event.stopPropagation(); void closeWithGuard(tab) }}
              >
                <IconClose size={11} />
              </button>
            </div>
          )
        })}
      </div>

      {activeTab !== undefined && (
        <>
          {/* Info row: breadcrumb in the full-width variant (sibling picker),
              single path line in the docked one. */}
          <div className="rvs-einfo">
            {center && activeTab.kind === 'file'
              ? (
                <Breadcrumb
                  t={t}
                  alias={alias}
                  root={store.root}
                  rootName={store.workspace?.name ?? ''}
                  path={displayPath}
                  onOpen={(fullPath) => { store.openFile(fullPath) }}
                />
              )
              : <span className="rvs-einfo-path" title={displayPath}>{displayPath}</span>}
            <span className="rvs-einfo-actions">
              {activeTab.kind === 'file' && hasTextSource(previewKind) && (
                <Segmented<'preview' | 'source'>
                  value={activeTab.preview ? 'preview' : 'source'}
                  onChange={(next) => store.updateTab(activeTab.id, { preview: next === 'preview' })}
                  options={[
                    { id: 'preview', label: t('editor.preview') },
                    { id: 'source', label: t('editor.source') },
                  ]}
                />
              )}
              {activeTab.kind === 'diff' && (
                <span style={{ color: 'var(--rvs-fg3)' }}>{diffScopeLabel}</span>
              )}
              <span style={{ color: 'var(--rvs-fg3)' }}>{language}</span>
              {/* Connection health sits where the build stamp does: it is the
                  surface the user is looking at while they work. */}
              <ConnectionStatusChip compact />
              {/* Build stamp + token count (see tsdown `define.__RVS_BUILD__`).
                  The GUI serves plugin bundles captured when `dsh web` started,
                  so the stamp says WHICH code is running, and the token count
                  says whether the grammar actually produced colored tokens. */}
              <span className="rvs-build" title={`dsh-remote-vs build ${__RVS_BUILD__}`}>{__RVS_BUILD__}</span>
              {tokenCount !== undefined && !bytePreview && (
                <span className="rvs-build" title={t('editor.tokenCount')}>tok {tokenCount}</span>
              )}
              {activeTab.kind === 'file' && (
                <>
                  {/* The status chip used to be a four-deep nested ternary in
                      both the class and the label, while the project's own
                      review checklist forbids nested ternaries. One lookup per
                      concern instead. */}
                  {!bytePreview && !activeTab.image && (
                    <span className={`rvs-status ${tabStatusClass(activeTab)}`}>
                      {t(tabStatusKey(activeTab))}
                    </span>
                  )}
                  <IconButton title={t('editor.reloadFile')} onClick={() => { void reloadWithGuard(activeTab) }} disabled={offline || activeTab.loading}>
                    <IconRefresh size={13} />
                  </IconButton>
                  {!bytePreview && !activeTab.image && (
                    <IconButton
                      title={`${t('editor.save')} (Ctrl+S)`}
                      onClick={() => { void saveActive() }}
                      disabled={offline || activeTab.loading || activeTab.binary || activeTab.truncated || !activeTab.dirty}
                    >
                      <IconSave size={13} />
                    </IconButton>
                  )}
                  {/* 大纲：只对文本文件出现。`≡` 是行内字形（与 blame 的 `B`、
                      浮窗的图标同一套做法），不额外引一个图标组件。 */}
                  {!activeTab.image && !activeTab.binary && !isBytePreview(previewKind) && (
                    <IconButton
                      title={`${t('editor.outline')} (Ctrl+Shift+O)`}
                      onClick={openOutline}
                      disabled={!outlineAvailable(activeTab)}
                    >
                      <span className="rvs-glyph-text">≡</span>
                    </IconButton>
                  )}
                </>
              )}
              {activeTab.kind === 'diff' && (
                <>
                  <IconButton title={t('scm.reloadDiff')} onClick={() => { void reloadWithGuard(activeTab) }} disabled={offline}>
                    <IconRefresh size={13} />
                  </IconButton>
                  {/* A diff is a view of a file, not a place to edit: this opens
                      the same path as a normal content tab, next to where the
                      save button lives for file tabs. Commit drills (historical
                      blobs), deletions and binary diffs are left out. */}
                  {canSwitchToEdit && (
                    <IconButton
                      title={t('editor.switchToEdit')}
                      onClick={() => { store.openFile(activeTab.fullPath) }}
                    >
                      <IconCode size={13} />
                    </IconButton>
                  )}
                </>
              )}
              {activeTab.kind === 'file' && !activeTab.image && !activeTab.binary && !bytePreview && (
                <IconButton
                  title={t('editor.wrap')}
                  onClick={() => updateEditorSettings({ wrap: !settings.wrap })}
                >
                  <IconWrap size={13} />
                </IconButton>
              )}
              {activeTab.kind === 'file' && !activeTab.image && !activeTab.binary && !isBytePreview(previewKind) && repoRel !== '' && (
                <>
                  <IconButton
                    title={blameError === undefined ? t('editor.blameToggle') : `${t('editor.blameToggle')}: ${blameError}`}
                    className={blameOn ? 'rvs-hbtn-on' : undefined}
                    onClick={toggleBlame}
                  >
                    <span className="rvs-glyph-text">B</span>
                  </IconButton>
                  <IconButton
                    title={t('editor.fileHistory')}
                    className={fileHistoryOpen ? 'rvs-hbtn-on' : undefined}
                    onClick={() => { setFileHistoryOpen(open => !open) }}
                  >
                    <IconDiff size={13} />
                  </IconButton>
                  {blameOn && caretBlame !== undefined && isCommittedBlame(caretBlame.hash) && (
                    <IconButton
                      title={t('editor.blameOpenCaret')}
                      onClick={() => { store.focusCommit(caretBlame.hash) }}
                    >
                      <span className="rvs-glyph-text">↗</span>
                    </IconButton>
                  )}
                </>
              )}
              <span className="rvs-einfo-actions-divider" aria-hidden="true" />
              {/* The floating window owns its OWN Ctrl+wheel zoom (a property of
                  that window, persisted per window): the shared preference is not
                  what paints there, so these two would look dead inside it. */}
              {variant !== 'float' && !bytePreview && !activeTab.image && activeTab.kind !== 'diff' && (
                <>
                  <IconButton
                    title={t('editor.fontSmaller')}
                    onClick={() => updateEditorSettings({ fontSize: stepFontSize(settings.fontSize, -1) })}
                  >
                    <span className="rvs-font-glyph">A−</span>
                  </IconButton>
                  <IconButton
                    title={t('editor.fontLarger')}
                    onClick={() => updateEditorSettings({ fontSize: stepFontSize(settings.fontSize, 1) })}
                  >
                    <span className="rvs-font-glyph">A+</span>
                  </IconButton>
                </>
              )}
              {variant !== 'float' && (
                <IconButton title={t('float.title')} onClick={() => { store.openFloatingEditor() }}>
                  <IconFloat size={13} />
                </IconButton>
              )}
              {/* Same editor, another surface. One instance only: flipping the
                  store's surface unmounts this mount and the target one takes
                  the same buffer over (see the file header). */}
              {variant === 'center'
                ? (
                  <IconButton title={t('editor.dockToSidebar')} onClick={() => { store.dockEditorSidebar() }}>
                    <IconCollapse size={13} />
                  </IconButton>
                )
                : variant === 'sidebar'
                  ? (
                    <IconButton title={t('editor.openInCenter')} onClick={() => { store.openEditorInCenter() }}>
                      <IconExpand size={13} />
                    </IconButton>
                  )
                  : null}
            </span>
          </div>

          {fileHistoryOpen && activeTab.kind === 'file' && (
            <div className="rvs-file-history" role="dialog" aria-label={t('editor.fileHistory')}>
              <div className="rvs-file-history-head">
                <span className="rvs-file-history-title">{t('editor.fileHistory')}</span>
                <span className="rvs-file-history-path" title={repoRel}>{repoRel}</span>
                <button
                  type="button"
                  className="rvs-file-history-close"
                  title={t('common.close')}
                  aria-label={t('common.close')}
                  onClick={() => { setFileHistoryOpen(false) }}
                >
                  <IconClose size={11} />
                </button>
              </div>
              {fileHistoryLoading && <div className="rvs-file-history-note">{t('common.loading')}</div>}
              {!fileHistoryLoading && fileHistoryError !== undefined && (
                <div className="rvs-file-history-note error">{fileHistoryError}</div>
              )}
              {!fileHistoryLoading && fileHistoryError === undefined && fileHistoryRows.length === 0 && (
                <div className="rvs-file-history-note">{t('editor.fileHistoryEmpty')}</div>
              )}
              {!fileHistoryLoading && fileHistoryError === undefined && fileHistoryRows.length > 0 && (
                <div className="rvs-file-history-list">
                  {fileHistoryRows.map(commit => (
                    <button
                      type="button"
                      key={commit.hash}
                      className="rvs-file-history-row"
                      onClick={() => {
                        setFileHistoryOpen(false)
                        store.openCommitFile(commit.hash, commit.path, commit.origPath)
                      }}
                    >
                      <span className="rvs-file-history-hash">{commit.hash.slice(0, 7)}</span>
                      <span className="rvs-file-history-subject" title={commit.subject}>{commit.subject}</span>
                      <span className="rvs-file-history-meta">
                        {commit.author} · {new Date(commit.date * 1000).toLocaleDateString()}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 大纲浮层：portal 到 <body>，所以放在 JSX 的哪一层都不影响定位；
              放在信息栏旁边只是让它和触发它的按钮读在一起。`tabId` 判定是最后
              一道闸：换 tab 之后旧大纲绝不挂在新文件上。 */}
          {outline !== undefined && outline.tabId === activeTab.id && (
            <OutlinePanel
              t={t}
              path={outline.path}
              text={outline.text}
              onPick={jumpToOutline}
              onClose={closeOutline}
            />
          )}

          <div className="rvs-body" ref={bodyRef}>
            {/*
              A REFUSED save: the remote file moved on, so nothing was written.
              This sits above the buffer (not in a toast) because it is a
              decision the user has to make before the next Ctrl+S can succeed,
              and it names the three ways out instead of only the error.

              File AND diff tabs: a working-tree diff's after pane is the real
              file on the remote and saves to it, so it carries the same guard
              (see `snapshotDiffBaseline`).
            */}
            {(activeTab.kind === 'file' || activeTab.kind === 'diff') && activeTab.conflict !== undefined && (
              <div className="rvs-banner warn rvs-conflict" role="alert">
                <div className="rvs-conflict-text">
                  <strong>{t('editor.conflictTitle')}</strong>{' '}
                  {conflictVersion(t, activeTab.conflict)}
                </div>
                <div className="rvs-conflict-actions">
                  <Btn onClick={() => { void showConflictDiff(activeTab) }}>{t('editor.conflictDiff')}</Btn>
                  <Btn onClick={() => { void reloadWithGuard(activeTab) }} disabled={offline}>{t('editor.conflictReload')}</Btn>
                  <Btn kind="danger" onClick={() => { void overwriteConflict(activeTab) }} disabled={offline}>{t('editor.conflictOverwrite')}</Btn>
                  <Btn onClick={() => { store.dismissConflict(activeTab.id); setConflictDiff(undefined) }}>{t('common.close')}</Btn>
                </div>
              </div>
            )}
            {/* The panel only exists while the CONFLICT does: resolving it (reload
                or overwrite) clears the state, and a diff against the old remote
                bytes would otherwise keep sitting there looking current. */}
            {conflictDiff !== undefined && activeTab.conflict !== undefined && conflictDiff.tabId === activeTab.id && (
              <div className="rvs-conflict-diff" role="region" aria-label={t('editor.conflictDiff')}>
                <div className="rvs-conflict-diff-head">
                  {conflictDiffNote(t, conflictDiff)}
                  {/* Which remote version the comparison is against: the panel is
                      read on demand, so the file may already have moved again. */}
                  {conflictDiff.remoteMtime !== null && ` · ${new Date(conflictDiff.remoteMtime).toLocaleString()}`}
                </div>
                {conflictDiff.hunks.slice(0, CONFLICT_DIFF_HUNKS).map((hunk, hunkIndex) => (
                  <div key={`hunk-${hunkIndex}`} className="rvs-conflict-hunk">
                    <div className="rvs-conflict-hunk-head">{`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}</div>
                    {hunk.lines.map((line, lineIndex) => (
                      <div
                        key={`line-${lineIndex}`}
                        className={`rvs-conflict-row${line.startsWith('+') ? ' add' : ''}${line.startsWith('-') ? ' del' : ''}`}
                      >
                        {line}
                      </div>
                    ))}
                  </div>
                ))}
                {conflictDiff.hunks.length > CONFLICT_DIFF_HUNKS && (
                  <div className="rvs-conflict-more">
                    {t('editor.conflictMoreHunks').replace('{count}', String(conflictDiff.hunks.length - CONFLICT_DIFF_HUNKS))}
                  </div>
                )}
              </div>
            )}
            {/*
              Change navigation lives on the editor itself (top-right, floating)
              rather than in the panel: once a file is open, that is where the
              caret is, and the panel may be collapsed or scrolled away.
            */}
            {activeTab.kind === 'file' && changeHunks.length > 0 && activeTab.changeStale !== true && (
              <div className="rvs-change-nav" role="group" aria-label={t('changes.navLabel')}>
                <span className="rvs-change-nav-count" title={t('changes.navLabel')}>
                  {Math.min((activeTab.activeHunk ?? 0) + 1, changeHunks.length)}/{changeHunks.length}
                </span>
                <button
                  type="button"
                  className="rvs-change-nav-btn"
                  title={t('changes.prev')}
                  aria-label={t('changes.prev')}
                  onClick={() => { gotoChange(activeTab.id, -1) }}
                >↑</button>
                <button
                  type="button"
                  className="rvs-change-nav-btn"
                  title={t('changes.next')}
                  aria-label={t('changes.next')}
                  onClick={() => { gotoChange(activeTab.id, 1) }}
                >↓</button>
              </div>
            )}
            {activeTab.loading && <div className="rvs-empty"><MiniSpinner /> {t('common.loading')}</div>}
            {offline && activeTab.error === undefined && activeTab.loading === false && (
              <div className="rvs-banner warn">
                {t('connection.editorReadOnly')}
                {activeTab.kind === 'file' && activeTab.dirty && ` ${t('connection.editorDirty')}`}
              </div>
            )}
            {!activeTab.loading && activeTab.error !== undefined && (
              <div className="rvs-banner error">
                {offline && isConnectionFailure(activeTab.error) ? t('connection.readFailed') : activeTab.error}
              </div>
            )}
            {!activeTab.loading && activeTab.error === undefined && activeTab.kind === 'diff' && (
              <DiffView tab={activeTab} visible={props.visible} offline={offline === true} />
            )}
            {!activeTab.loading && activeTab.error === undefined && activeTab.kind === 'file' && (
              <>
                {/* A capped read has no decodable payload: the preview component
                    turns that into a "too large" notice instead of the browser's
                    broken-image icon, so it is mounted for every image tab. */}
                {activeTab.image && (imageSrc !== undefined || activeTab.truncated) && (
                  <ImagePreview
                    src={imageSrc ?? ''}
                    path={activeTab.rel}
                    size={activeTab.remoteSize ?? 0}
                    {...(activeTab.truncated ? { truncated: true } : {})}
                    t={t}
                  />
                )}
                {activeTab.image && imageSrc === undefined && !activeTab.truncated && (
                  <div className="rvs-editor-notice">
                    <div>{imageFailure ?? t('common.loading')}</div>
                  </div>
                )}
                {!activeTab.image && isBytePreview(previewKind) && (
                  <BytePreview
                    alias={alias}
                    path={activeTab.fullPath}
                    sessionId={chatEnabled ? chat.sessionId : undefined}
                    kind={previewKind}
                    revision={activeTab.reloadNonce ?? 0}
                    t={t}
                  />
                )}
                {!activeTab.image && !activeTab.binary && activeTab.preview && previewKind === 'svg' && (
                  <SvgPreview
                    path={activeTab.rel}
                    text={previewText ?? ''}
                    truncated={activeTab.truncated}
                    t={t}
                  />
                )}
                {!activeTab.image && !activeTab.binary && activeTab.preview && previewKind === 'table' && (
                  <TablePreview
                    path={activeTab.rel}
                    text={previewText ?? ''}
                    truncated={activeTab.truncated}
                    t={t}
                  />
                )}
                {!activeTab.image && activeTab.binary && (
                  <div className="rvs-editor-notice">
                    <div className="rvs-editor-notice-title">{t('editor.binaryTitle')}</div>
                    <div>{activeTab.rel}</div>
                    <div>{t('editor.binary')}</div>
                  </div>
                )}
                {!activeTab.image && !activeTab.binary && activeTab.markdown && activeTab.preview && markdownPreview}
                {!activeTab.image && !activeTab.binary && activeTab.html && activeTab.preview && (
                  <div className="rvs-preview-frame-wrap">
                    {activeTab.truncated && <div className="rvs-preview-banner">{t('preview.truncated')}</div>}
                    <iframe className="rvs-html-frame" title={activeTab.rel} sandbox="" srcDoc={htmlDoc} />
                  </div>
                )}
                {/* The editor host stays MOUNTED and is hidden with CSS in
                    preview mode. Unmounting it (the old behaviour) rebuilt the
                    buffer from `activeTab.text` on every preview round-trip —
                    `activeTab.text` is never updated by typing, so the edits
                    silently reverted, the dirty flag lied, and the save path
                    lost its live buffer. Hiding keeps buffer, undo history and
                    caret across preview/source switches, and sibling surfaces
                    (the image/HTML previews) end up in the same DOM positions
                    as before, so their own remount behaviour is unchanged. */}
                {!activeTab.image && !activeTab.binary && !isBytePreview(previewKind) && (
                  <div
                    className={`rvs-editor-host${activeTab.preview && hasTextSource(previewKind) ? ' rvs-hidden' : ''}`}
                  >
                    {activeTab.truncated && <div className="rvs-banner warn">{t('editor.truncated')}</div>}
                    <CodeEditor
                      key={editorKey(activeTab)}
                      ref={editorRef}
                      initial={activeTab.text}
                      savedText={activeTab.baseline}
                      path={activeTab.fullPath}
                      tabId={activeTab.id}
                      readOnly={activeTab.truncated || offline}
                      visible={props.visible}
                      wrap={settings.wrap}
                      ctx={store.ctx}
                      sessionId={chat.sessionId}
                      remoteRoot={store.repoRoot ?? store.root}
                      chatEnabled={chatEnabled}
                      addLabel={t('files.addToConversation')}
                      {...(activeTab.line === undefined ? {} : { revealLine: activeTab.line })}
                      {...(activeTab.lineNonce === undefined ? {} : { revealNonce: activeTab.lineNonce })}
                      {...(activeTab.changeSet === undefined ? {} : { changeSet: activeTab.changeSet })}
                      blame={blameOn ? blameRows : undefined}
                      onOpenBlame={(entry) => { store.focusCommit(entry.hash) }}
                      onViewport={onEditorViewport}
                      {...(activeTab.revealHunkLine === undefined ? {} : { revealHunkLine: activeTab.revealHunkLine })}
                      {...(activeTab.revealHunkNonce === undefined ? {} : { revealHunkNonce: activeTab.revealHunkNonce })}
                      {...(editorViewStateOf(activeTab.id) === undefined
                        ? {}
                        : { viewState: editorViewStateOf(activeTab.id) })}
                      onTokens={setTokenCount}
                      onCaretChange={setCaret}
                      onViewState={rememberViewState}
                      onStepHunk={(dir) => { gotoChange(activeTab.id, dir) }}
                      onChangeStale={() => { markChangeStale(activeTab.id) }}
                      onUndoChange={(mark) => { void undoChange(activeTab.id, mark) }}
                      undoLabel={(mark) => undoActionLabel(t, mark.kind)}
                      undoTriggerLabel={() => t('changes.actions')}
                      {...(blockConfirm === undefined ? {} : { blockConfirm })}
                      onSave={() => { void saveActive() }}
                      onDirty={(dirty) => store.updateTab(activeTab.id, { dirty })}
                      onBuffer={(tabId, text) => store.updateTab(tabId, { text })}
                    />
                  </div>
                )}
              </>
            )}
          </div>

          {/* Status bar: full-width variant only, matching the reference editor. */}
          {center && (
            <StatusBar
              t={t}
              diff={isDiff}
              caret={caret}
              language={language}
              indent={indentLabel}
              wrap={settings.wrap}
              fontSize={settings.fontSize}
              readOnly={activeTab.kind === 'file' && (activeTab.binary || activeTab.truncated || offline)}
              dirty={activeTab.dirty}
              loading={activeTab.loading}
              saving={activeTab.saving}
              error={activeTab.error}
            />
          )}
        </>
      )}
    </div>
  )
}
