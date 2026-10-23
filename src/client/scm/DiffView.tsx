/**
 * Side-by-side diff: full file on both sides, real line numbers, added /
 * removed tinting and per-hunk stage / revert.
 *
 * The pairing comes from git (see `scm/diff-model`), so the two panes are
 * always aligned row for row. Hunk buttons are only rendered where a patch
 * can legally be applied: a worktree diff can be staged or reverted, an
 * already-staged diff can only be un-staged. 变更后 switches to a real
 * CodeMirror buffer so the file can be edited in place.
 *
 * The row count is the WHOLE file, so the split mode is windowed (see
 * `useRowWindow`): before that, a 3000-line file put 9000 line containers and
 * ~2N tokenized lines in the DOM at once, and every store publish rebuilt all
 * of them. Note which element scrolls: the two panes only own their HORIZONTAL
 * scroll (`.rvs-diff-col`), while vertical scrolling belongs to `.rvs-diff-grid`
 * outside them — so ONE window serves all three columns and no column can
 * drift out of lockstep with another.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { EditorTab } from '../store.tsx'
import { useExplorer } from '../store.tsx'
import { applyHunk, GitOpError } from './actions.ts'
import { diffCounts } from './diff-model.ts'
import type { DiffRow } from '../../protocol.ts'
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

/**
 * Height of one diff row, in px. Must track `.rvs-dline`'s declared height
 * (`vsc.css`), because the window below converts scroll offsets to row indices
 * with it: if the CSS box is not exactly this tall the rendered slice drifts
 * from the spacer that stands in for the rest of the file.
 */
const ROW_HEIGHT = 18

/** Rows rendered above and below the viewport, so a wheel step is already ready. */
const OVERSCAN_ROWS = 8

/** Rows assumed to fit before the grid has been measured (one frame at most). */
const FALLBACK_VISIBLE_ROWS = 30

/** The half-open row range the diff columns paint, plus what they leave blank. */
interface RowWindow {
  /** First rendered row index into `model.rows`. */
  from: number
  /** One past the last rendered row index. */
  to: number
  /** Height of the rows above `from` / below `to`, in px. */
  before: number
  after: number
}

/** What one render pass gets from `useRowWindow`. */
interface RowWindowing {
  /** Goes on the element that owns the vertical scroll (`.rvs-diff-grid`). */
  attachGrid: (node: HTMLDivElement | null) => void
  onScroll: (event: React.UIEvent<HTMLDivElement>) => void
  /** The rows to paint, already sliced and clamped. */
  rows: DiffRow[]
  /** The range that slice came from, for effects that must re-measure with it. */
  range: RowWindow
  /** Height of the rows above / below the slice, in px. */
  before: number
  after: number
}

/**
 * The rows to render for one scroll position.
 *
 * Memoised against the row LIST, not just the numbers: a reload hands over a
 * new `model.rows` while `scrollTop` looks unchanged, and a window remembered
 * from the previous file would render the new file from the old offset. Handing
 * back the settled object in every other case is what lets a scroll event that
 * stays inside one row cost nothing.
 */
function computeRowWindow(
  rows: DiffRow[],
  scrollTop: number,
  height: number,
  last: React.MutableRefObject<{ rows: DiffRow[]; window: RowWindow }>,
): RowWindow {
  const visibleRows = Math.ceil(height / ROW_HEIGHT)
  /**
   * The offset is clamped to the last row, not merely guarded against
   * negatives: a reload can replace a 3000-line model with a 40-line one while
   * the browser still holds the old offset (it re-clamps the scroller only once
   * the new spacer height is in the DOM). An unclamped slice would ask for rows
   * that no longer exist, `from` would exceed the model, and the two spacers
   * would then add up to less than the file — the bottom of the new file would
   * be unreachable. Clamping keeps `before + slice + after` exactly equal to
   * `rows.length * ROW_HEIGHT`, which is what the scroller's range was before
   * this window existed.
   */
  const scrolledRows = Math.max(0, Math.min(Math.floor(scrollTop / ROW_HEIGHT), Math.max(0, rows.length - 1)))
  const from = Math.max(0, scrolledRows - OVERSCAN_ROWS)
  const to = Math.min(rows.length, Math.max(from + 1, scrolledRows + visibleRows + OVERSCAN_ROWS))
  const settled = last.current
  if (settled.rows === rows && settled.window.from === from && settled.window.to === to) return settled.window
  const window = { from, to, before: from * ROW_HEIGHT, after: Math.max(0, (rows.length - to) * ROW_HEIGHT) }
  last.current = { rows, window }
  return window
}

