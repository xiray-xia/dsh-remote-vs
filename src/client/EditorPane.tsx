/**
 * The editor area: one tab strip for code files, previews and diffs, an info
 * row, and the body dispatch.
 *
 * The `@文件` insertion and the selection→conversation popup are preserved
 * from the previous editor: `CodeEditor` still receives the chat target, and
 * every code pane is the same CodeMirror buffer with Ctrl+S wired to the
 * remote write route.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from './api.ts'
import { CodeEditor, type CodeEditorHandle } from './CodeEditor.tsx'
import { sameLocalDir } from './composer.ts'
import { useRemoteChatTarget } from './use-remote-chat-target.ts'
import { useExplorer, type EditorTab } from './store.tsx'
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
} from './vsc/kit.tsx'

export function EditorPane(props: { visible: boolean }): ReactNode {
  const store = useExplorer()
  const { t, tabs, activeTab, alias } = store
  const chat = useRemoteChatTarget(store.ctx)
  const viewedAliasPath = store.workspace !== undefined ? store.aliasPaths[store.workspace.id] : undefined
  const chatEnabled = chat.sessionId !== undefined
    && chat.sessionWorkspacePath !== undefined
    && viewedAliasPath !== undefined
    && sameLocalDir(chat.sessionWorkspacePath, viewedAliasPath)

  // Image data URL cache, keyed by path (remote reads are not free).
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
    if (tab === undefined || !tab.image || alias === '') return
    if (images[tab.fullPath] !== undefined || imageError[tab.fullPath] !== undefined) return
    let cancelled = false
    void (async () => {
      try {
        const read = await api.fileOp.read(alias, tab.fullPath)
        if (cancelled) return
        if (read.base64 === undefined) {
          setImageError(prev => ({ ...prev, [tab.fullPath]: t('editor.imageFailed') }))
          return
        }
        setImages(prev => ({ ...prev, [tab.fullPath]: `data:${mimeFor(tab.fullPath)};base64,${read.base64}` }))
      } catch (error) {
        if (!cancelled) {
          setImageError(prev => ({ ...prev, [tab.fullPath]: error instanceof Error ? error.message : String(error) }))
        }
      }
    })()
    return () => { cancelled = true }
  }, [activeTab, alias, images, imageError, t])

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

  // The editor owns the live buffer; the save path pulls it imperatively
  // instead of mirroring every keystroke into React state.
  const editorRef = useRef<CodeEditorHandle>(null)
  const saveActive = async (): Promise<void> => {
    const tab = activeTab
    if (tab === undefined) return
    const text = editorRef.current?.getContent()
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
              {tab.kind === 'diff' ? <IconDiff size={12} /> : tab.image ? <span>▣</span> : <span>▪</span>}
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
                <span className={`rvs-status ${activeTab.loading ? 'saving' : activeTab.saving ? 'saving' : activeTab.dirty ? 'dirty' : 'saved'}`}>
                  {activeTab.loading
                    ? t('common.loading')
                    : activeTab.saving
                      ? t('editor.saving')
                      : activeTab.dirty ? t('editor.unsaved') : t('editor.saved')}
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
                {!activeTab.image && !activeTab.binary && activeTab.markdown && activeTab.preview && renderMarkdown(activeTab.text)}
                {!activeTab.image && !activeTab.binary && activeTab.html && activeTab.preview && (
                  <iframe className="rvs-html-frame" title={activeTab.rel} sandbox="allow-scripts" srcDoc={htmlDoc} />
                )}
                {!activeTab.image && !activeTab.binary && !(activeTab.preview && (activeTab.markdown || activeTab.html)) && (
                  <div className="rvs-editor-host">
                    {activeTab.truncated && <div className="rvs-banner warn">{t('editor.truncated')}</div>}
                    <CodeEditor
                      key={activeTab.id}
                      ref={editorRef}
                      initial={activeTab.text}
                      path={activeTab.fullPath}
                      readOnly={activeTab.truncated}
                      visible={props.visible}
                      ctx={store.ctx}
                      sessionId={chat.sessionId}
                      remoteRoot={store.repoRoot ?? store.root}
                      chatEnabled={chatEnabled}
                      addLabel={t('files.addToConversation')}
                      {...(activeTab.line === undefined ? {} : { revealLine: activeTab.line })}
                      {...(activeTab.lineNonce === undefined ? {} : { revealNonce: activeTab.lineNonce })}
                      onTokens={setTokenCount}
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
