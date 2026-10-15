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
import type { EditorView } from '@codemirror/view'
import { SearchQuery, findNext, findPrevious, setSearchQuery } from '@codemirror/search'
import { IconButton, IconClose, IconRegex } from './kit.tsx'

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

/** Push the query into the editor (highlights every match) and count them. */
export function applyFind(view: EditorView, state: FindState): { total: number; index: number } {
  try {
    view.dispatch({ effects: setSearchQuery.of(toQuery(state)) })
  } catch {
    // A malformed pattern must not break typing.
  }
  return inspect(view, state)
}

export function stepFind(view: EditorView, forward: boolean): void {
  try {
    if (forward) findNext(view)
    else findPrevious(view)
  } catch {
    // Ignore: nothing to step to.
  }
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
    setCount(result)
    if (state.query !== '' && result.total > 0) stepFind(view, true)
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
              stepFind(props.view, !e.shiftKey)
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
          stepFind(props.view, false)
          setCount(inspect(props.view, state))
        }}
      >
        <span style={{ fontSize: 13 }}>↑</span>
      </IconButton>
      <IconButton
        title="下一个（Enter）"
        onClick={() => {
          if (props.view === undefined) return
          stepFind(props.view, true)
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