/**
 * Fixed-height windowing for the side-by-side columns.
 *
 * `.rvs-diff-grid` is the only vertical scroller in the diff view, and
 * `.rvs-dline` is a hard 18px, so the visible slice is arithmetic rather than
 * measurement: offset → first row, viewport height → row count. What is NOT
 * rendered is covered by a spacer of the right height, so the scroll range
 * covers the whole file and the scrollbar behaves exactly as it did when every
 * row was mounted.
 *
 * Scroll geometry is read through refs instead of React state: a `scrollTop`
 * per wheel event would re-render on every pixel, while only crossing a row
 * boundary changes anything on screen. The state here is just a revision
 * counter, and the arithmetic above is what decides whether it moves.
 *
 * Nothing is pinned outside the window: an off-screen hunk button is reached by
 * scrolling to its row, the same gesture as before.
 */
function useRowWindow(rows: DiffRow[]): RowWindowing {
  const scrollTopRef = useRef(0)
  const heightRef = useRef(FALLBACK_VISIBLE_ROWS * ROW_HEIGHT)
  const lastWindowRef = useRef<{ rows: DiffRow[]; window: RowWindow }>({
    rows: [],
    window: { from: -1, to: -1, before: 0, after: 0 },
  })
  const observerRef = useRef<ResizeObserver | null>(null)
  const [, bumpWindow] = useState(0)

  /**
   * A CALLBACK ref, so the grid is measured whenever it actually mounts.
   *
   * A layout effect cannot do this job: a diff opens on its loading branch,
   * where there is no grid to point at, and the grid only appears once the
   * model arrives — at which point no dependency has changed and the effect
   * would never run. The height would stay at the fallback and the bottom of a
   * tall viewport would sit blank until the first scroll. React calls this on
   * mount and with `null` on the way out, which is also the observer teardown.
   *
   * Measuring here keeps the guarantee that motivated the layout effect: the
   * first painted frame already carries the right slice, so opening or resizing
   * the split does not flash the opening rows and then jump. A 0-height reading
   * is the grid being hidden, not a collapsed viewport, so the last real height
   * is kept. The pane can also change size without the window following (a
   * sidebar split, a window resize, the editor header appearing), which is what
   * the observer below is for.
   */
  const attachGrid = useCallback((node: HTMLDivElement | null): void => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (node === null || typeof ResizeObserver === 'undefined') return
    scrollTopRef.current = node.scrollTop
    if (node.clientHeight > 0) heightRef.current = node.clientHeight
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.borderBoxSize[0]
      const measured = box === undefined ? node.clientHeight : box.blockSize
      if (measured > 0 && measured !== heightRef.current) {
        heightRef.current = measured
        bumpWindow(step => step + 1)
      }
    })
    observer.observe(node)
    observerRef.current = observer
  }, [])

  const range = computeRowWindow(rows, scrollTopRef.current, heightRef.current, lastWindowRef)
  /**
   * Recomputed on every scroll event and handed to React as the same object
   * whenever the slice did not move (`computeRowWindow`), so a wheel storm that
   * stays inside one row re-renders nothing. The measured `clientHeight` comes
   * along because it tracks a pane resize the window itself cannot see.
   */
  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>): void => {
    const grid = event.currentTarget
    scrollTopRef.current = grid.scrollTop
    if (grid.clientHeight > 0) heightRef.current = grid.clientHeight
    // Only a slice change is worth a render. `computeRowWindow` hands back the
    // very object the last render used while the wheel stays inside the same
    // rows, so comparing against the window that was current BEFORE the call is
    // the whole test — without it every scroll event re-rendered the diff,
    // which is the cost the windowing exists to remove.
    const previous = lastWindowRef.current.window
    if (computeRowWindow(rows, grid.scrollTop, heightRef.current, lastWindowRef) !== previous) {
      bumpWindow(step => step + 1)
    }
  }, [rows])

  return {
    attachGrid,
    onScroll,
    rows: rows.slice(range.from, range.to),
    range,
    before: range.before,
    after: range.after,
  }
}

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
 * spacer as wide as the widest line. Dragging it drives both panes, so a long
 * line can be reached without scrolling to the bottom of the file first.
 *
 * Rendered only when a line really is wider than the grid (see `hscroll`), and
 * styled tall enough to see and grab: as a permanently mounted 13 px band with
 * a `thin`, low-contrast thumb it read as "there is no horizontal scrollbar".
 */
