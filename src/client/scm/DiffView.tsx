/**
 * Side-by-side diff: full file on both sides, real line numbers, added /
 * removed tinting and per-hunk stage / revert.
 *
 * The pairing comes from git (see `scm/diff-model`), so the two panes are
 * always aligned row for row. Hunk buttons are only rendered where a patch
 * can legally be applied: a worktree diff can be staged or reverted, an
 * already-staged diff can only be un-staged. 变更后 switches to a real
 * CodeMirror buffer so the file can be edited in place.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { EditorTab } from '../store.tsx'
import { useExplorer } from '../store.tsx'
import { applyHunk, GitOpError } from './actions.ts'
import { diffCounts } from './diff-model.ts'
import { api } from '../api.ts'
import { CodeEditor, type CodeEditorHandle } from '../CodeEditor.tsx'
import { sameLocalDir } from '../composer.ts'
import { useRemoteChatTarget } from '../use-remote-chat-target.ts'
import { langFromPath, tokenizeDocument, type Token } from '../vsc/tokenize.ts'
import {
  IconButton,
  IconRefresh,
  IconSave,
  MiniSpinner,
  Segmented,
  baseName,
  toast,
} from '../vsc/kit.tsx'

type ViewMode = 'split' | 'before' | 'after'

/** Render one tokenized line. */
function Line(props: { tokens: Token[]; empty?: boolean }): ReactNode {
  if (props.empty === true) return <span className="rvs-row-empty">{'\u00a0'}</span>
  return (
    <>
      {props.tokens.map((token, index) => (
        <span key={index} className={token.kind === 'plain' ? undefined : `rvs-t-${token.kind}`}>{token.text}</span>
      ))}
    </>
  )
}

/**
 * The top horizontal scrollbar: a scroll container whose only content is a
 * spacer as wide as the widest pane. Dragging it drives both panes, so the
 * user never has to scroll to the bottom of a file to reach a long line's
 * horizontal bar.
 */
function HScrollBar(props: {
  barRef: React.RefObject<HTMLDivElement>
  width: number
  onScroll: (left: number) => void
}): ReactNode {
  return (
    <div
      className="rvs-hbar"
      ref={props.barRef}
      onScroll={(e) => props.onScroll(e.currentTarget.scrollLeft)}
    >
      <div className="rvs-hbar-inner" style={{ width: props.width }} />
    </div>
  )
}

/** i18n key per hunk action (a map, not a nested ternary). */
const HUNK_TOAST_KEY: Record<'stage' | 'unstage' | 'revert', string> = {
  stage: 'scm.hunkStaged',
  unstage: 'scm.hunkUnstaged',
  revert: 'scm.hunkReverted',
}

