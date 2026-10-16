/**
 * VS Code-style find widget for the editor: Ctrl/Cmd+F opens it, Enter / Shift+
 * Enter step through matches, Esc closes and returns focus to the buffer.
 *
 * Matching is delegated to CodeMirror's `@codemirror/search` (the same engine
 * its own panel uses, so `Aa` / `ab_` / `.*` behave identically), but the
 * widget itself is ours: the built-in panel is a plain form that never matches
 * the rest of this UI. Match counting walks the query's cursor, which is what
 * gives the "3/17" readout VS Code shows.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { StateEffect, StateField, type EditorState } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, setSearchQuery } from '@codemirror/search'
import { IconButton, IconClose, IconRegex } from './kit.tsx'

/** Upper bound on highlighted matches (the readout saturates here too). */
const MATCH_CAP = 5000

const matchMark = Decoration.mark({ class: 'rvs-find-match' })
const currentMark = Decoration.mark({ class: 'rvs-find-match current' })

/**
 * Our own match highlighting.
 *
 * `@codemirror/search`'s `highlight()` only decorates while ITS panel is
 * mounted (`highlight({query, panel})` returns an empty set when `panel` is
 * falsy), and this widget deliberately never mounts that panel — so the query
 * was counted and stepped through while NOTHING was highlighted, and the
 * `.cm-searchMatch` rules in vsc.css were dead for the same reason.
 *
 * The field owns the query it painted instead of reading the search state:
 * the widget must highlight what IT shows, and the editor's own query would
 * otherwise change underneath it.
 */
const setFindQuery = StateEffect.define<SearchQuery | null>()

/** One walk of the query's cursor: the matches it found, in document order. */
interface MatchScan {
  matches: { from: number; to: number }[]
}

/**
 * What the running query is, plus what was derived from it.
 *
 * The match list is kept alongside the decorations because the count readout
 * and the "which match is current" answer are both derivable from it without
 * touching the document again.
 */
interface FindMarks {
  query: SearchQuery | null
  marks: DecorationSet
  matches: { from: number; to: number }[]
  /** Which match is highlighted, 1-based, or 0 when the caret is not on one. */
  index: number
}

/**
 * Walk the query's cursor once and return every match, in document order.
 *
 * One walk, because repeating it is expensive: `@codemirror/search`'s literal
 * path is a per-code-point state machine that normalizes every character, not a
 * substring search, so the cost is linear in the DOCUMENT rather than in the
 * number of hits. The widget used to walk it four times per keystroke (marks,
 * count, marks again after the step moved the selection, count again).
 *
 * The caret's own position is deliberately not derived here: it belongs to the
 * state the caller has, and `indexAt` answers it from this list in O(log n).
 */
function scanMatches(query: SearchQuery | null, state: EditorState): MatchScan {
  if (query === null || !query.valid) return { matches: [] }
  const matches: { from: number; to: number }[] = []
  try {
    const cursor = query.getCursor(state)
    for (let step = cursor.next(); step.done !== true; step = cursor.next()) {
      // Guard the loop, not just the array: a zero-width match could otherwise
      // keep producing values without ever reaching the cap.
      if (matches.length >= MATCH_CAP) break
      matches.push({ from: step.value.from, to: step.value.to })
    }
  } catch {
    // An invalid regex: the panel shows "no results" instead of throwing.
    return { matches: [] }
  }
  // The cursor yields matches in document order, which is what `indexAt`'s
  // binary search and `Decoration.set` both rely on.
  return { matches }
}

/** Decorate one match list, so `caretAt`'s match is the highlighted one. */
function marksFor(spans: { from: number; to: number }[], caretAt: number): DecorationSet {
  if (spans.length === 0) return Decoration.none
  return Decoration.set(spans.map(span =>
    (span.from === caretAt ? currentMark : matchMark).range(span.from, span.to)))
}

