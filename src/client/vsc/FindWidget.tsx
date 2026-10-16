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

function marksFor(query: SearchQuery | null, state: EditorState): DecorationSet {
  if (query === null || !query.valid) return Decoration.none
  const cursor = query.getCursor(state)
  const found: { from: number; to: number }[] = []
  for (let step = cursor.next(); step.done !== true; step = cursor.next()) {
    // Guard the loop, not just the array: a zero-width match could otherwise
    // keep producing values without ever reaching the cap.
    if (found.length >= MATCH_CAP) break
    found.push({ from: step.value.from, to: step.value.to })
  }
  if (found.length === 0) return Decoration.none
  found.sort((left, right) => left.from - right.from)
  const caret = state.selection.main.from
  return Decoration.set(found.map(span =>
    (span.from === caret ? currentMark : matchMark).range(span.from, span.to)))
}

const matchField = StateField.define<{ query: SearchQuery | null; marks: DecorationSet }>({
  create: () => ({ query: null, marks: Decoration.none }),
  update(value, tr) {
    const effect = tr.effects.find(item => item.is(setFindQuery))
    if (effect !== undefined) {
      const query = effect.value
      return { query, marks: marksFor(query, tr.state) }
    }
    // Edits or a moved caret can both change which matches exist / is current.
    if (tr.docChanged || tr.selection !== undefined) {
      return { query: value.query, marks: marksFor(value.query, tr.state) }
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

/** Count matches and report the 1-based position of the caret's match. */
function inspect(view: EditorView, state: FindState): { total: number; index: number } {
  if (state.query === '') return { total: 0, index: 0 }
  const query = toQuery(state)
  const selection = view.state.selection.main
  let total = 0
  let index = 0
  try {
    for (let cursor = query.getCursor(view.state); ;) {
      const step = cursor.next()
      if (step.done === true) break
      total += 1
      if (step.value.from === selection.from) index = total
      if (total > 5000) break
    }
  } catch {
    // An invalid regex: the panel shows "no results" instead of throwing.
    return { total: 0, index: 0 }
  }
  return { total, index }
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

/** Push the query into the editor (highlights every match) and count them. */
export function applyFind(view: EditorView, state: FindState): { total: number; index: number } {
  let query: SearchQuery | null = null
  try {
    query = toQuery(state)
    view.dispatch({ effects: [setSearchQuery.of(query), setFindQuery.of(query)] })
  } catch {
    // A malformed pattern must not break typing; clear the marks instead of
    // leaving the previous query's highlights on screen.
    view.dispatch({ effects: setFindQuery.of(null) })
  }
  return inspect(view, state)
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

  // Re-run the search whenever the query or the toggles change.
  useEffect(() => {
    const view = props.view
    if (view === undefined || !props.open) return
    const result = applyFind(view, state)
    // Step BEFORE the final count: the old order counted the caret's match as
    // it was before the step, so typing (the primary path) always read one
    // match behind the editor while Enter/↑/↓ read correctly.
    if (result.total > 0) stepFind(view, true, state)
    setCount(result.total > 0 ? inspect(view, state) : result)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, props.open, props.view])

  if (!props.open) return null

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
            if (props.view !== undefined) {
              stepFind(props.view, !e.shiftKey, state)
              setCount(inspect(props.view, state))
            }
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
        onClick={() => {
          if (props.view === undefined) return
          stepFind(props.view, false, state)
          setCount(inspect(props.view, state))
        }}
      >
        <span style={{ fontSize: 13 }}>↑</span>
      </IconButton>
      <IconButton
        title="下一个（Enter）"
        onClick={() => {
          if (props.view === undefined) return
          stepFind(props.view, true, state)
          setCount(inspect(props.view, state))
        }}
      >
        <span style={{ fontSize: 13 }}>↓</span>
      </IconButton>
      <IconButton title="关闭（Esc）" onClick={props.onClose}>
        <IconClose size={11} />
      </IconButton>
    </div>
  )
}
