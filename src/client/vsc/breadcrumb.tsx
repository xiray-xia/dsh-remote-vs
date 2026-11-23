/**
 * Breadcrumb above the editor in the full-width (conversation view) variant.
 *
 * Every path segment is clickable and opens a VS Code-style sibling picker: a
 * directory segment lists itself, the file segment lists its parent directory,
 * so "open the file next to this one" costs one click instead of a trip to the
 * tree (whose expansion state lives in another view and cannot be expressed in
 * a URL).
 *
 * Read-only: it only calls `fileOp.list` on the remote. The remote path is the
 * Host's own business — no second validation layer here.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { api } from '../api.ts'
import type { RemoteFileEntry } from '../../protocol.ts'

/** One breadcrumb segment. */
interface Crumb {
  /** Display text. */
  label: string
  /** Absolute remote path. */
  path: string
}

/** Split an absolute POSIX path into segments (empty path = empty list). */
function pathSegments(path: string): string[] {
  return path.replace(/\\/g, '/').split('/').filter(part => part !== '')
}

/** Root display name: the binding's name, else the last segment of the root. */
function rootLabel(root: string, rootName: string, fallback: string): string {
  if (rootName !== '') return rootName
  const parts = pathSegments(root)
  return parts[parts.length - 1] ?? fallback
}

/** Open dropdown state. */
interface MenuState {
  /** Absolute directory being listed. */
  dir: string
  /** Menu's left edge, relative to the breadcrumb container (px). */
  left: number
}

/** Props of {@link Breadcrumb}. */
export interface BreadcrumbProps {
  /** i18n lookup (falls back to inline copy when a key is missing). */
  t: (key: string) => string
  /** SSH host alias the workspace lives on (the file route's first argument). */
  alias: string
  /** Remote workspace root, absolute. */
  root: string
  /** Display name of the workspace root. */
  rootName: string
  /** Absolute path of the file on screen. */
  path: string
  /** Open one remote file in the editor. */
  onOpen: (fullPath: string) => void
}

/** Translate one key, falling back to the inline copy when the dictionary lacks it. */
function tr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key)
  return value === undefined || value === '' || value === key ? fallback : value
}

