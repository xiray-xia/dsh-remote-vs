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
 * The row count is the WHOLE file, so every pane is windowed (see
 * `useScrollWindow`): before that, a 3000-line file put 9000 line containers and
 * ~2N tokenized lines in the DOM at once, and every store publish rebuilt all of
 * them — the "变更前 / 变更后" panes mounted every line of one side as well. In
 * the split mode note which element scrolls: the two panes only own their
 * HORIZONTAL scroll (`.rvs-diff-col`), while vertical scrolling belongs to
 * `.rvs-diff-grid` outside them — so ONE window serves all three columns and no
 * column can drift out of lockstep with another. The whole-file panes scroll
 * their own `.rvs-code` box and take the same window from the same hook.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { EditorTab } from '../store.tsx'
import { useExplorer } from '../store.tsx'
import { applyHunk, GitOpError } from './actions.ts'
import { diffCounts, hunkAtRow, stepHunk } from './diff-model.ts'
import type { DiffRow } from '../../protocol.ts'
import { GIT_CAP } from '../../git-ops.ts'
import { api } from '../api.ts'
import { CodeEditor, type CodeEditorHandle } from '../CodeEditor.tsx'
import { buildReviewPrompt, diffByteLength, pickReviewMode, reviewScopeOf } from '../ai-review.ts'
import { appendToDraft, canInsertDraft, sameLocalDir } from '../composer.ts'
import { useRemoteChatTarget } from '../use-remote-chat-target.ts'
import { langFromPath, lexState, tokenizeLine, type LangId, type Token } from '../vsc/tokenize.ts'
import {
  IconButton,
  IconChevronDown,
  IconChevronUp,
  IconRefresh,
  IconSave,
  MiniSpinner,
  Segmented,
  baseName,
  toast,
} from '../vsc/kit.tsx'

type ViewMode = 'split' | 'before' | 'after'

/**
 * Height of one row, in px, in EVERY windowed pane.
 *
 * Must track the row heights in `vsc.css` — `.rvs-dline` (split) and
 * `.rvs-code-line` (the whole-file panes) both render at 18px, the latter via
 * its inherited line-height (no explicit `height`; it is `min-width: max-content`
 * and never wraps) — because the window below
 * converts scroll offsets to line indices with it: if the box is not exactly
 * this tall the rendered slice drifts from the spacer that stands in for the
 * rest of the file.
 */
const ROW_HEIGHT = 18

/** Rows rendered above and below the viewport, so a wheel step is already ready. */
const OVERSCAN_ROWS = 8

/** Rows assumed to fit before a scroller has been measured (one frame at most). */
const FALLBACK_VISIBLE_ROWS = 30

/**
 * `.rvs-code`'s `padding-top`, in px (`vsc.css`).
 *
 * The whole-file panes scroll the same fixed 18px rows as the split columns, but
 * their scroller is `.rvs-code`, whose content box starts 6px down: that offset
 * has to come out of `scrollTop` before it is turned into a line index, or the
 * pane paints one row behind the scrollbar and the first line cannot be reached
 * at the top. The 16px bottom padding needs no arithmetic — it belongs to the
 * same scroller, so it stays inside the scroll range on its own.
 */
const CODE_PAD_TOP = 6

/** The half-open line range a windowed pane paints, plus what it leaves blank. */
export interface LineWindow {
  /** First rendered line index. */
  from: number
  /** One past the last rendered line index. */
  to: number
  /** Height of the lines above `from`, in px. */
  before: number
  /** Height of the lines below `to`, in px. */
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
  range: LineWindow
  /** Height of the rows above / below the slice, in px. */
  before: number
  after: number
}