/**
 * 1-based position of the match starting at `caret`, or 0 when the caret is not
 * on one. Binary search: moving the caret has to re-label at most one
 * decoration, and it must not cost a document walk to find out which.
 */
function indexAt(spans: { from: number; to: number }[], caret: number): number {
  let low = 0
  let high = spans.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const at = spans[mid]?.from ?? 0
    if (at === caret) return mid + 1
    if (at < caret) low = mid + 1
    else high = mid - 1
  }
  return 0
}

/** The count readout for a caret position, from a match list already in hand. */
function countAt(spans: { from: number; to: number }[], caret: number): { total: number; index: number } {
  return { total: spans.length, index: indexAt(spans, caret) }
}

/** The count readout for where the editor's caret is right now. */
function countFor(view: EditorView): { total: number; index: number } {
  return countAt(view.state.field(matchField).matches, view.state.selection.main.from)
}

const matchField = StateField.define<FindMarks>({
  create: () => ({ query: null, marks: Decoration.none, matches: [], index: 0 }),
  update(value, tr) {
    const effect = tr.effects.find(item => item.is(setFindQuery))
    if (effect !== undefined) {
      const query = effect.value
      const scan = scanMatches(query, tr.state)
      const caret = tr.state.selection.main.from
      return { query, marks: marksFor(scan.matches, caret), matches: scan.matches, index: indexAt(scan.matches, caret) }
    }
    /**
     * A moved caret changes only WHICH match is current, and the list is
     * already in hand — so this re-labels at most one decoration instead of
     * walking the document. Two guards make it cheap: the list is only useful
     * for a non-null query, and the rebuild is skipped outright while the caret
     * stays inside the same match. Most caret moves inside a document are
     * exactly that, and the old code rescanned the whole document for every one
     * of them.
     */
    if (tr.selection !== undefined && value.query !== null) {
      const caret = tr.state.selection.main.from
      const index = indexAt(value.matches, caret)
      if (index === value.index) return value
      return { query: value.query, marks: marksFor(value.matches, caret), matches: value.matches, index }
    }
    // Edits do change which matches exist, so those need the walk.
    if (tr.docChanged) {
      const scan = scanMatches(value.query, tr.state)
      const caret = tr.state.selection.main.from
      return { query: value.query, marks: marksFor(scan.matches, caret), matches: scan.matches, index: indexAt(scan.matches, caret) }
    }
    return value
  },
  provide: field => EditorView.decorations.from(field, value => value.marks),
})

/**
 * The find-match extension for one editor (installed by CodeEditor).
 *
 * Exported as a value, not a function, so the field identity is stable across
 * mounts.
 */
export const findMatchHighlight = matchField

export interface FindState {
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  regexp: boolean
}

const EMPTY: FindState = { query: '', caseSensitive: false, wholeWord: false, regexp: false }

/** Build the CodeMirror query (literal unless the regex toggle is on). */
function toQuery(state: FindState): SearchQuery {
  return new SearchQuery({
    search: state.query,
    caseSensitive: state.caseSensitive,
    wholeWord: state.wholeWord,
    regexp: state.regexp,
    literal: !state.regexp,
  })
}

/** True when the editor's current search query can actually be stepped. */
function steppable(view: EditorView, state: FindState): boolean {
  if (state.query === '') return false
  let query: SearchQuery
  try {
    query = toQuery(state)
  } catch {
    return false
  }
  return query.valid
}

/**
 * Push the query into the editor (highlights every match) and count them.
 *
 * The count is read back OUT of the field the dispatch just wrote, so one walk
 * of the document serves the marks, the total and the caret's position — this
 * used to be two walks here and two more once the caller stepped.
 */