/** Breadcrumb: path segments + sibling dropdown. */
export function Breadcrumb(props: BreadcrumbProps): ReactNode {
  const navRef = useRef<HTMLElement>(null)
  const [menu, setMenu] = useState<MenuState | undefined>(undefined)
  const [entries, setEntries] = useState<RemoteFileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  /** Load token: two quick segment clicks must only let the last answer land. */
  const loadSeq = useRef(0)

  const t = props.t
  const root = props.root.replace(/\/+$/, '')
  const segments = useMemo(() => {
    const full = props.path.replace(/\/+$/, '')
    if (root !== '' && full.startsWith(`${root}/`)) return pathSegments(full.slice(root.length + 1))
    return pathSegments(full)
  }, [props.path, root])
  const crumbs = useMemo<Crumb[]>(() => {
    const list: Crumb[] = [{ label: rootLabel(root, props.rootName, tr(t, 'editor.crumbRoot', '工作区')), path: root }]
    for (const [index, segment] of segments.entries()) {
      list.push({ label: segment, path: `${root}/${segments.slice(0, index + 1).join('/')}` })
    }
    return list
  }, [root, props.rootName, segments, t])

  /** List one directory and show the menu; `left` keeps the current position. */
  const openMenu = (dir: string, left: number): void => {
    setMenu({ dir, left })
    setLoading(true)
    setError(undefined)
    loadSeq.current += 1
    const token = loadSeq.current
    void (async () => {
      try {
        const listed = await api.fileOp.list(props.alias, dir)
        if (loadSeq.current !== token) return
        // Directories first, then names: same order as the tree, faster to scan.
        const sorted = [...listed].sort((a, b) => {
          const aDir = a.isDir ? 0 : 1
          const bDir = b.isDir ? 0 : 1
          if (aDir !== bDir) return aDir - bDir
          return a.name.localeCompare(b.name)
        })
        setEntries(sorted)
      } catch (caught) {
        if (loadSeq.current !== token) return
        setEntries([])
        setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        if (loadSeq.current === token) setLoading(false)
      }
    })()
  }

  // Close on an outside click / Esc. Capture phase: CodeMirror's own mousedown
  // handling must not run first (it grabs focus back and the menu looks stuck).
  useEffect(() => {
    if (menu === undefined) return
    const onMouseDown = (event: MouseEvent): void => {
      const nav = navRef.current
      if (nav !== null && event.target instanceof Node && nav.contains(event.target)) return
      setMenu(undefined)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      // During IME composition Esc cancels the candidate, not the menu.
      if (event.isComposing) return
      if (event.key === 'Escape') setMenu(undefined)
    }
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [menu])

  // Another file closes the menu: a stale dropdown over a new file is misaligned.
  useEffect(() => {
    setMenu(undefined)
  }, [props.path])

  /** Click a segment: a directory lists itself; the file lists its parent. */
  const clickCrumb = (crumb: Crumb, index: number, event: ReactMouseEvent<HTMLButtonElement>): void => {
    const isFile = index === crumbs.length - 1
    const dir = isFile ? crumb.path.slice(0, Math.max(0, crumb.path.lastIndexOf('/'))) : crumb.path
    openMenu(dir === '' ? '/' : dir, Math.max(0, event.currentTarget.offsetLeft))
  }

  const parentDirOf = (dir: string): string | undefined => {
    if (dir === '' || dir === root || dir === '/') return undefined
    const parts = pathSegments(dir)
    parts.pop()
    return parts.length === 0 ? undefined : `/${parts.join('/')}`
  }

  return (
    <nav className="rvs-breadcrumb" ref={navRef} aria-label={tr(t, 'editor.crumbLabel', '文件路径')}>
      {crumbs.map((crumb, index) => {
        const isFile = index === crumbs.length - 1
        return (
          <span className="rvs-crumb-wrap" key={`${crumb.path}:${index}`}>
            {index > 0 && <span className="rvs-crumb-sep" aria-hidden="true">›</span>}
            <button
              type="button"
              className={`rvs-crumb${isFile ? ' rvs-crumb-file' : ''}`}
              title={isFile
                ? props.path
                : tr(t, 'editor.crumbPickSibling', '{path}（点击选择同级文件）').replace('{path}', crumb.path)}
              aria-haspopup="menu"
              onClick={event => clickCrumb(crumb, index, event)}
            >
              {crumb.label}
            </button>
          </span>
        )
      })}

      {menu !== undefined && (
        <div className="rvs-crumb-menu" role="menu" style={{ left: menu.left }}>
          <div className="rvs-crumb-menu-head">
            <button
              type="button"
              className="rvs-crumb-menu-up"
              title={tr(t, 'editor.crumbUp', '上一级')}
              disabled={parentDirOf(menu.dir) === undefined}
              onClick={() => {
                const parent = parentDirOf(menu.dir)
                if (parent === undefined) return
                openMenu(parent, menu.left)
              }}
            >
              ↑
            </button>
            <span className="rvs-crumb-menu-path" title={menu.dir}>{menu.dir}</span>
          </div>
          <div className="rvs-crumb-menu-list">
            {loading && <div className="rvs-crumb-menu-note">{tr(t, 'common.loading', '加载中…')}</div>}
            {!loading && error !== undefined && <div className="rvs-crumb-menu-note rvs-status-error">{error}</div>}
            {!loading && error === undefined && entries.length === 0 && (
              <div className="rvs-crumb-menu-note">{tr(t, 'editor.crumbEmpty', '空目录')}</div>
            )}
            {!loading && error === undefined && entries.map(entry => (
              <button
                key={entry.path}
                type="button"
                role="menuitem"
                className={`rvs-crumb-menu-item${entry.isDir ? ' rvs-dir' : ''}`}
                title={entry.path}
                onClick={() => {
                  if (entry.isDir) {
                    openMenu(entry.path, menu.left)
                    return
                  }
                  // Stay on the surface this breadcrumb belongs to: no sidebar jump.
                  props.onOpen(entry.path)
                  setMenu(undefined)
                }}
              >
                <span className="rvs-crumb-menu-glyph" aria-hidden="true">{entry.isDir ? '▸' : '·'}</span>
                <span className="rvs-crumb-menu-name">{entry.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </nav>
  )
}