/**
 * The lines to paint for one scroll offset — arithmetic, not measurement,
 * because every windowed row is a hard `ROW_HEIGHT`.
 *
 * `total` is the number of lines the FULL pane would have rendered, which is
 * what the scroll range has to cover: `before + painted + after` is exactly
 * `total * ROW_HEIGHT`, so the scrollbar behaves as it did when every line was
 * mounted.
 *
 * `offset` is the scroller's own top padding (`CODE_PAD_TOP` on `.rvs-code`, 0
 * on `.rvs-diff-grid`).
 *
 * The offset is clamped to the LAST line, not merely guarded against negatives:
 * a reload can replace a 3000-line side with a 40-line one while the browser
 * still holds the old offset (it re-clamps the scroller only once the new
 * spacer height is in the DOM). An unclamped slice would ask for lines that no
 * longer exist, `from` would exceed the text, and the two spacers would then add
 * up to less than the file — the bottom of the new text would be unreachable.
 * Clamping keeps `before + painted + after` exactly equal to
 * `total * ROW_HEIGHT`, which is what the scroller's range was before this
 * window existed.
 *
 * Pure and exported so a probe can pin the boundaries without a browser.
 */
export function computeLineWindow(
  total: number,
  scrollTop: number,
  height: number,
  offset = 0,
  overscan = OVERSCAN_ROWS,
): LineWindow {
  // A pane can be measured while hidden (height 0) and a browser can hand back a
  // non-finite offset during teardown; the arithmetic must stay total.
  const lines = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0
  const view = Number.isFinite(height) ? Math.max(0, height) : 0
  const top = Number.isFinite(scrollTop) ? scrollTop : 0
  const visibleRows = Math.ceil(view / ROW_HEIGHT)
  const scrolledRows = Math.max(0, Math.min(Math.floor((top - offset) / ROW_HEIGHT), Math.max(0, lines - 1)))
  const from = Math.max(0, scrolledRows - overscan)
  const to = Math.min(lines, Math.max(from + 1, scrolledRows + visibleRows + overscan))
  return { from, to, before: from * ROW_HEIGHT, after: Math.max(0, (lines - to) * ROW_HEIGHT) }
}

/** The window a pane last settled on, so a slice that did not move keeps its identity. */
interface WindowCache {
  /**
   * The line count that window was computed for: part of the identity because a
   * reload can change the count under an unchanged offset (the case
   * `computeLineWindow` clamps for).
   */
  total: number
  window: LineWindow
}

/**
 * `computeLineWindow`, but handing back the PREVIOUS object while the slice did
 * not move.
 *
 * That identity is what makes a wheel storm cheap: `onScroll` bumps the revision
 * counter only when the returned object differs from the one the last render
 * used, so a scroll that stays inside the same lines re-renders nothing. What it
 * costs is one 4-field object per scroll event, against a render that would
 * remount up to `visibleRows + 2 * OVERSCAN_ROWS` rows.
 */
function settledLineWindow(
  total: number,
  scrollTop: number,
  height: number,
  offset: number,
  last: React.MutableRefObject<WindowCache | undefined>,
): LineWindow {
  const next = computeLineWindow(total, scrollTop, height, offset)
  const settled = last.current
  if (settled !== undefined && settled.total === total && settled.window.from === next.from && settled.window.to === next.to) {
    return settled.window
  }
  last.current = { total, window: next }
  return next
}

/** What one render pass gets from `useScrollWindow`. */
interface Windowing {
  /** Goes on the element that owns the vertical scroll. */
  attach: (node: HTMLDivElement | null) => void
  onScroll: (event: React.UIEvent<HTMLDivElement>) => void
  /** The lines to paint, already clamped. */
  range: LineWindow
}

/**
 * Fixed-height windowing for every pane that paints a whole file.
 *
 * ONE implementation, because the arithmetic, the resize bookkeeping and the
 * "only a crossing re-renders" policy are the parts that are easy to get subtly
 * different: the split view needs the window's ROWS (it slices `model.rows`),
 * the "变更前 / 变更后" panes need only the window's LINE INDEXES, and both take
 * the range from here — see `useRowWindow` for the split adapter.
 *
 * A scroller owns a fixed-row-height list, so the visible slice is arithmetic
 * rather than measurement: offset → first line, viewport height → line count.
 * What is NOT rendered is covered by a spacer of the right height, so the scroll
 * range covers the whole file and the scrollbar behaves exactly as it did when
 * every line was mounted.
 *
 * Scroll geometry is read through refs instead of React state: a `scrollTop` per
 * wheel event would re-render on every pixel, while only crossing a line
 * boundary changes anything on screen. The state here is just a revision
 * counter, and the arithmetic above is what decides whether it moves.
 *
 * Nothing is pinned outside the window: an off-screen hunk button is reached by
 * scrolling to its row, the same gesture as before.
 */
