/**
 * Ctrl+P quick open: the portal modal, its list and its keyboard handling.
 *
 * Mounted by `RemoteRoot` only while it is open, so unmounting IS closing (no
 * "is it visible" state to keep in sync), and it reads the same store the tree
 * does: opening a hit is one `store.openFile()`, which makes a quick-open file
 * indistinguishable from one opened in the tree — including cross-workspace
 * binding resolution and the "already open → activate" rule.
 *
 * The index, scoring and the remote command live in `quickopen-model.ts` (pure, and
 * covered by `scripts/check-quickopen.mjs`); this file owns pixels, focus and
 * keys only.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { api, remoteWriteSequence } from './api.ts'
import {
  QUICKOPEN_RESULT_LIMIT,
  absoluteFromRoot,
  applyIndexFailure,
  applyIndexResult,
  beginIndexBuild,
  buildFileIndex,
  errorText,
  failIndexNow,
  indexNeedsRebuild,
  loadRecentFiles,
  matchPositions,
  quickOpenIndexState,
  rankFiles,
  relativeToRoot,
  rememberRecentFile,
  replaceQuickOpenIndexState,
  splitPath,
  subscribeQuickOpenIndex,
} from './quickopen-model.ts'
import { useExplorer } from './store.tsx'
import { MiniSpinner } from './vsc/kit.tsx'

/** One result row: directory dimmed, file name with the matched characters marked. */
function Row(props: {
  path: string
  query: string
  active: boolean
  index: number
  onPick: () => void
  onHover: () => void
}): ReactNode {
  const { dir, name } = splitPath(props.path)
  const positions = useMemo(() => new Set(matchPositions(props.query, name)), [props.query, name])
  return (
    <div
      className={props.active ? 'rvs-qo-row active' : 'rvs-qo-row'}
      role="option"
      aria-selected={props.active}
      id={`rvs-qo-option-${props.index}`}
      data-qo-index={props.index}
      // mousedown, not click: the list must not lose focus to the page before
      // the pick runs, and a click after a re-render could land on a different
      // row than the one the user pointed at.
      onMouseDown={(event) => {
        event.preventDefault()
        props.onPick()
      }}
      onMouseEnter={props.onHover}
    >
      {dir !== '' && <span className="rvs-qo-dir" title={dir}>{dir}</span>}
      <span className="rvs-qo-name">
        {/* `split('')` keeps the indices code-unit aligned with the offsets
            `matchPositions` produced (`Array.from` would iterate code points
            and shift astral characters out of place). */}
        {name.split('').map((character, at) => (
          positions.has(at)
            ? <mark key={at} className="rvs-qo-hit">{character}</mark>
            : <span key={at}>{character}</span>
        ))}
      </span>
    </div>
  )
}