export function applyFind(view: EditorView, state: FindState): { total: number; index: number } {
  try {
    const query = toQuery(state)
    view.dispatch({ effects: [setSearchQuery.of(query), setFindQuery.of(query)] })
  } catch {
    // A malformed pattern must not break typing; clear the marks instead of
    // leaving the previous query's highlights on screen.
    view.dispatch({ effects: setFindQuery.of(null) })
  }
  const scan = view.state.field(matchField)
  return countAt(scan.matches, view.state.selection.main.from)
}

/** Drop every match mark (the widget was closed or reset). */
export function clearFindMarks(view: EditorView): void {
  // A real effect, so clearing is a transition rather than a no-op.
  view.dispatch({ effects: setFindQuery.of(null) })
}

export function stepFind(view: EditorView, forward: boolean, state?: FindState): void {
  // Guard on validity: `findNext`/`findPrevious` are `searchCommand` wrappers
  // that call `openSearchPanel` when the query is invalid, which mounts
  // CodeMirror's own unstyled panel inside our editor and re-seeds the
  // editor's query from the selection. Typing `(` in regex mode and pressing
  // Enter did exactly that. With a caller-supplied state validity is known up
  // front; without one, fall back to the editor's own query.
  if (state !== undefined) {
    if (!steppable(view, state)) return
  } else if (!getSearchQuery(view.state).valid) {
    return
  }
  try {
    if (forward) findNext(view)
    else findPrevious(view)
  } catch {
    // Ignore: nothing to step to.
  }
  // Belt and braces: if a step did manage to open the built-in panel, close it
  // again so it can never appear inside the editor.
  closeSearchPanel(view)
}