function useScrollWindow(total: number, offset = 0): Windowing {
  const scrollTopRef = useRef(0)
  const heightRef = useRef(FALLBACK_VISIBLE_ROWS * ROW_HEIGHT)
  const lastWindowRef = useRef<WindowCache | undefined>(undefined)
  const observerRef = useRef<ResizeObserver | null>(null)
  const [, bumpWindow] = useState(0)

  /**
   * A CALLBACK ref, so the scroller is measured whenever it actually mounts.
   *
   * A layout effect cannot do this job: a diff opens on its loading branch, where
   * there is no scroller to point at, and it only appears once the model arrives
   * — at which point no dependency has changed and the effect would never run.
   * The height would stay at the fallback and the bottom of a tall viewport would
   * sit blank until the first scroll. React calls this on mount and with `null`
   * on the way out, which is also the observer teardown.
   *
   * Measuring here keeps the guarantee that motivated the layout effect: the
   * first painted frame already carries the right slice, so opening or resizing a
   * pane does not flash the opening rows and then jump. A 0-height reading is the
   * pane being hidden (or a scroller with no layout at all — jsdom), NOT a
   * collapsed viewport, so the last real height is kept and the window falls back
   * to `FALLBACK_VISIBLE_ROWS`: a fixed slice, never the whole file.
   *
   * The offset is re-read here as well, and a change repaints: a mode switch
   * UNMOUNTS one scroller and mounts another, so the ref can still hold the
   * previous pane's offset while this render has already laid the window out from
   * it. A fresh node starts at 0, and getting that wrong would paint a blank
   * spacer above the first lines until the next scroll event.
   */
  const attach = useCallback((node: HTMLDivElement | null): void => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (node === null) return
    let repaint = node.scrollTop !== scrollTopRef.current
    scrollTopRef.current = node.scrollTop
    if (node.clientHeight > 0 && node.clientHeight !== heightRef.current) {
      heightRef.current = node.clientHeight
      repaint = true
    }
    if (repaint) bumpWindow(step => step + 1)
    // A scroller can also be mounted somewhere without `ResizeObserver` (jsdom,
    // an older embedded webview): the measurement above is then the only one,
    // and there is simply nothing to follow later.
    if (typeof ResizeObserver === 'undefined') return
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

  const range = settledLineWindow(total, scrollTopRef.current, heightRef.current, offset, lastWindowRef)
  /**
   * Recomputed on every scroll event and handed to React as the same object
   * whenever the slice did not move (`settledLineWindow`), so a wheel storm that
   * stays inside one line re-renders nothing. The measured `clientHeight` comes
   * along because it tracks a pane resize the window itself cannot see.
   */
  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>): void => {
    const scroller = event.currentTarget
    scrollTopRef.current = scroller.scrollTop
    if (scroller.clientHeight > 0) heightRef.current = scroller.clientHeight
    // Only a slice change is worth a render. `settledLineWindow` hands back the
    // very object the last render used while the wheel stays inside the same
    // lines, so comparing against the window that was current BEFORE the call is
    // the whole test — without it every scroll event re-rendered the diff,
    // which is the cost the windowing exists to remove.
    const previous = lastWindowRef.current?.window
    if (settledLineWindow(total, scroller.scrollTop, heightRef.current, offset, lastWindowRef) !== previous) {
      bumpWindow(step => step + 1)
    }
  }, [total, offset])

  return { attach, onScroll, range }
}

