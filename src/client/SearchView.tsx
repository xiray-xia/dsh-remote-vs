/**
 * Search panel: one view, two modes.
 *
 *  - **文件名** — a remote `find -iname` (depth- and count-capped).
 *  - **内容** — a recursive remote `grep` with the VS Code option set
 *    (Aa / ab_ / .*), a scope field ("in folder"), and results grouped per
 *    file; clicking a hit opens the file at that line.
 *
 * The explorer's context menu raises a scoped request through the shared
 * store (`requestSearch`), which is what makes "Find in Folder…" work from the
 * tree without the two views knowing about each other.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  DEFAULT_CONTENT_OPTIONS,
  contentSearchCommand,
  groupHits,
  parseContentHits,
  splitMatches,
  type ContentHit,
} from '../search-ops.ts'
import { searchFiles, type SearchHit } from './scm/actions.ts'
import { repoRelative, useExplorer } from './store.tsx'
import { api } from './api.ts'
import { startDownload } from './downloads.ts'
import {
  ContextMenu,
  FileIcon,
  IconCase,
  IconContentSearch,
  IconFileSearch,
  IconFindInFolder,
  IconRegex,
  IconWholeWord,
  MiniSpinner,
  Segmented,
  baseName,
  copyText,
  toast,
  useContextMenu,
} from './vsc/kit.tsx'

type Mode = 'name' | 'content'

const MODE_KEY = 'dsh-remote-vs.search.mode'
const OPTIONS_KEY = 'dsh-remote-vs.search.options'

interface ContentOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

function readMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'content' ? 'content' : 'name'
  } catch {
    return 'name'
  }
}

function readOptions(): ContentOptions {
  try {
    const raw = localStorage.getItem(OPTIONS_KEY)
    if (raw === null) return { caseSensitive: false, wholeWord: false, regex: false }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { caseSensitive: false, wholeWord: false, regex: false }
    const { caseSensitive, wholeWord, regex } = parsed as Record<string, unknown>
    return { caseSensitive: caseSensitive === true, wholeWord: wholeWord === true, regex: regex === true }
  } catch {
    return { caseSensitive: false, wholeWord: false, regex: false }
  }
}

/** Path of `full` relative to `root` (the label under a result). */
function relativeTo(root: string, full: string): string {
  const base = root.replace(/\/+$/, '')
  if (full === base) return ''
  if (full.startsWith(`${base}/`)) return full.slice(base.length + 1)
  return full
}