export function FindWidget(props: {
  view: EditorView | undefined
  open: boolean
  /** A selection carried in by Ctrl+F (`id` bumps to re-trigger). */
  seed: { text: string; id: number }
  /**
   * Viewport coordinates pinning the widget to the editor's top-right corner.
   *
   * The widget is `position: fixed` on those coordinates instead of living in
   * the editor's layout: the editor sits in a slot whose height this plugin does
   * not own, so ANY ancestor can end up being the scroller — and a box inside
   * that subtree travels away with the text. Fixed coordinates cannot.
   */
  anchor?: { top: number; right: number } | undefined
  onClose: () => void
}): ReactNode {
  const [state, setState] = useState<FindState>(EMPTY)
  const [count, setCount] = useState({ total: 0, index: 0 })
  const inputRef = useRef<HTMLInputElement>(null)

  // A selection seeded by Ctrl+F replaces the previous query (VS Code's
  // find-on-selection); the id bump re-triggers even for identical text.
  useEffect(() => {
    if (props.seed.id === 0 || props.seed.text === '') return
    setState(prev => ({ ...prev, query: props.seed.text }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.seed.id])

  // Focus + select on open (VS Code re-selects the previous query).
  useLayoutEffect(() => {
    if (!props.open) return
    const input = inputRef.current
    if (input === null) return
    input.focus()
    input.select()
  }, [props.open])

  /**
   * Apply the current query, then advance to its first match.
   *
   * Step BEFORE reading the count: counting first reported the caret's match as
   * it was, so typing (the primary path) always read one match behind.
   */
  const runFind = (): void => {
    const view = props.view
    if (view === undefined) return
    const result = applyFind(view, state)
    if (result.total === 0) {
      setCount(result)
      return
    }
    stepFind(view, true, state)
    setCount(countFor(view))
  }

  /** The pending debounce run, so a step can cancel it (see `seek`). */
  const findTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  /**
   * Step the current query one match forward or back.
   *
   * Runs the pending query first (`applyFind`), so the editor is searched for
   * what is typed even when the user presses Enter before the 150 ms is up —
   * the editor's own query is what `findNext`/`findPrevious` walk, and without
   * the flush the step would run against the PREVIOUS query while the widget
   * displays the new one.
   *
   * The pending run is then cancelled, not just flushed: otherwise it fires a
   * moment later and advances a second time, and a single Enter would land two
   * matches on. (It would also reset a BACKWARD step to the first match.)
   */
  const seek = (forward: boolean): void => {
    const view = props.view
    if (view === undefined) return
    if (findTimer.current !== undefined) {
      clearTimeout(findTimer.current)
      findTimer.current = undefined
    }
    applyFind(view, state)
    stepFind(view, forward, state)
    refreshCount()
  }

  /**
   * Re-run the search whenever the query or the toggles change — debounced, the
   * way `SearchView` already runs its own query. Each run walks the whole
   * document, so running it per keystroke made typing the slowest thing the
   * widget did; 150 ms is still well inside "feels immediate". The cleanup also
   * cancels a run whose query was replaced, or whose widget was closed, before
   * it fired.
   */
  useEffect(() => {
    if (props.view === undefined || !props.open) return
    // Bare `setTimeout`, matching how `index.tsx` arms its timers: with the
    // node types in scope this is the `ReturnType<typeof setTimeout>` the ref
    // already declares, and `unref` stays an optional no-op in a browser.
    const timer = setTimeout(() => {
      findTimer.current = undefined
      runFind()
    }, 150)
    timer.unref?.()
    findTimer.current = timer
    return () => {
      clearTimeout(timer)
      findTimer.current = undefined
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, props.open, props.view])

  if (!props.open) return null

  /**
   * The count readout for where the caret is NOW. Reads the match list the
   * field already holds: stepping, clicking and arrowing repaint from it
   * instead of walking the document again.
   */
  const refreshCount = (): void => {
    if (props.view === undefined) return
    const next = countFor(props.view)
    setCount(previous => (previous.total === next.total && previous.index === next.index ? previous : next))
  }

  const patch = (next: Partial<FindState>): void => {
    setState(prev => ({ ...prev, ...next }))
  }

  const toggle = (key: 'caseSensitive' | 'wholeWord' | 'regexp', label: string): ReactNode => (
    <button
      type="button"
      className={`rvs-toggle${state[key] ? ' active' : ''}`}
      title={label}
      aria-pressed={state[key]}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => patch({ [key]: !state[key] })}
    >
      {key === 'caseSensitive' ? <span className="rvs-glyph">Aa</span>
        : key === 'wholeWord' ? <span className="rvs-glyph">ab<span className="rvs-glyph-underline">_</span></span>
          : <IconRegex size={13} />}
    </button>
  )

  return (
    <div
      className="rvs-find"
      role="search"
      style={props.anchor === undefined
        ? undefined
        : { position: 'fixed', top: props.anchor.top, right: props.anchor.right }}
    >
      <input
        ref={inputRef}
        className="rvs-find-input"
        placeholder="查找"
        value={state.query}
        spellCheck={false}
        onChange={(e) => patch({ query: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            seek(!e.shiftKey)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            props.onClose()
          } else if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
            // Ctrl+F while the widget is focused: re-select the query.
            e.preventDefault()
            e.currentTarget.select()
          }
          e.stopPropagation()
        }}
      />
      <span className="rvs-toggles">
        {toggle('caseSensitive', '区分大小写（Aa）')}
        {toggle('wholeWord', '全字匹配（ab_）')}
        {toggle('regexp', '正则表达式（.*）')}
      </span>
      <span className={count.total === 0 ? 'rvs-find-count none' : 'rvs-find-count'}>
        {state.query === '' ? '' : count.total === 0 ? '无结果' : `${count.index || 1}/${count.total}`}
      </span>
      <IconButton
        title="上一个（Shift+Enter）"
        onClick={() => seek(false)}
      >
        <span style={{ fontSize: 13 }}>↑</span>
      </IconButton>
      <IconButton
        title="下一个（Enter）"
        onClick={() => seek(true)}
      >
        <span style={{ fontSize: 13 }}>↓</span>
      </IconButton>
      <IconButton title="关闭（Esc）" onClick={props.onClose}>
        <IconClose size={11} />
      </IconButton>
    </div>
  )
}