/** The split view's window: `useScrollWindow` plus the `model.rows` slice. */
function useRowWindow(rows: DiffRow[]): RowWindowing {
  const windowing = useScrollWindow(rows.length)
  return {
    attachGrid: windowing.attach,
    onScroll: windowing.onScroll,
    rows: rows.slice(windowing.range.from, windowing.range.to),
    range: windowing.range,
    before: windowing.range.before,
    after: windowing.range.after,
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
 * The lines of one whole-file side ("变更前" / a staged "变更后").
 *
 * The split columns' treatment, one pane deep: only the window's lines are
 * mounted, the lines above and below it are spacers of the right height, and the
 * gutter numbers are the side's own line indexes + 1. `.rvs-code-line` is a hard
 * 18px row and does not wrap (`min-width: max-content`), which is what lets the
 * shared window use the same arithmetic here as in the split view.
 *
 * Rendered inside `.rvs-code`, whose 6px top padding is the window's `offset`
 * (see `CODE_PAD_TOP`), so the first rendered line sits exactly where the scroll
 * offset says it does.
 */
function CodeLines(props: { tokens: SideTokens; range: LineWindow; emptyText: string }): ReactNode {
  if (props.range.to <= props.range.from) return <div className="rvs-empty">{props.emptyText}</div>
  return (
    <>
      <div className="rvs-drows-blank" style={{ height: props.range.before }} />
      {Array.from({ length: props.range.to - props.range.from }, (_, offset) => props.range.from + offset).map(line => (
        <div key={line} className="rvs-code-line">
          <span className="rvs-num">{line + 1}</span>
          <span className="rvs-code-text"><Line tokens={props.tokens.at(line) ?? []} /></span>
        </div>
      ))}
      <div className="rvs-drows-blank" style={{ height: props.range.after }} />
    </>
  )
}

/**
 * One side of the diff, tokenized ON DEMAND down to the deepest line asked for.
 *
 * Why not `tokenizeDocument` on open: the split view paints only the rows in
 * its window, but the old code tokenized BOTH whole sides before painting a
 * single line — on a 2 MB diff (the host's `GIT_CAP`) that is tens of thousands
 * of lines of work spent before the first screenful appears.
 *
 * Why it cannot simply tokenize the window's slice: `tokenizeLine` is stateful
 * (a line inside a `/* … *\/` block comment only tokenizes correctly after the
 * lines that opened it), so this walks the side from line 0, keeps the block
 * state and the arrays produced so far, and stops as soon as the deepest
 * requested line is covered. Opening a file at the top therefore tokenizes a
 * screenful, scrolling or jumping deeper extends the cache incrementally, and
 * every line is still tokenized exactly once per reload.
 *
 * The string split is deferred to the first line actually asked for, and a side
 * that is never painted (its pane is not on screen) now costs nothing at all.
 *
 * Both halves of the view read through this: the split columns take the lines
 * their rows name, and the windowed whole-file panes take their visible range.
 * `tokenizeDocument` walks exactly the same lines with the same state, so the
 * per-line arrays are identical either way.
 */
interface SideTokens {
  /** Number of lines in the text (a trailing newline ends with an empty line). */
  readonly lineCount: number
  /** Tokens for the 0-based line, or `undefined` past the end of the text. */
  at(lineIndex: number): Token[] | undefined
}

/** Lines in `text`, counted without allocating the split array. */
function countLines(text: string): number {
  let count = 1
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) count += 1
  return count
}

/** A side with nothing to show yet: never allocates and never tokenizes. */
const NO_TOKENS: SideTokens = { lineCount: 0, at: () => undefined }

function createSideTokens(text: string, lang: LangId | undefined): SideTokens {
  const lineCount = countLines(text)
  let lines: string[] | undefined
  const tokens: Token[][] = []
  const state = lexState()
  return {
    lineCount,
    at(lineIndex: number): Token[] | undefined {
      if (lineIndex < 0 || lineIndex >= lineCount) return undefined
      const source = lines ?? (lines = text.split('\n'))
      while (tokens.length <= lineIndex) {
        tokens.push(tokenizeLine(source[tokens.length] ?? '', lang, state))
      }
      return tokens[lineIndex]
    },
  }
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

/** Why one hunk action (stage / unstage / revert) cannot run for this tab. */
export type HunkBlockReason = 'offline' | 'truncated'

/**
 * Whether a hunk action is refused, and why.
 *
 * A hunk action ships `model.hunks[].patch` to `git apply` on the host, and that
 * patch was parsed out of a `git diff` the host caps (`GIT_CAP`, 2 MB): on a
 * capped read the last hunk can be a HALF patch, which git refuses as corrupt
 * and the user sees git's raw error instead of "the file is too big". The pane
 * is already read-only for a capped read (the `truncated` tab flag, D3); hunk
 * writes have to obey that same promise instead of being the one exception.
 *
 * Pure and exported so the gate can pin both halves (offline and truncated)
 * without rendering CodeMirror.
 */
export function hunkBlockReason(
  tab: Pick<EditorTab, 'truncated'>,
  offline: boolean,
): HunkBlockReason | undefined {
  if (offline) return 'offline'
  if (tab.truncated) return 'truncated'
  return undefined
}

/**
 * The text the editable "after" pane must mount with.
 *
 * Three sources, in order, and each exists for a different unmount:
 *  - `editBuffer` — this component's own handoff. A MODE switch (split/before/
 *    after) unmounts only the `CodeEditor`, so the pane keeps its state.
 *  - `tab.text` — a PREVIOUS mount's handoff, written by `onBuffer` when a tab
 *    switch or a surface flip unmounted the whole pane. Only trusted while the
 *    tab is dirty: once saved, the disk bytes are the truth (and a later reload
 *    must be able to show them).
 *  - the disk bytes — first mount, or a clean tab.
 *
 * Pure and exported for the same reason as `hunkBlockReason`: the handoff is
 * exactly the kind of thing that looks right in review and silently drops text
 * in practice.
 */
export function diffAfterInitialText(
  editBuffer: string | undefined,
  tab: Pick<EditorTab, 'text' | 'dirty'>,
  newText: string | undefined,
): string {
  if (editBuffer !== undefined) return editBuffer
  if (tab.dirty && tab.text !== '') return tab.text
  return newText ?? ''
}

export function DiffView(props: { tab: EditorTab; visible: boolean; offline?: boolean }): ReactNode {
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

  /** First row of every change, ascending — the prev/next jump targets. */
  const hunkRows = useMemo(() => (tab.model === undefined ? [] : tab.model.hunks.map(hunk => hunk.startRow).sort((a, b) => a - b)), [tab.model])
  /**
   * The change the toolbar's `n / N` reports.
   *
   * A jump sets it explicitly instead of re-deriving it from `scrollTop`: near
   * the bottom of a file the browser CLAMPS the offset, so re-deriving would
   * report the change above the one the button just went to and the next click
   * would refuse to advance. A manual scroll does re-derive it (`hunkAtRow`),
   * which is what keeps the counter honest when the user drags instead of
   * clicking. `-1` = nothing jumped yet / the viewport is above the first
   * change.
   */
  const [hunkCursor, setHunkCursor] = useState(-1)
  /** The `scrollTop` a jump just wrote, so its own scroll event is not read as a manual scroll. */
  const jumpedTopRef = useRef(-1)

  /** Scroll to the next (1) or previous (-1) change, wrapping at both ends. */
  const jumpHunk = (direction: 1 | -1): void => {
    const grid = gridRef.current
    if (grid === null) return
    const target = stepHunk(hunkRows.length, hunkCursor, direction)
    if (target < 0) return
    const top = (hunkRows[target] as number) * ROW_HEIGHT
    jumpedTopRef.current = top
    grid.scrollTop = top
    setHunkCursor(target)
  }

  /** Keep `n / N` in step with the viewport while the user scrolls by hand. */
  const syncHunkCursor = (grid: HTMLDivElement): void => {
    if (hunkRows.length === 0) return
    if (Math.abs(grid.scrollTop - jumpedTopRef.current) < 1) return
    const next = hunkAtRow(hunkRows, grid.scrollTop / ROW_HEIGHT)
    setHunkCursor(previous => (previous === next ? previous : next))
  }

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

  /**
   * Why the "AI review" button cannot run, or `undefined` when it can.
   *
   * Three different absences, three different sentences, checked from the most
   * fundamental down:
   *  - `store.ctx`: the shared store boots asynchronously, so before it lands
   *    there is nothing to write into at all;
   *  - `chatEnabled`: the same binding gate the selection popup uses — a prompt
   *    that names a remote path means nothing in a session that does not live in
   *    this binding;
   *  - `canInsertDraft`: the conversation service is a SOFT, version-dependent
   *    read. A host that does not expose it must say so up front instead of
   *    failing on click with the "composer is busy" sentence, which would name
   *    the wrong cause.
   */
  let reviewBlocked: string | undefined
  if (store.ctx === undefined) reviewBlocked = t('scm.aiReviewNoContext')
  else if (!chatEnabled || chat.sessionId === undefined) reviewBlocked = t('scm.aiReviewNoSession')
  else if (!canInsertDraft(store.ctx, chat.sessionId)) reviewBlocked = t('scm.aiReviewNoChannel')

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
  /**
   * The two sides, tokenized lazily as a window asks for lines (see
   * `createSideTokens`). Memoized on the TEXT, not the tab: a store publish hands
   * over a fresh tab object for a dirty/saving flip while the diff bytes are
   * unchanged, and rebuilding both caches would re-tokenize the file.
   *
   * The memo refuses to run while `model` is missing (F7): the payload arrives in
   * two publishes, so `tab.diff` can be populated a publish before `tab.model`,
   * and the old memo walked the whole side text for a pane that could not be
   * painted yet. `NO_TOKENS` is the stand-in for that state.
   */
  const beforeSide = useMemo(
    () => (model === undefined ? NO_TOKENS : createSideTokens(tab.diff?.oldText ?? '', sideLang)),
    [model, tab.diff?.oldText, sideLang],
  )
  const afterSide = useMemo(
    () => (model === undefined ? NO_TOKENS : createSideTokens(tab.diff?.newText ?? '', sideLang)),
    [model, tab.diff?.newText, sideLang],
  )
  /**
   * The whole-file pane's side and its window.
   *
   * Both "变更前 / 变更后" panes read through the SAME lazy tokenizer as the split
   * columns instead of `tokenizeDocument`-ing the whole side, which is what makes
   * windowing them pay off: only the lines near the viewport are ever tokenized.
   * An UNSTAGED "变更后" is the editable CodeMirror buffer, not a text pane, so it
   * gets `NO_TOKENS` and tokenizes nothing.
   */
  const codeSide = mode === 'before'
    ? beforeSide
    : mode === 'after' && tab.staged
      ? afterSide
      : NO_TOKENS
  const codeWindow = useScrollWindow(codeSide.lineCount, CODE_PAD_TOP)
  /**
   * Materialise every token array this frame's rows will read (F7).
   *
   * `SideTokens.at` is not a pure read: the first call for a line advances an
   * append-only cache over the stateful `tokenizeLine`. While it was called from
   * the row JSX, a render pass mutated that cache, so a double render (StrictMode,
   * a discarded concurrent render) interleaved advancement with reading. The token
   * ARRAYS are a pure function of the side's text and language, so the output
   * never differed — what was wrong is that the render phase changed state nobody
   * could see.
   *
   * The prefetch asks the same questions ONCE per window (this memo is keyed by
   * the window, not by the scroll event) and the row loops below are then pure
   * cache hits. It mirrors their guards deliberately; if one ever drifts the cost
   * is a render-time miss, not a wrong token.
   */
  useMemo(() => {
    if (mode === 'split') {
      const rows = model?.rows ?? []
      for (let index = rowsInView.range.from; index < rowsInView.range.to; index += 1) {
        const row = rows[index]
        if (row === undefined) continue
        if (row.old !== '') beforeSide.at((row.oldNum ?? 1) - 1)
        if (row.inNew !== false && row.new !== '') afterSide.at((row.newNum ?? 1) - 1)
      }
      return
    }
    for (let line = codeWindow.range.from; line < codeWindow.range.to; line += 1) codeSide.at(line)
  }, [mode, model, beforeSide, afterSide, codeSide, rowsInView.range, codeWindow.range])

  const runHunk = async (index: number, kind: 'stage' | 'unstage' | 'revert'): Promise<void> => {
    // A hunk action is a remote write, and it ships a patch parsed out of a
    // possibly CAPPED diff: offline it can only fail (and the first failure
    // surfaces raw socket text), on a truncated tab it would send a half patch
    // that git rejects as corrupt. Both are refused with the reason; the gutter
    // buttons are disabled for the same two states.
    const blocked = hunkBlockReason(tab, props.offline === true)
    if (blocked !== undefined) {
      toast(t(blocked === 'offline' ? 'connection.saveBlocked' : 'scm.hunkTruncated'), true)
      return
    }
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
    if (props.offline === true) {
      // The link is down: writing now can only fail (see the connection chip).
      toast(t('connection.saveBlocked'), true)
      return
    }
    if (tab.truncated) {
      // `newText` is only the read cap's prefix: writing it would truncate the
      // real file. The pane is read-only, but Ctrl+S must say why.
      toast(t('editor.truncatedReadOnly'), true)
      return
    }
    // The editable pane is a CodeMirror buffer: read it imperatively so the
    // write carries the live text, then persist through the same route the
    // file editor uses and reload the diff from the new working tree.
    const text = editorRef.current?.getContent() ?? editBuffer
    if (text === undefined) return
    setEditBuffer(text)
    store.updateTab(tab.id, { text })
    const saved = await store.saveTab(tab.id, text)
    /**
     * Only a LANDED write is followed by a reload.
     *
     * The old code reloaded on every outcome, so a permission error, a full disk
     * or a dropped link replaced the buffer with the remote bytes and said
     * nothing — the user's edit was gone without a confirmation. A refused save
     * now shows its own banner (overwrite / reload / difference); any other
     * failure shows its toast and keeps the buffer.
     */
    if (!saved) return
    await store.reloadTab(tab.id)
  }

  /**
   * Append an AI-review prompt for THIS tab's diff to the composer draft (F6).
   *
   * v1 stops at the DRAFT on purpose: `appendToDraft` is the only delivery
   * channel used here — no `submit`/`send` call — so the user always sees the
   * exact prompt (and can edit or discard it) before anything costs a turn. The
   * host does expose submit facades (see `docs/.feasibility/review.md` §2);
   * wiring them is a separate, opt-in feature.
   *
   * The prompt is built on CLICK, not during render: `diffByteLength` encodes
   * the whole diff and the prompt can be tens of kilobytes, which must not be
   * recomputed per frame while the user scrolls the diff.
   */
  const reviewWithAi = (): void => {
    const ctx = store.ctx
    const sessionId = chat.sessionId
    if (reviewBlocked !== undefined || ctx === undefined || sessionId === undefined) {
      toast(reviewBlocked ?? t('scm.aiReviewNoSession'), true)
      return
    }
    // Byte accounting, not `diff.length`: `GIT_CAP` is a `head -c` BYTE cap and
    // the exec result does not flag the truncation (see `ai-review.ts`).
    const diff = tab.diff?.diff ?? ''
    const bytes = diffByteLength(diff)
    const capped = bytes >= GIT_CAP
    const mode = pickReviewMode({ bytes, hasDiff: diff !== '', capped })
    const prompt = buildReviewPrompt({
      alias: store.alias,
      root: store.repoRoot ?? store.root,
      rel: tab.rel,
      fullPath: tab.fullPath,
      scope: reviewScopeOf(tab.staged, tab.ref),
      ...(tab.ref === undefined ? {} : { commitRef: tab.ref }),
      diff,
      mode,
      capped,
      lang,
    })
    if (!appendToDraft(ctx, sessionId, prompt)) {
      toast(t('scm.aiReviewFailed'), true)
      return
    }
    // One sentence per shape, because the three mean different things and the
    // "large diff" wording would be a lie for a file that has no diff at all
    // (untracked / new: the prompt asks the model to read the file itself).
    if (mode === 'full') toast(t('scm.aiReviewAdded'))
    else if (mode === 'summary') toast(t('scm.aiReviewAddedSummary'))
    else toast(t('scm.aiReviewAddedRead'))
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

  const editable = mode === 'after' && !tab.staged && props.offline !== true && !tab.truncated
  /**
   * The gutter hunk buttons obey the same refusal as `runHunk` (see
   * `hunkBlockReason`), and a disabled button names the REAL reason when it has
   * one — a silently greyed control reads as a bug.
   */
  const hunkDisabled = props.offline === true || tab.truncated
  const hunkDisabledTitle = tab.truncated ? t('scm.hunkTruncated') : undefined

  return (
    <div className="rvs-diff">
      {tab.truncated && <div className="rvs-banner warn">{t('editor.truncatedReadOnly')}</div>}
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
        {/* Prev/next change: the hunk list indexes the SPLIT model's rows, so the
            counter belongs to the split view; the side panes paint file lines.
            The counter doubles as the "where am I" cue. */}
        {mode === 'split' && hunkRows.length > 0 && (
          <span className="rvs-hunknav" title={t('scm.hunkNavHint')}>
            <IconButton title={t('scm.prevHunk')} onClick={() => jumpHunk(-1)}>
              <IconChevronUp size={13} />
            </IconButton>
            <span className="rvs-hunknav-pos">{hunkCursor < 0 ? `-/${hunkRows.length}` : `${hunkCursor + 1}/${hunkRows.length}`}</span>
            <IconButton title={t('scm.nextHunk')} onClick={() => jumpHunk(1)}>
              <IconChevronDown size={13} />
            </IconButton>
          </span>
        )}
        {busy && <MiniSpinner />}
        {/* F6: hand THIS diff to the on-screen session as a review prompt. It
            only fills the composer draft (see `reviewWithAi`); the title carries
            the exact reason whenever the binding gate refuses. The glyph is
            text because the icon set has no "AI" mark — the same precedent as
            the search options' `Aa` / `.*` glyphs in `kit.tsx`. */}
        <IconButton
          title={reviewBlocked ?? t('scm.aiReview')}
          onClick={reviewWithAi}
          disabled={reviewBlocked !== undefined}
        >
          <span className="rvs-glyph" aria-hidden="true" style={{ fontSize: 12 }}>AI</span>
        </IconButton>
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
            onScroll={(event) => {
              rowsInView.onScroll(event)
              syncHunkCursor(event.currentTarget)
            }}
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
                        : <Line tokens={beforeSide.at((row.oldNum ?? 1) - 1) ?? [{ text: row.old, kind: 'plain' }]} />}
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
                                  title={hunkDisabledTitle ?? (tab.staged ? t('scm.unstageHunk') : t('scm.stageHunk'))}
                                  disabled={hunkDisabled}
                                  onClick={() => { void runHunk(hunk.index, tab.staged ? 'unstage' : 'stage') }}
                                >
                                  {tab.staged ? '↧' : '⤒'}
                                </button>
                                {!tab.staged && (
                                  <button
                                    type="button"
                                    className="rvs-hunk-btn revert"
                                    title={hunkDisabledTitle ?? t('scm.revertHunk')}
                                    disabled={hunkDisabled}
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
                        : <Line tokens={afterSide.at((row.newNum ?? 1) - 1) ?? [{ text: row.new, kind: 'plain' }]} />}
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
        <div className="rvs-code rvs-scroll" ref={codeWindow.attach} onScroll={codeWindow.onScroll}>
          <CodeLines tokens={codeSide} range={codeWindow.range} emptyText={t('scm.emptySide')} />
        </div>
      )}
      {mode === 'after' && (
        tab.staged
          ? (
            <div className="rvs-code rvs-scroll" ref={codeWindow.attach} onScroll={codeWindow.onScroll}>
              <CodeLines tokens={codeSide} range={codeWindow.range} emptyText={t('scm.emptySide')} />
            </div>
          )
          : (
            <div className="rvs-editor-host">
              <CodeEditor
                key={`${tab.id}:edit`}
                ref={editorRef}
                initial={diffAfterInitialText(editBuffer, tab, tab.diff?.newText)}
                // The disk side of the dirty comparison, exactly like the file
                // editor (`EditorPane` passes `activeTab.baseline`): without it a
                // remount that carries the handoff text would be judged clean
                // against itself and the tab's dot would drift from the buffer.
                savedText={tab.diff?.newText}
                path={tab.fullPath}
                readOnly={props.offline === true || tab.truncated}
                visible={props.visible}
                tabId={tab.id}
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
                /**
                 * The diff pane's half of the D1 handover. Its `CodeEditor` is
                 * unmounted BOTH by a mode switch (this component stays mounted)
                 * and by a tab switch / surface flip (everything unmounts), so the
                 * text has to land in both places: this mount's buffer for the
                 * first, the tab for the second.
                 */
                onBuffer={(id, text) => {
                  setEditBuffer(text)
                  store.updateTab(id, { text })
                }}
              />
            </div>
          )
        )}
    </div>
  )
}