export function SearchView(): ReactNode {
  const store = useExplorer()
  const { t, alias, root, repoRoot } = store
  const [mode, setModeState] = useState<Mode>(readMode)
  const [query, setQuery] = useState('')
  /** Absolute remote directory the search runs in ('' = workspace root). */
  const [scope, setScope] = useState('')
  const [options, setOptions] = useState<ContentOptions>(readOptions)

  const [nameHits, setNameHits] = useState<SearchHit[]>([])
  const [nameTruncated, setNameTruncated] = useState(false)
  const [contentHits, setContentHits] = useState<ContentHit[]>([])
  const [contentTruncated, setContentTruncated] = useState(false)
  const [linesClipped, setLinesClipped] = useState(false)
  const [busy, setBusy] = useState(false)
  const [ran, setRan] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const seq = useRef(0)
  const menu = useContextMenu()

  const effectiveScope = scope === '' ? root : scope
  const scopeLabel = useMemo(() => {
    if (effectiveScope === '' || root === '') return ''
    if (effectiveScope === root) return root
    return relativeTo(root, effectiveScope)
  }, [effectiveScope, root])

  const setMode = useCallback((next: Mode): void => {
    setModeState(next)
    try {
      localStorage.setItem(MODE_KEY, next)
    } catch {
      // Private mode: ignore.
    }
  }, [])

  const setOption = useCallback((patch: Partial<ContentOptions>): void => {
    // Persist OUTSIDE the updater: a state updater must be pure, and React may
    // invoke it more than once for one update (StrictMode, replay), which
    // would repeat the localStorage write.
    setOptions(prev => {
      const next = { ...prev, ...patch }
      try {
        localStorage.setItem(OPTIONS_KEY, JSON.stringify(next))
      } catch {
        // Private mode: ignore.
      }
      return next
    })
  }, [])

  const run = useCallback(async (text: string, activeMode: Mode, dir: string, opts: ContentOptions): Promise<void> => {
    const trimmed = text.trim()
    if (trimmed === '' || alias === '' || dir === '') {
      // Invalidate any in-flight request BEFORE bailing out: otherwise the
      // sequence counter keeps its old value, a late response still matches
      // its own ticket, and results for a query the user already cleared (or
      // for the previous workspace) get rendered into the empty panel.
      seq.current += 1
      setBusy(false)
      setNameHits([])
      setContentHits([])
      setRan(false)
      setError(undefined)
      return
    }
    const ticket = ++seq.current
    setBusy(true)
    setError(undefined)
    try {
      if (activeMode === 'name') {
        const result = await searchFiles(alias, dir, trimmed)
        if (seq.current !== ticket) return
        setNameHits(result.hits)
        setNameTruncated(result.truncated)
        setContentHits([])
      } else {
        const command = contentSearchCommand(dir, trimmed, {
          ...DEFAULT_CONTENT_OPTIONS,
          caseSensitive: opts.caseSensitive,
          wholeWord: opts.wholeWord,
          regex: opts.regex,
        })
        const result = await api.exec(alias, command, 120_000)
        if (seq.current !== ticket) return
        if (!result.success && result.stdout.trim() === '' && result.stderr.trim() !== '') {
          // grep exits 1 when nothing matched — that is a result, not a failure,
          // so only a non-empty stderr with no output counts as an error.
          setContentHits([])
          setContentTruncated(false)
          setLinesClipped(false)
          setError(result.stderr.trim())
        } else {
          // Pass the same caps the command above was built with, so the
          // "line clipped" flag reflects the real `cut` width.
          const parsed = parseContentHits(
            result.stdout,
            DEFAULT_CONTENT_OPTIONS.maxResults,
            DEFAULT_CONTENT_OPTIONS.maxLineChars,
          )
          setContentHits(parsed.hits)
          setContentTruncated(parsed.truncated)
          setLinesClipped(parsed.linesClipped)
          setNameHits([])
        }
      }
      setRan(true)
    } catch (caught) {
      if (seq.current !== ticket) return
      setError(caught instanceof Error ? caught.message : String(caught))
      setContentHits([])
      setNameHits([])
      setRan(true)
    } finally {
      if (seq.current === ticket) setBusy(false)
    }
  }, [alias])

  // Debounced run on every input change (query, mode, scope, toggles).
  useEffect(() => {
    const timer = setTimeout(() => { void run(query, mode, effectiveScope, options) }, 350)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, [query, mode, effectiveScope, options, run])

  // A scoped request from the tree ("Find in Folder…").
  const request = store.searchRequest
  useEffect(() => {
    if (request === undefined) return
    setMode(request.mode)
    setScope(request.scope === root ? '' : request.scope)
    setQuery(request.query)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id])

  /**
   * A hit ALWAYS opens the file.
   *
   * It used to open the diff instead whenever the file had a status mark, which
   * is wrong for a search result: the user is looking for the file, not for its
   * change, and for a path the index knows nothing about (untracked, or a mark
   * that belongs to another repository root) that "diff" rendered EMPTY — the
   * panel called it "no differences" and there was no way to see the content,
   * not even by double-clicking. The diff has its own entry points (the source
   * control panel and the change review dock).
   */
  const openHit = (path: string, line?: number): void => {
    store.openFile(path, line === undefined ? undefined : { line })
  }

  /** Absolute path of one NAME hit, plus the DIRECTORY a menu action should use. */
  const nameHitPaths = (hit: SearchHit): { abs: string; dir: string } => {
    const base = effectiveScope.replace(/\/+$/, '')
    const abs = `${base}/${hit.path}`
    // A directory hit (only the `find` fallback reports those) is its own
    // folder; a file hit's actions target the folder it lives in.
    const dir = hit.isDir ? abs : (abs.slice(0, abs.lastIndexOf('/')) || '/')
    return { abs, dir }
  }

  /** Download one found path (a file, or a directory as a `.tar.gz`). */
  const downloadHit = (hit: SearchHit): void => {
    const { abs } = nameHitPaths(hit)
    startDownload(alias, abs, { name: baseName(abs), directory: hit.isDir })
  }

  /**
   * Right-click on a name result: what one does with a found path.
   *
   * "Relative" is relative to the REPOSITORY when the workspace sits inside one
   * (the same relative form the tree's own menu copies), else absolute — which
   * is what makes the copied value paste straight into a shell that already ran
   * `cd` into the repo. Directories only get the copy/reveal/terminal entries:
   * there is no file to open in the editor.
   */
  const openHitMenu = (event: React.MouseEvent, hit: SearchHit): void => {
    event.preventDefault()
    event.stopPropagation()
    const { abs, dir } = nameHitPaths(hit)
    const rel = repoRelative(repoRoot, abs) || abs
    menu.open(event.clientX, event.clientY, [
      { label: t('files.copyAbs'), onSelect: () => { void copyText(abs); toast(t('files.copiedClipboard')) } },
      { label: t('files.copyRel'), onSelect: () => { void copyText(rel); toast(t('files.copiedClipboard')) } },
      { label: t('files.download'), onSelect: () => { downloadHit(hit) } },
      {
        label: t('files.openInFloat'),
        onSelect: () => { store.openInFloatEditor(abs) },
        disabled: !store.floatAvailable || hit.isDir,
        separated: true,
      },
      { label: t('search.revealInExplorer'), onSelect: () => { store.revealInExplorer(dir) } },
      { label: t('search.openInTerminal'), onSelect: () => { store.openTerminalAt(dir) } },
    ])
  }

  const groups = useMemo(() => groupHits(contentHits), [contentHits])

  /**
   * The content query, compiled ONCE per (text, flags) instead of once per
   * result row.
   *
   * `splitMatches` compiles a `RegExp` on every call, and it is called from
   * inside the row's JSX — so a 400-hit result rebuilt 400 regexes on every
   * render, and this panel re-renders on every store publish (it subscribes to
   * the whole store). Passing the compiled pattern down makes that one
   * compile per query change. A pattern that does not compile yields null, and
   * `splitMatches` falls back to the literal match it already implements.
   */
  const contentPattern = useMemo(() => {
    const text = query.trim()
    if (text === '' || !options.regex) return null
    try {
      return new RegExp(text, options.caseSensitive ? 'g' : 'gi')
    } catch {
      return null
    }
  }, [query, options.regex, options.caseSensitive])

  const toggle = (title: string, active: boolean, onClick: () => void, body: ReactNode): ReactNode => (
    <button
      type="button"
      className={`rvs-toggle${active ? ' active' : ''}`}
      title={title}
      aria-pressed={active}
      onClick={onClick}
    >
      {body}
    </button>
  )

  const count = mode === 'name' ? nameHits.length : contentHits.length

  return (
    <div className="rvs-pane grow">
      <div className="rvs-header">
        <span className="rvs-title">{t('tab.search')}</span>
        {busy && <MiniSpinner />}
        <span className="rvs-count">{count > 0 ? count : ''}</span>
      </div>

      <div className="rvs-search-row">
        <span className="rvs-node-icon" title={mode === 'name' ? t('search.modeNameHint') : t('search.modeContentHint')}>
          {mode === 'name' ? <IconFileSearch size={15} /> : <IconContentSearch size={15} />}
        </span>
        <Segmented<Mode>
          value={mode}
          onChange={setMode}
          options={[
            { id: 'name', label: t('search.modeName'), title: t('search.modeNameHint') },
            { id: 'content', label: t('search.modeContent'), title: t('search.modeContentHint') },
          ]}
        />
      </div>

      <div className="rvs-search-row" style={{ borderBottom: mode === 'content' ? 'none' : undefined }}>
        <input
          className="rvs-input"
          placeholder={mode === 'name' ? t('search.placeholder') : t('search.placeholderContent')}
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void run(query, mode, effectiveScope, options)
            } else if (e.key === 'Escape') {
              setQuery('')
            }
          }}
        />
        {mode === 'content' && (
          <span className="rvs-toggles">
            {toggle(t('search.matchCase'), options.caseSensitive, () => setOption({ caseSensitive: !options.caseSensitive }), <IconCase size={14} />)}
            {toggle(t('search.wholeWord'), options.wholeWord, () => setOption({ wholeWord: !options.wholeWord }), <IconWholeWord size={14} />)}
            {toggle(t('search.useRegex'), options.regex, () => setOption({ regex: !options.regex }), <IconRegex size={14} />)}
          </span>
        )}
      </div>

      {mode === 'content' && (
        <div className="rvs-search-row" style={{ paddingTop: 2 }}>
          <span className="rvs-scope-label" title={t('search.inFolder')}>{t('search.inFolder')}</span>
          <input
            className="rvs-input"
            placeholder={t('search.inFolderPlaceholder')}
            value={scopeLabel}
            spellCheck={false}
            onChange={(e) => {
              const value = e.target.value.trim()
              if (value === '' || value === root) {
                setScope('')
                return
              }
              setScope(value.startsWith('/') ? value : `${root.replace(/\/+$/, '')}/${value.replace(/^\.?\//, '')}`)
            }}
            onKeyDown={(e) => { if (e.key === 'Escape') setScope('') }}
          />
          <button type="button" className="rvs-hbtn" title={t('search.resetScope')} onClick={() => setScope('')}>
            <IconFindInFolder size={14} />
          </button>
        </div>
      )}

      {error !== undefined && <div className="rvs-banner error">{error}</div>}
      {contentTruncated && <div className="rvs-banner warn">{t('search.truncated')}</div>}
      {linesClipped && <div className="rvs-banner warn">{t('search.linesClipped')}</div>}

      <div className="rvs-scroll">
        {!ran && query.trim() === '' && (
          <div className="rvs-empty">{mode === 'name' ? t('search.hint') : t('search.hintContent')}</div>
        )}

        {mode === 'name' && (
          <>
            {ran && nameHits.length === 0 && query.trim() !== '' && <div className="rvs-empty">{t('search.empty')}</div>}
            {nameHits.map(hit => (
              <button
                key={hit.path}
                type="button"
                className="rvs-hit"
                title={hit.path}
                onClick={() => openHit(`${(effectiveScope === '' ? root : effectiveScope).replace(/\/+$/, '')}/${hit.path}`)}
                onContextMenu={(event) => { openHitMenu(event, hit) }}
              >
                <span className="rvs-node-icon">
                  {hit.isDir ? <span style={{ color: 'var(--rvs-fg3)' }}>▸</span> : <FileIcon path={hit.path} size={14} />}
                </span>
                <span className="rvs-hit-name">{hit.name}</span>
                {hit.dir !== '' && <span className="rvs-hit-dir">{hit.dir}</span>}
              </button>
            ))}
            {nameTruncated && <div className="rvs-empty">{t('search.truncated')}</div>}
          </>
        )}

        {mode === 'content' && (
          <>
            {ran && contentHits.length === 0 && query.trim() !== '' && error === undefined && (
              <div className="rvs-empty">{t('search.emptyContent').replace('{scope}', scopeLabel || root)}</div>
            )}
            {groups.map(group => (
              <div key={group.path}>
                <button
                  type="button"
                  className="rvs-hit rvs-hit-file"
                  title={group.path}
                  onClick={() => openHit(group.path, group.hits[0]?.line)}
                >
                  <span className="rvs-node-icon"><FileIcon path={group.path} size={14} /></span>
                  <span className="rvs-hit-name">{baseName(group.path)}</span>
                  <span className="rvs-hit-dir">{relativeTo(root, group.path)}</span>
                  <span className="rvs-hit-count">{group.hits.length}</span>
                </button>
                {group.hits.map(hit => (
                  <button
                    key={hit.line}
                    type="button"
                    className="rvs-hit rvs-hit-line"
                    title={`${group.path}:${hit.line}`}
                    onClick={() => openHit(group.path, hit.line)}
                  >
                    <span className="rvs-hit-lineno">{hit.line}</span>
                    <span className="rvs-hit-text">
                      {splitMatches(hit.text, query.trim(), options.regex, options.caseSensitive, contentPattern).map((part, index) => (
                        part.hit
                          ? <mark key={index} className="rvs-mark">{part.text}</mark>
                          : <span key={index}>{part.text}</span>
                      ))}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
      {menu.menu !== undefined && (
        <ContextMenu x={menu.menu.x} y={menu.menu.y} entries={menu.menu.entries} onClose={menu.close} />
      )}
    </div>
  )
}