export function QuickOpen(props: { onClose: () => void }): ReactNode {
  const store = useExplorer()
  const t = store.t
  const alias = store.alias
  const root = store.root
  /**
   * The index is a MODULE cache, not component state.
   *
   * A listing outlives the modal that started it: closing and reopening while it
   * is in flight must show its result when it lands, and reopening must reuse a
   * listing that is still valid. Both are properties of the cache, so the
   * component subscribes to it instead of keeping a copy (see `quickopen-model.ts`).
   */
  const state = useSyncExternalStore(subscribeQuickOpenIndex, quickOpenIndexState)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  /** Latest close handler, for the window listener installed once below. */
  const closeRef = useRef(props.onClose)
  closeRef.current = props.onClose

  /**
   * Where focus was before the modal opened.
   *
   * The sheet is portaled to `<body>`, so nothing restores focus by itself: the
   * keyboard user would be dumped on the document body after Esc, one Tab away
   * from wherever they were working. Same rule the themed dialogs follow.
   */
  const openerRef = useRef<HTMLElement | null>(
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  )

  useEffect(() => {
    inputRef.current?.focus()
    return () => {
      const opener = openerRef.current
      if (opener !== null && document.body.contains(opener)) opener.focus()
    }
  }, [])

  /**
   * Tab stays inside the sheet.
   *
   * There is exactly one focusable control (the query field) and the rows are
   * `role="option"` items driven from it, so without a trap the first Tab lands
   * on the page behind the mask — with the modal still open and covering it.
   */
  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return
    const box = boxRef.current
    if (box === null) return
    const items = Array.from(box.querySelectorAll<HTMLElement>(
      'input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ))
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    const at = document.activeElement
    const inside = at !== null && box.contains(at)
    if (!inside) {
      event.preventDefault()
      first.focus()
      return
    }
    if (event.shiftKey && at === first) {
      event.preventDefault()
      last.focus()
      return
    }
    if (!event.shiftKey && at === last) {
      event.preventDefault()
      first.focus()
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  /**
   * Build the index on open, when the cached one cannot answer.
   *
   * The failure branch MUST NOT be turned into an empty index: the footer prints
   * the reason, which is what keeps "the host is unreachable" from looking like
   * "this tree has no files".
   */
  useEffect(() => {
    if (alias === '' || root === '') {
      replaceQuickOpenIndexState(failIndexNow(t('quickopen.noWorkspace')))
      return
    }
    const writeSeq = remoteWriteSequence()
    if (!indexNeedsRebuild(quickOpenIndexState(), alias, root, writeSeq)) return
    replaceQuickOpenIndexState(beginIndexBuild(quickOpenIndexState(), alias, root))
    // The answer is published to the cache whether or not this mount still
    // exists: the next open must see it (and an in-flight build must not leave
    // the footer saying "building…" for a modal that re-opened mid-flight).
    //
    // Both settles read the CURRENT cache state, never the state this effect
    // captured: the settle helpers drop a result whose workspace is no longer
    // the one on screen (the user switched while the listing was in flight), and
    // `target` is what they compare against.
    const target = { alias, root }
    void buildFileIndex({ exec: api.exec, writeSequence: remoteWriteSequence }, target)
      .then(
        index => replaceQuickOpenIndexState(applyIndexResult(quickOpenIndexState(), index)),
        (error: unknown) => replaceQuickOpenIndexState(applyIndexFailure(quickOpenIndexState(), errorText(error), target)),
      )
  }, [alias, root, t])

  /**
   * Recent files, as workspace-relative paths.
   *
   * Stored absolute (that is what `openFile` takes) and filtered to the CURRENT
   * root: an entry from another workspace must not be shown here, because Enter
   * on it would act on a path whose binding is no longer on screen.
   */
  const recent = useMemo(() => {
    if (alias === '' || root === '') return []
    const list: string[] = []
    for (const absolute of loadRecentFiles(alias)) {
      const relative = relativeToRoot(root, absolute)
      if (relative !== undefined && relative !== '') list.push(relative)
    }
    return list
  }, [alias, root])

  const showingRecent = query.trim() === ''
  const candidates = showingRecent ? recent : (state.index?.paths ?? [])
  const ranked = useMemo(
    () => rankFiles(query, candidates, QUICKOPEN_RESULT_LIMIT),
    [query, candidates],
  )
  const count = ranked.hits.length
  const current = count === 0 ? -1 : Math.min(active, count - 1)

  // A new query (or a new index) starts at the top, never on a stale row.
  useEffect(() => {
    setActive(0)
  }, [query, state.phase, state.index])

  useEffect(() => {
    if (current < 0) return
    const row = listRef.current?.querySelector<HTMLElement>(`[data-qo-index="${current}"]`)
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [current])

  const pick = (relative: string): void => {
    if (alias === '' || root === '') return
    const absolute = absoluteFromRoot(root, relative)
    rememberRecentFile(alias, absolute)
    store.openFile(absolute)
    props.onClose()
  }

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    // An IME candidate window uses Enter and the arrows to pick characters.
    // Acting on them would open a file while the user is still composing a
    // Chinese/Japanese/Korean query — a real mis-click for anyone searching a
    // tree by a localized file name. `isComposing` is the platform-agnostic
    // signal; `keyCode === 229` is the older Safari/Chrome fallback.
    if (event.nativeEvent.isComposing === true || event.keyCode === 229) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (count === 0) return
      setActive((previous) => {
        const at = Math.min(previous, count - 1)
        if (event.key === 'ArrowDown') return (at + 1) % count
        return at <= 0 ? count - 1 : at - 1
      })
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const target = current >= 0 ? ranked.hits[current] : undefined
      if (target !== undefined) pick(target)
    }
  }

  /**
   * The status line under the list.
   *
   * Priority is deliberate: a failure and a build in progress are NOT "no
   * results" and are said first. Truncation is a SECOND line rather than a
   * replacement, because "this index only covers N files" is a standing caveat —
   * it must not hide "nothing matched your query" (nor the other way round).
   */
  const note = (): ReactNode => {
    if (state.phase === 'error') {
      return (
        <span className="rvs-qo-note error" role="status">
          {t('quickopen.indexError').replace('{reason}', state.error ?? '')}
        </span>
      )
    }
    if (state.phase === 'loading') {
      return <span className="rvs-qo-note" role="status"><MiniSpinner /> {t('quickopen.indexing')}</span>
    }
    if (showingRecent) {
      return count === 0
        ? <span className="rvs-qo-note">{t('quickopen.emptyRecent')}</span>
        : <span className="rvs-qo-note">{t('quickopen.recent')}</span>
    }
    if (count === 0) return <span className="rvs-qo-note">{t('quickopen.noResults')}</span>
    if (ranked.truncated) return <span className="rvs-qo-note">{t('quickopen.more')}</span>
    return null
  }

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="rvs-portal">
      <div
        className="rvs-qo-mask"
        onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose() }}
      >
        <div
          className="rvs-qo"
          role="dialog"
          aria-modal="true"
          aria-label={t('quickopen.title')}
          ref={boxRef}
          onKeyDown={onDialogKeyDown}
        >
          <div className="rvs-qo-bar">
            <input
              ref={inputRef}
              className="rvs-qo-input"
              type="text"
              value={query}
              placeholder={t('quickopen.placeholder')}
              spellCheck={false}
              autoComplete="off"
              role="combobox"
              aria-expanded
              aria-controls="rvs-qo-list"
              aria-activedescendant={current >= 0 ? `rvs-qo-option-${current}` : undefined}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKeyDown}
            />
            <span className="rvs-qo-hint">{t('quickopen.hint')}</span>
          </div>
          <div className="rvs-qo-list" id="rvs-qo-list" role="listbox" ref={listRef}>
            {ranked.hits.map((path, index) => (
              <Row
                key={path}
                path={path}
                query={query}
                active={index === current}
                index={index}
                onPick={() => pick(path)}
                onHover={() => setActive(index)}
              />
            ))}
          </div>
          <div className="rvs-qo-foot">
            {note()}
            {state.index?.truncated === true && (
              <span className="rvs-qo-note warn" role="status">
                {t('quickopen.truncated').replace('{count}', String(state.index.paths.length))}
              </span>
            )}
            {state.index?.depthCapped !== undefined && (
              <span className="rvs-qo-note warn" role="status">
                {t('quickopen.depthCapped')
                  .replace('{depth}', String(state.index.depthCapped))
                  .replace('{count}', String(state.index.paths.length))}
              </span>
            )}
            {state.index?.warning !== undefined && (
              <span className="rvs-qo-note warn" role="status">
                {t('quickopen.warning').replace('{detail}', state.index.warning)}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