export function DiffView(props: { tab: EditorTab; visible: boolean }): ReactNode {
  const store = useExplorer()
  const { t, lang } = store
  const tab = props.tab
  const [busy, setBusy] = useState(false)
  const [hunkBusy, setHunkBusy] = useState<number | undefined>(undefined)
  const [mode, setMode] = useState<ViewMode>(tab.view === 'before' || tab.view === 'after' ? tab.view : 'split')
  const [editBuffer, setEditBuffer] = useState<string | undefined>(undefined)
  const [, forceRender] = useState(0)
  const editorRef = useRef<CodeEditorHandle>(null)
  const leftRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)
  const hbarRef = useRef<HTMLDivElement>(null)
  const [barWidth, setBarWidth] = useState(0)

  /**
   * Measure the widest pane and size the top bar's spacer to it. Runs after
   * every model change and on container resizes (a pane that is empty until
   * its fonts settle would otherwise leave the bar too short).
   */
  useLayoutEffect(() => {
    if (mode !== 'split') return
    const measure = (): void => {
      const widest = Math.max(leftRef.current?.scrollWidth ?? 0, rightRef.current?.scrollWidth ?? 0)
      setBarWidth(widest)
    }
    measure()
    const timer = window.setTimeout(measure, 80)
    window.addEventListener('resize', measure)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('resize', measure)
    }
  }, [mode, tab.id, tab.diff])

  /** Bar → both panes. */
  const syncFromBar = useCallback((left: number): void => {
    for (const pane of [leftRef.current, rightRef.current]) {
      if (pane !== null && pane.scrollLeft !== left) pane.scrollLeft = left
    }
  }, [])

  /** Pane (trackpad / shift-wheel) → the bar and the sibling pane. */
  const syncFromPane = useCallback((event: React.UIEvent<HTMLDivElement>): void => {
    const left = event.currentTarget.scrollLeft
    const bar = hbarRef.current
    if (bar !== null && bar.scrollLeft !== left) bar.scrollLeft = left
    for (const pane of [leftRef.current, rightRef.current]) {
      if (pane !== null && pane !== event.currentTarget && pane.scrollLeft !== left) pane.scrollLeft = left
    }
  }, [])

  // Selection→conversation stays available in the editable pane, exactly like
  // the file editor: it needs the on-screen session AND the same binding.
  const chat = useRemoteChatTarget(store.ctx)
  const viewedAliasPath = store.workspace !== undefined ? store.aliasPaths[store.workspace.id] : undefined
  const chatEnabled = chat.sessionId !== undefined
    && chat.sessionWorkspacePath !== undefined
    && viewedAliasPath !== undefined
    && sameLocalDir(chat.sessionWorkspacePath, viewedAliasPath)

  // Seed the editable buffer the first time the "变更后" pane is shown.
  useEffect(() => {
    if (mode !== 'after' || tab.staged || tab.text !== '' || tab.loading) return
    let cancelled = false
    void (async () => {
      try {
        const read = await api.fileOp.read(store.alias, tab.fullPath)
        if (cancelled) return
        setEditBuffer(read.binary ? '' : (read.text ?? ''))
      } catch {
        if (!cancelled) setEditBuffer('')
      }
    })()
    return () => { cancelled = true }
  }, [mode, tab.staged, tab.text, tab.loading, tab.fullPath, store.alias])

  const sideLang = useMemo(() => langFromPath(tab.rel), [tab.rel])
  const model = tab.model
  const counts = useMemo(() => (model === undefined ? { added: 0, removed: 0 } : diffCounts(model)), [model])
  const beforeLines = useMemo(
    () => (model === undefined ? [] : tokenizeDocument(tab.diff?.oldText ?? '', sideLang)),
    [model, tab.diff?.oldText, sideLang],
  )
  const afterLines = useMemo(
    () => (model === undefined ? [] : tokenizeDocument(tab.diff?.newText ?? '', sideLang)),
    [model, tab.diff?.newText, sideLang],
  )

  const runHunk = async (index: number, kind: 'stage' | 'unstage' | 'revert'): Promise<void> => {
    const hunk = model?.hunks.find(item => item.index === index)
    if (hunk === undefined || store.repoRoot === undefined) return
    setHunkBusy(index)
    try {
      await applyHunk(store.alias, store.repoRoot, hunk.patch, kind)
      await store.afterWrite()
      await store.reloadTab(tab.id)
      toast(t(HUNK_TOAST_KEY[kind]))
    } catch (error) {
      toast(error instanceof GitOpError || error instanceof Error ? error.message : String(error), true)
    } finally {
      setHunkBusy(undefined)
    }
  }

  const reload = async (): Promise<void> => {
    setBusy(true)
    await store.reloadTab(tab.id)
    setBusy(false)
  }

  const saveAfter = async (): Promise<void> => {
    // The editable pane is a CodeMirror buffer: read it imperatively so the
    // write carries the live text, then persist through the same route the
    // file editor uses and reload the diff from the new working tree.
    const text = editorRef.current?.getContent() ?? editBuffer
    if (text === undefined) return
    setEditBuffer(text)
    store.updateTab(tab.id, { text })
    await store.saveTab(tab.id, text)
    await store.reloadTab(tab.id)
  }

  if (tab.error !== undefined) {
    return (
      <div className="rvs-diff">
        <div className="rvs-banner error">{tab.error}</div>
        <div style={{ padding: 8 }}>
          <button type="button" className="rvs-chip" onClick={() => { void reload() }}>{t('scm.retry')}</button>
        </div>
      </div>
    )
  }
  if (tab.loading) {
    return <div className="rvs-empty"><MiniSpinner /> {t('common.loading')}</div>
  }
  if (tab.binary) {
    return <div className="rvs-empty">{t('scm.binaryDiff')}</div>
  }
  if (model === undefined || model.empty) {
    return (
      <div className="rvs-diff">
        <div className="rvs-empty">{t('scm.noDiff')}</div>
      </div>
    )
  }

  const editable = mode === 'after' && !tab.staged

  return (
    <div className="rvs-diff">
      <div className="rvs-diff-toolbar">
        <Segmented<ViewMode>
          value={mode}
          onChange={(next) => { setMode(next); store.updateTab(tab.id, { view: next }) }}
          options={[
            { id: 'split', label: t('scm.sideBySide') },
            { id: 'before', label: t('scm.before') },
            { id: 'after', label: editable ? t('scm.afterEditable') : t('scm.after') },
          ]}
        />
        <span style={{ color: 'var(--rvs-git-a)' }}>+{counts.added}</span>
        <span style={{ color: 'var(--rvs-git-d)' }}>-{counts.removed}</span>
        {tab.staged && <span className="rvs-pill">{t('scm.stagedReadonly')}</span>}
        <span className="rvs-einfo-spacer" />
        {busy && <MiniSpinner />}
        <IconButton title={t('scm.reloadDiff')} onClick={() => { void reload() }} disabled={busy}>
          <IconRefresh size={13} />
        </IconButton>
        {editable && (
          <IconButton title={`${t('editor.save')} (Ctrl+S)`} onClick={() => { void saveAfter() }}>
            <IconSave size={13} />
          </IconButton>
        )}
      </div>
      {mode === 'split' && (
        <>
          <HScrollBar barRef={hbarRef} width={barWidth} onScroll={syncFromBar} />
          <div className="rvs-diff-grid">
            <div className="rvs-diff-cols">
              {/* Left pane: fixed 50% (see .rvs-diff-col) with its own hidden
                  horizontal scroll, driven from the bar above. */}
              <div className="rvs-diff-col" ref={leftRef} onScroll={syncFromPane}>
                {model.rows.map(row => (
                  <div key={row.id} className={`rvs-dline${row.oldDel ? ' rvs-row-del' : ''}`}>
                    <span className="rvs-dline-num">{row.oldNum ?? ''}</span>
                    <span className="rvs-dline-text">
                      {row.old === ''
                        ? <span className="rvs-row-empty">{'\u00a0'}</span>
                        : <Line tokens={beforeLines[(row.oldNum ?? 1) - 1] ?? [{ text: row.old, kind: 'plain' }]} />}
                    </span>
                  </div>
                ))}
              </div>
              <div className="rvs-gutter-col">
                {model.rows.map(row => {
                  const hunk = row.hunk >= 0 ? model.hunks.find(item => item.index === row.hunk) : undefined
                  const startOfHunk = hunk !== undefined && hunk.startRow === row.id
                  return (
                    <div key={row.id} className="rvs-gutter-line">
                      {startOfHunk && hunk !== undefined && (
                        <span className="rvs-hunk-btns">
                          {hunkBusy === hunk.index
                            ? <MiniSpinner />
                            : (
                              <>
                                <button
                                  type="button"
                                  className="rvs-hunk-btn stage"
                                  title={tab.staged ? t('scm.unstageHunk') : t('scm.stageHunk')}
                                  onClick={() => { void runHunk(hunk.index, tab.staged ? 'unstage' : 'stage') }}
                                >
                                  {tab.staged ? '↧' : '⤒'}
                                </button>
                                {!tab.staged && (
                                  <button
                                    type="button"
                                    className="rvs-hunk-btn revert"
                                    title={t('scm.revertHunk')}
                                    onClick={() => { void runHunk(hunk.index, 'revert') }}
                                  >
                                    ↩
                                  </button>
                                )}
                              </>
                            )}
                        </span>
                      )}
                      {!startOfHunk && (row.oldDel || row.newAdd) && (
                        <span className="rvs-gutter-dot" style={{ background: row.oldDel ? 'var(--rvs-git-d)' : 'var(--rvs-git-a)' }} />
                      )}
                    </div>
                  )
                })}
              </div>
              <div className="rvs-diff-col" ref={rightRef} onScroll={syncFromPane}>
                {model.rows.map(row => (
                  <div key={row.id} className={`rvs-dline${row.newAdd ? ' rvs-row-add' : ''}`}>
                    <span className="rvs-dline-num">{row.newNum ?? ''}</span>
                    <span className="rvs-dline-text">
                      {row.inNew === false || row.new === ''
                        ? <span className="rvs-row-empty">{'\u00a0'}</span>
                        : <Line tokens={afterLines[(row.newNum ?? 1) - 1] ?? [{ text: row.new, kind: 'plain' }]} />}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
      {mode === 'before' && (
        <div className="rvs-code rvs-scroll">
          {beforeLines.length === 0
            ? <div className="rvs-empty">{t('scm.emptySide')}</div>
            : beforeLines.map((tokens, index) => (
              <div key={index} className="rvs-code-line">
                <span className="rvs-num">{index + 1}</span>
                <span className="rvs-code-text"><Line tokens={tokens} /></span>
              </div>
            ))}
        </div>
      )}
      {mode === 'after' && (
        tab.staged
          ? (
            <div className="rvs-code rvs-scroll">
              {afterLines.map((tokens, index) => (
                <div key={index} className="rvs-code-line">
                  <span className="rvs-num">{index + 1}</span>
                  <span className="rvs-code-text"><Line tokens={tokens} /></span>
                </div>
              ))}
            </div>
          )
          : (
            <div className="rvs-editor-host">
              <CodeEditor
                key={`${tab.id}:edit`}
                ref={editorRef}
                initial={editBuffer ?? tab.diff?.newText ?? ''}
                path={tab.fullPath}
                visible={props.visible}
                ctx={store.ctx}
                sessionId={chat.sessionId}
                remoteRoot={store.repoRoot ?? store.root}
                chatEnabled={chatEnabled}
                addLabel={t('files.addToConversation')}
                onSave={() => { void saveAfter() }}
                onDirty={(dirty) => {
                  store.updateTab(tab.id, { dirty })
                  forceRender(n => n + 1)
                }}
              />
            </div>
          )
        )}
    </div>
  )
}
