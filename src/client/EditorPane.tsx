/**
 * The editor area: one tab strip for code files, previews and diffs, an info
 * row, and the body dispatch.
 *
 * The `@文件` insertion and the selection→conversation popup are preserved
 * from the previous editor: `CodeEditor` still receives the chat target, and
 * every code pane is the same CodeMirror buffer with Ctrl+S wired to the
 * remote write route.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, fileReadTimeoutMs } from './api.ts'
import { clientDeadlineFor } from '../timeouts.ts'
import { diffText, type TextHunk } from '../changes/text-diff.ts'
import { CodeEditor, type CodeEditorHandle, type CodeEditorViewState } from './CodeEditor.tsx'
import { ConnectionStatusChip } from './ConnectionStatus.tsx'
import { isConnectionFailure, useConnectionStatus } from './connection.ts'
import { sameLocalDir } from './composer.ts'
import { editorViewStateOf, pruneEditorViewStates, registerLiveEditor, rememberEditorViewState } from './live-editor.ts'
import { useRemoteChatTarget } from './use-remote-chat-target.ts'
import { useExplorer, gotoChange, markChangeStale, undoChange, type EditorTab } from './store.tsx'
import { DiffView } from './scm/DiffView.tsx'
import { Btn } from './ui.tsx'
import { renderMarkdown } from './vsc/markdown.tsx'
import { langLabel, langFromPath } from './vsc/tokenize.ts'
import { installSaveShortcut } from './vsc/save-shortcut.ts'
import {
  IconButton,
  IconClose,
  IconDiff,
  IconRefresh,
  IconSave,
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
  if (tab.kind === 'diff') return <IconDiff size={12} />
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

export function EditorPane(props: { visible: boolean }): ReactNode {
  const store = useExplorer()
  const { t, tabs, activeTab, alias } = store
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
    if (images[tab.fullPath] !== undefined || imageError[tab.fullPath] !== undefined) return
    let cancelled = false
    void (async () => {
      try {
        const read = await api.fileOp.read(alias, tab.fullPath)
        if (cancelled) return
        if (read.base64 === undefined) {
          setImageError(prev => rememberRecent(prev, tab.fullPath, t('editor.imageFailed')))
          return
        }
        setImages(prev => rememberRecent(prev, tab.fullPath, `data:${mimeFor(tab.fullPath)};base64,${read.base64}`))
      } catch (error) {
        if (!cancelled) {
          setImageError(prev => rememberRecent(prev, tab.fullPath, error instanceof Error ? error.message : String(error)))
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
    setImages(prev => dropOversized(prev, activeTab?.fullPath))
  }, [activeTab?.fullPath])

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

  const htmlDoc = useMemo(() => {
    if (activeTab === undefined || !activeTab.html) return ''
    return activeTab.text
  }, [activeTab])

  /**
   * The parsed Markdown preview.
   *
   * It used to be `renderMarkdown(activeTab.text)` inline in the JSX, which
   * re-parsed the whole document into a fresh element tree on EVERY store
   * publish: this component subscribes to the store, so opening another file,
   * saving, a git refresh or switching a panel all paid for a parse of text
   * that had not changed. `renderMarkdown` is a pure function of the text, and
   * a tab's identity changes when its text does (`updateTab`/`reloadTab` patch
   * the tab), so the tab is what Memo compares — the same key the `htmlDoc`
   * memo above uses. The markdown/preview guards keep the parse from happening
   * at all for a file that is being read in source mode.
   */
  const markdownPreview = useMemo(() => {
    if (activeTab === undefined || !activeTab.markdown || !activeTab.preview) return null
    return renderMarkdown(activeTab.text)
  }, [activeTab])

  // The editor owns the live buffer; the save path pulls it imperatively
  // instead of mirroring every keystroke into React state.
  const editorRef = useRef<CodeEditorHandle>(null)

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
      if (tab === undefined || tab.kind !== 'file' || tab.image || tab.binary) return undefined
      return () => { void saveActiveRef.current() }
    })
  }, [props.visible])

  if (tabs.length === 0) {
    return (
      <div className="rvs-pane grow rvs-edge">
        <div className="rvs-empty">
          {t('editor.empty')}
          <div style={{ marginTop: 8, fontSize: 11 }}>
            <span className="rvs-kbd">Ctrl</span> + <span className="rvs-kbd">S</span> {t('editor.saveHint')}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="rvs-pane grow rvs-edge">
      <div className="rvs-etabs" role="tablist">
        {tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === store.activeTabId}
            className={`rvs-etab${tab.id === store.activeTabId ? ' active' : ''}`}
            title={tab.kind === 'diff' ? `${tab.rel} (diff)` : tab.fullPath}
            onClick={() => store.activateTab(tab.id)}
            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); void closeWithGuard(tab) } }}
          >
            <span className="rvs-node-icon" style={{ width: 14, height: 14 }}>
              {tabIcon(tab)}
            </span>
            <span className="rvs-etab-name">
              {baseName(tab.rel)}
              {tab.kind === 'diff' && <span style={{ opacity: .6 }}> · diff</span>}
            </span>
            {tab.dirty && <span className="rvs-etab-dot" title={t('editor.unsaved')}>●</span>}
            <span
              className="rvs-etab-close"
              role="presentation"
              title={t('common.close')}
              onClick={(e) => { e.stopPropagation(); void closeWithGuard(tab) }}
            >
              <IconClose size={11} />
            </span>
          </button>
        ))}
      </div>
      {activeTab !== undefined && (
        <>
          <div className="rvs-einfo">
            <span className="rvs-einfo-path" title={activeTab.fullPath}>{activeTab.fullPath}</span>
            <span className="rvs-einfo-spacer" />
            {activeTab.kind === 'file' && (activeTab.markdown || activeTab.html) && (
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
              <span style={{ color: 'var(--rvs-fg3)' }}>
                {activeTab.staged && activeTab.ref === undefined ? t('scm.stagedReadonly') : ''}
                {activeTab.ref !== undefined ? `${t('scm.commitDiff')} ${activeTab.ref.slice(0, 7)}` : ''}
              </span>
            )}
            <span style={{ color: 'var(--rvs-fg3)' }}>{langLabel(langFromPath(activeTab.rel))}</span>
            {/* Connection health sits where the build stamp does: it is the
                surface the user is looking at while they work. */}
            <ConnectionStatusChip compact />
            {/* Build stamp + token count (see tsdown `define.__RVS_BUILD__`).
                The GUI serves plugin bundles captured when `dsh web` started,
                so the stamp says WHICH code is running, and the token count
                says whether the grammar actually produced colored tokens. */}
            <span className="rvs-build" title={`dsh-remote-vs build ${__RVS_BUILD__}`}>{__RVS_BUILD__}</span>
            {tokenCount !== undefined && (
              <span className="rvs-build" title={t('editor.tokenCount')}>tok {tokenCount}</span>
            )}
            {activeTab.kind === 'file' && (
              <>
                {/* The status chip used to be a four-deep nested ternary in
                    both the class and the label, while the project's own
                    review checklist forbids nested ternaries. One lookup per
                    concern instead. */}
                <span className={`rvs-status ${tabStatusClass(activeTab)}`}>
                  {t(tabStatusKey(activeTab))}
                </span>
                <IconButton title={t('editor.reloadFile')} onClick={() => { void reloadWithGuard(activeTab) }} disabled={offline || activeTab.loading}>
                  <IconRefresh size={13} />
                </IconButton>
                <IconButton
                  title={`${t('editor.save')} (Ctrl+S)`}
                  onClick={() => { void saveActive() }}
                  disabled={offline || activeTab.loading || activeTab.binary || activeTab.truncated || !activeTab.dirty}
                >
                  <IconSave size={13} />
                </IconButton>
              </>
            )}
            {activeTab.kind === 'diff' && (
              <IconButton title={t('scm.reloadDiff')} onClick={() => { void reloadWithGuard(activeTab) }} disabled={offline}>
                <IconRefresh size={13} />
              </IconButton>
            )}
          </div>
          <div className="rvs-body">
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
                {activeTab.image && (
                  <div className="rvs-preview-img">
                    {images[activeTab.fullPath] !== undefined
                      ? <img src={images[activeTab.fullPath]} alt={activeTab.rel} draggable={false} onDragStart={(e) => e.preventDefault()} />
                      : <span className="rvs-empty">{imageError[activeTab.fullPath] ?? t('common.loading')}</span>}
                  </div>
                )}
                {!activeTab.image && activeTab.binary && <div className="rvs-empty">{t('editor.binary')}</div>}
                {!activeTab.image && !activeTab.binary && activeTab.markdown && activeTab.preview && markdownPreview}
                {!activeTab.image && !activeTab.binary && activeTab.html && activeTab.preview && (
                  <iframe className="rvs-html-frame" title={activeTab.rel} sandbox="allow-same-origin" srcDoc={htmlDoc} />
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
                {!activeTab.image && !activeTab.binary && (
                  <div
                    className={`rvs-editor-host${activeTab.preview && (activeTab.markdown || activeTab.html) ? ' rvs-hidden' : ''}`}
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
                      ctx={store.ctx}
                      sessionId={chat.sessionId}
                      remoteRoot={store.repoRoot ?? store.root}
                      chatEnabled={chatEnabled}
                      addLabel={t('files.addToConversation')}
                      {...(activeTab.line === undefined ? {} : { revealLine: activeTab.line })}
                      {...(activeTab.lineNonce === undefined ? {} : { revealNonce: activeTab.lineNonce })}
                      {...(activeTab.changeSet === undefined ? {} : { changeSet: activeTab.changeSet })}
                      {...(activeTab.revealHunkLine === undefined ? {} : { revealHunkLine: activeTab.revealHunkLine })}
                      {...(activeTab.revealHunkNonce === undefined ? {} : { revealHunkNonce: activeTab.revealHunkNonce })}
                      {...(editorViewStateOf(activeTab.id) === undefined
                        ? {}
                        : { viewState: editorViewStateOf(activeTab.id) })}
                      onTokens={setTokenCount}
                      onViewState={rememberViewState}
                      onStepHunk={(dir) => { gotoChange(activeTab.id, dir) }}
                      onChangeStale={() => { markChangeStale(activeTab.id) }}
                      onUndoChange={(mark) => { void undoChange(activeTab.id, mark) }}
                      undoLabel={(mark) => undoActionLabel(t, mark.kind)}
                      onSave={() => { void saveActive() }}
                      onDirty={(dirty) => store.updateTab(activeTab.id, { dirty })}
                      onBuffer={(tabId, text) => store.updateTab(tabId, { text })}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