function HScrollBar(props: {
  barRef: React.RefObject<HTMLDivElement>
  width: number
  hint: string
  onScroll: (left: number) => void
}): ReactNode {
  return (
    <div
      className="rvs-hbar"
      ref={props.barRef}
      title={props.hint}
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
  const gridRef = useRef<HTMLDivElement | null>(null)
  /**
   * Widest rendered line vs the width the grid actually shows.
   *
   * Only the PAIR matters: the top bar exists for one reason — telling the user
   * "this line continues past the edge, grab me" — so it is rendered only when
   * `content > viewport`. A permanently mounted 13 px band was invisible in
   * practice (a 1 px spacer, `thin` scrollbar, low-contrast thumb) and read as
   * "there is no horizontal scrollbar at all".
   */
  const [hscroll, setHscroll] = useState({ content: 0, viewport: 0 })
  const rowsInView = useRowWindow(tab.model?.rows ?? [])

  /**
   * Measure the widest pane and the grid's own width. Runs after every model
   * change, on container resizes (a pane that is empty until its fonts settle
   * would otherwise leave the bar too short) and whenever the window slides,
   * since the widest line on screen changes with it.
   */
  useLayoutEffect(() => {
    if (mode !== 'split') return
    const measure = (): void => {
      const content = Math.max(leftRef.current?.scrollWidth ?? 0, rightRef.current?.scrollWidth ?? 0)
      const viewport = gridRef.current?.clientWidth ?? 0
      setHscroll(previous => (previous.content === content && previous.viewport === viewport ? previous : { content, viewport }))
    }
    measure()
    const timer = window.setTimeout(measure, 80)
    window.addEventListener('resize', measure)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('resize', measure)
    }
  }, [mode, tab.id, tab.diff, rowsInView.range])

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
          {hscroll.content > hscroll.viewport + 1 && (
            <HScrollBar barRef={hbarRef} width={hscroll.content} hint={t('scm.hScrollHint')} onScroll={syncFromBar} />
          )}
          {/* The grid owns the vertical scroll for all three columns, so the
              window below is shared and the panes cannot drift apart. */}
          <div
            className="rvs-diff-grid"
            ref={(element) => {
              // Two consumers, one element: the row window's observer and the
              // horizontal measurement above.
              rowsInView.attachGrid(element)
              gridRef.current = element
            }}
            onScroll={rowsInView.onScroll}
          >
            <div className="rvs-diff-cols">
              {/* Left pane: fixed 50% (see .rvs-diff-col) with its own hidden
                  horizontal scroll, driven from the bar above. */}
              <div className="rvs-diff-col" ref={leftRef} onScroll={syncFromPane}>
                {/* The rows scrolled past. Height, not transform: the spacer has
                    to leave a real scroll range behind or the file's own rows
                    below the window would be unreachable. */}
                <div className="rvs-drows-blank" style={{ height: rowsInView.before }} />
                {rowsInView.rows.map(row => (
                  <div key={row.id} className={`rvs-dline${row.oldDel ? ' rvs-row-del' : ''}`}>
                    <span className="rvs-dline-num">{row.oldNum ?? ''}</span>
                    <span className="rvs-dline-text">
                      {row.old === ''
                        ? <span className="rvs-row-empty">{'\u00a0'}</span>
                        : <Line tokens={beforeLines[(row.oldNum ?? 1) - 1] ?? [{ text: row.old, kind: 'plain' }]} />}
                    </span>
                  </div>
                ))}
                <div className="rvs-drows-blank" style={{ height: rowsInView.after }} />
              </div>
              <div className="rvs-gutter-col">
                <div className="rvs-drows-blank" style={{ height: rowsInView.before }} />
                {rowsInView.rows.map(row => {
                  // `hunk.index` IS the position in `model.hunks`
                  // (`diff-model.ts` builds it with `.entries()`), so the row's
                  // index is the lookup — the linear `find` was one scan per row.
                  const hunk = row.hunk >= 0 ? model.hunks[row.hunk] : undefined
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
                <div className="rvs-drows-blank" style={{ height: rowsInView.after }} />
              </div>
              <div className="rvs-diff-col" ref={rightRef} onScroll={syncFromPane}>
                <div className="rvs-drows-blank" style={{ height: rowsInView.before }} />
                {rowsInView.rows.map(row => (
                  <div key={row.id} className={`rvs-dline${row.newAdd ? ' rvs-row-add' : ''}`}>
                    <span className="rvs-dline-num">{row.newNum ?? ''}</span>
                    <span className="rvs-dline-text">
                      {row.inNew === false || row.new === ''
                        ? <span className="rvs-row-empty">{'\u00a0'}</span>
                        : <Line tokens={afterLines[(row.newNum ?? 1) - 1] ?? [{ text: row.new, kind: 'plain' }]} />}
                    </span>
                  </div>
                ))}
                <div className="rvs-drows-blank" style={{ height: rowsInView.after }} />
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
