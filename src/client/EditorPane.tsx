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
import { api } from './api.ts'
import { CodeEditor, type CodeEditorHandle, type CodeEditorViewState } from './CodeEditor.tsx'
import { sameLocalDir } from './composer.ts'
import { useRemoteChatTarget } from './use-remote-chat-target.ts'
import { useExplorer, gotoChange, markChangeStale, undoChange, type EditorTab } from './store.tsx'
import { DiffView } from './scm/DiffView.tsx'
import { renderMarkdown } from './vsc/markdown.tsx'
import { langLabel, langFromPath } from './vsc/tokenize.ts'
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
   * The editor REPORTS its position (see `CodeEditor`'s `onViewState`) instead
   * of this component reading it back through `editorRef`, because the ref is
   * already `null` by the time any cleanup here could run: React clears a
   * child's ref before running the parent's cleanup. Both earlier attempts
   * failed on exactly that — a `useEffect` keyed on the active tab captured the
   * INCOMING tab's editor (always scrollTop 0), and a `useLayoutEffect` cleanup
   * found `editorRef.current === null`. `.spike/tabswitch-check.mjs` reproduces
   * both failures and pins the working wiring.
   *
   * Keyed by tab id alone, which is safe because only ONE `EditorPane` is ever
   * mounted: the centre surface when the host has a `conversation.view` slot,
   * otherwise the sidebar fallback. With two live editors for the same tab the
   * hidden one would report its untouched scrollTop 0 and overwrite the visible
   * one's, snapping every switch back to the top — so `RemoteRoot` gates both
   * mounts on `editorSurface` and must keep doing so.
   */
  const viewStates = useRef(new Map<string, CodeEditorViewState>())
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
    viewStates.current.set(tabId, state)
  }, [])

  /**
   * Closed tabs may not keep their scroll + caret. This map is keyed by tab id
   * and was only ever written, and the pane is mounted for the life of the
   * page: a session that opened a few hundred files held a state object for
   * every one of them, long after the tab was gone.
   */
  useEffect(() => {
    const live = new Set(tabs.map(tab => tab.id))
    for (const id of [...viewStates.current.keys()]) {
      if (!live.has(id)) viewStates.current.delete(id)
    }
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

  const saveActive = async (): Promise<void> => {
    const tab = activeTab
    if (tab === undefined) return
    const text = editorRef.current?.getContent()
    if (text === undefined) {
      // Never let the store fall back to stale text: that destroys the edit.
      toast(t('editor.needSource'), true)
      return
    }
    await store.saveTab(tab.id, text)
  }

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
                <IconButton title={t('scm.reloadDiff')} onClick={() => { void store.reloadTab(activeTab.id) }} disabled={activeTab.loading}>
                  <IconRefresh size={13} />
                </IconButton>
                <IconButton
                  title={`${t('editor.save')} (Ctrl+S)`}
                  onClick={() => { void saveActive() }}
                  disabled={activeTab.loading || activeTab.binary || activeTab.truncated || !activeTab.dirty}
                >
                  <IconSave size={13} />
                </IconButton>
              </>
            )}
            {activeTab.kind === 'diff' && (
              <IconButton title={t('scm.reloadDiff')} onClick={() => { void store.reloadTab(activeTab.id) }}>
                <IconRefresh size={13} />
              </IconButton>
            )}
          </div>
          <div className="rvs-body">
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
            {!activeTab.loading && activeTab.error !== undefined && <div className="rvs-banner error">{activeTab.error}</div>}
            {!activeTab.loading && activeTab.error === undefined && activeTab.kind === 'diff' && (
              <DiffView tab={activeTab} visible={props.visible} />
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
                      path={activeTab.fullPath}
                      tabId={activeTab.id}
                      readOnly={activeTab.truncated}
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
                      {...(viewStates.current.get(activeTab.id) === undefined
                        ? {}
                        : { viewState: viewStates.current.get(activeTab.id) })}
                      onTokens={setTokenCount}
                      onViewState={rememberViewState}
                      onStepHunk={(dir) => { gotoChange(activeTab.id, dir) }}
                      onChangeStale={() => { markChangeStale(activeTab.id) }}
                      onUndoChange={(mark) => { void undoChange(activeTab.id, mark) }}
                      undoLabel={(mark) => undoActionLabel(t, mark.kind)}
                      onSave={() => { void saveActive() }}
                      onDirty={(dirty) => store.updateTab(activeTab.id, { dirty })}
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
