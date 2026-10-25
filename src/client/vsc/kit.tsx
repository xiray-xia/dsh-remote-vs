/**
 * The VS Code-style widget kit shared by every new surface: icons, the
 * file-kind helpers, the themed context menu, and the modal/toast layer that
 * replaces `window.confirm` / `window.prompt` (the reference implementation
 * ships the same split, and the confirm dialogs are what guard destructive
 * remote git verbs).
 *
 * Icon sourcing: when dsh-better-sidebar is installed its service answers
 * `fileIcon` / `folderIcon`, which run the host's own classifier and any
 * user-registered icon theme — the remote tree then matches the user's local
 * sidebar glyph for glyph. Without that service the built-in SVG set below
 * takes over, so the native fallback surface still renders a real tree.
 */
import {
  createElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

// ------------------------------------------------------------------ icons

type IconProps = { size?: number; className?: string }

function svg(size: number, children: ReactNode, className?: string): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  )
}

export function IconChevronRight(props: IconProps): ReactNode {
  return svg(props.size ?? 14, <path d="M6 3.5 L10.5 8 L6 12.5" />, props.className)
}

export function IconChevronDown(props: IconProps): ReactNode {
  return svg(props.size ?? 14, <path d="M3.5 6 L8 10.5 L12.5 6" />, props.className)
}

/** Mirror of `IconChevronDown`, for the diff's "previous change" button. */
export function IconChevronUp(props: IconProps): ReactNode {
  return svg(props.size ?? 14, <path d="M3.5 10 L8 5.5 L12.5 10" />, props.className)
}

export function IconFolder(props: IconProps & { open?: boolean }): ReactNode {
  return props.open === true
    ? svg(props.size ?? 16, <path d="M1.8 12.6V4.2a1 1 0 0 1 1-1h3l1.4 1.6h6a1 1 0 0 1 1 1v1H2.6l1 5.8a1 1 0 0 0 1 .8h7.6" />, props.className)
    : svg(props.size ?? 16, <path d="M1.8 12.6V4.2a1 1 0 0 1 1-1h3l1.4 1.6h6a1 1 0 0 1 1 1v6.8a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1Z" />, props.className)
}

export function IconFile(props: IconProps): ReactNode {
  return svg(props.size ?? 16, <path d="M3.5 2.2h5.2L12.5 6v7.8a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1V3.2a1 1 0 0 1 1-1Zm5.2 0v4h3.8" />, props.className)
}

export function IconRefresh(props: IconProps): ReactNode {
  return svg(props.size ?? 14, <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.4V5.2h-2.8" />, props.className)
}

export function IconPlus(props: IconProps): ReactNode {
  return svg(props.size ?? 14, <path d="M8 3.2v9.6M3.2 8h9.6" />, props.className)
}

export function IconNewFolder(props: IconProps): ReactNode {
  return svg(props.size ?? 14, <path d="M1.8 12.6V4.2a1 1 0 0 1 1-1h3l1.4 1.6h5.9a1 1 0 0 1 1 1v6.8a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1Zm7-5.4v3.4m-1.7-1.7h3.4" />, props.className)
}

export function IconTrash(props: IconProps): ReactNode {
  return svg(props.size ?? 14, <path d="M3 4.4h10M6.2 4.4V2.9h3.6v1.5M4.3 4.4l.6 8.3a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.6-8.3" />, props.className)
}

export function IconClose(props: IconProps): ReactNode {
  return svg(props.size ?? 12, <path d="M4 4l8 8M12 4l-8 8" />, props.className)
}

export function IconSearch(props: IconProps): ReactNode {
  return svg(props.size ?? 16, <path d="M10.6 10.6 14 14M11.8 7.2a4.6 4.6 0 1 1-9.2 0 4.6 4.6 0 0 1 9.2 0Z" />, props.className)
}

/**
 * "Search file NAMES": a page with a magnifier tucked into its lower-right
 * corner — the page reads as "a file", the magnifier as "find it by name".
 */
export function IconFileSearch(props: IconProps): ReactNode {
  return svg(props.size ?? 16, (
    <>
      <path d="M3 2.2h5.4L11 4.7v3.1M8.4 2.2v2.5H11" />
      <path d="M3 2.2v11.6h4M3.6 5.6h3M3.6 8h2.2" />
      <circle cx="10.6" cy="10.6" r="2.7" />
      <path d="M12.6 12.6 14.4 14.4" />
    </>
  ), props.className)
}

/**
 * "Search file CONTENTS": three text lines with a magnifier over the last one
 * — "look inside the lines", the counterpart to {@link IconFileSearch}'s
 * whole-file glyph, so the mode toggle reads at a glance.
 */
export function IconContentSearch(props: IconProps): ReactNode {
  return svg(props.size ?? 16, (
    <>
      <path d="M2.6 3.4h8.2M2.6 6.4h5.4M2.6 9.4h2.6" />
      <circle cx="10.4" cy="10.2" r="2.7" />
      <path d="M12.4 12.2 14.2 14" />
    </>
  ), props.className)
}

/** "Find in Folder…": a folder with a magnifier on its lower-right corner. */
export function IconFindInFolder(props: IconProps): ReactNode {
  return svg(props.size ?? 16, (
    <>
      <path d="M1.6 12.4V4.2a1 1 0 0 1 1-1h3l1.4 1.6h4.2a1 1 0 0 1 1 1v1.1" />
      <path d="M1.6 12.4a1 1 0 0 0 1 .8h5.1" />
      <circle cx="10.9" cy="10.6" r="2.6" />
      <path d="M12.8 12.5 14.4 14.1" />
    </>
  ), props.className)
}

/**
 * The three search options, drawn as the glyphs everyone already knows from
 * VS Code: `Aa` (match case), `ab_` (whole word), `.*` (regex). They are text
 * rather than SVG on purpose — a drawn "Aa" reads worse at 14px than the
 * letters themselves, and the shapes stay recognizable in any UI language.
 */
export function IconCase(props: IconProps): ReactNode {
  return (
    <span className="rvs-glyph" aria-hidden="true" style={{ fontSize: props.size === undefined ? 13 : props.size - 1 }}>
      Aa
    </span>
  )
}

export function IconWholeWord(props: IconProps): ReactNode {
  return (
    <span className="rvs-glyph" aria-hidden="true" style={{ fontSize: props.size === undefined ? 13 : props.size - 1 }}>
      ab<span className="rvs-glyph-underline">_</span>
    </span>
  )
}

export function IconRegex(props: IconProps): ReactNode {
  return (
    <span className="rvs-glyph" aria-hidden="true" style={{ fontSize: props.size === undefined ? 13 : props.size - 1 }}>
      .*
    </span>
  )
}

export function IconBranch(props: IconProps): ReactNode {
  return svg(props.size ?? 16, <path d="M4.6 13.2V5M4.6 5a1.9 1.9 0 1 0 0-.1ZM11.4 4.4a1.9 1.9 0 1 0 0-.1ZM11.4 6.3v1.2a3 3 0 0 1-3 3h-3" />, props.className)
}

export function IconHistory(props: IconProps): ReactNode {
  return svg(props.size ?? 16, <path d="M8 4.2V8l2.6 1.6M2.4 8a5.6 5.6 0 1 0 1.7-4M2.4 2.6V6h3.4" />, props.className)
}

export function IconTerminal(props: IconProps): ReactNode {
  return svg(props.size ?? 16, <path d="M2 3.2h12v9.6H2zM4.4 6.4 6.6 8.4 4.4 10.4M8 10.8h3.4" />, props.className)
}

export function IconServer(props: IconProps): ReactNode {
  return svg(props.size ?? 16, <path d="M2.4 3h11.2v4H2.4zM2.4 9h11.2v4H2.4zM4.4 5h.01M4.4 11h.01" />, props.className)
}

export function IconCode(props: IconProps): ReactNode {
  return svg(props.size ?? 16, <path d="M5.6 4 2 8l3.6 4M10.4 4 14 8l-3.6 4" />, props.className)
}

export function IconCheck(props: IconProps): ReactNode {
  return svg(props.size ?? 14, <path d="M3.2 8.4 6.4 11.6 12.8 5.2" />, props.className)
}

export function IconUndo(props: IconProps): ReactNode {
  return svg(props.size ?? 14, <path d="M3.2 7.6h6.2a3.4 3.4 0 0 1 0 6.8H6M3.2 7.6 6 4.8M3.2 7.6 6 10.4" />, props.className)
}

export function IconDiff(props: IconProps): ReactNode {
  return svg(props.size ?? 14, <path d="M2.6 3.6h10.8M5.4 8h8M5.4 12.4h8M2.6 8h.01M2.6 12.4h.01" />, props.className)
}

export function IconImage(props: IconProps): ReactNode {
  return svg(props.size ?? 14, <path d="M2.4 3.4h11.2v9.2H2.4zM5.4 6.6h.01M9.6 12.6 6.8 9.4l-2 2.4M9.6 12.6l2.4-3.2 1.6 1.8" />, props.className)
}

export function IconSync(props: IconProps): ReactNode {
  return svg(props.size ?? 14, <path d="M13 8a5 5 0 0 1-8.6 3.4M3 8a5 5 0 0 1 8.6-3.4M11.6 2.4v2.6H9M4.4 13.6v-2.6H7" />, props.className)
}

export function IconSave(props: IconProps): ReactNode {
  return svg(props.size ?? 14, <path d="M3 2.6h8l2.4 2.4v8.4H3zM5.4 2.6v4h5.2v-4M5.4 13.4V9.8h5.2v3.6" />, props.className)
}

/** Upload: an arrow into a tray (the explorer's drag & drop / upload affordance). */
export function IconUpload(props: IconProps): ReactNode {
  return svg(props.size ?? 14, <path d="M8 10.6V2.6M4.6 6 8 2.6 11.4 6M2.6 11.2v2.2h10.8v-2.2" />, props.className)
}

// ------------------------------------------------- better-sidebar icons

/** The slice of the better-sidebar service this kit consumes. */
export interface IconServiceLike {
  fileIcon(path: string, size: number): ReactNode
  folderIcon(path: string, open: boolean, size: number): ReactNode
}

let iconService: IconServiceLike | undefined

/** Install the host icon provider (called once from the client entry). */
export function setIconService(service: IconServiceLike | undefined): void {
  iconService = service
}

/** Attempt the host provider, falling back to the built-in glyphs. */
function tryService(fn: () => ReactNode): ReactNode | undefined {
  if (iconService === undefined) return undefined
  try {
    const node = fn()
    return node === undefined || node === null ? undefined : node
  } catch {
    return undefined
  }
}

/** File row icon: host glyph when available, else the built-in SVG. */
export function FileIcon(props: { path: string; size?: number; className?: string }): ReactNode {
  const size = props.size ?? 16
  const fromHost = tryService(() => iconService?.fileIcon(props.path, size))
  if (fromHost !== undefined) return fromHost
  return <IconFile size={size} className={props.className} />
}

/** Directory row icon: host glyph when available, else the built-in SVG. */
export function FolderIcon(props: { path: string; open: boolean; size?: number; className?: string }): ReactNode {
  const size = props.size ?? 16
  const fromHost = tryService(() => iconService?.folderIcon(props.path, props.open, size))
  if (fromHost !== undefined) return fromHost
  return <IconFolder size={size} open={props.open} className={props.className} />
}

// ------------------------------------------------------------- file kinds

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  pdf: 'application/pdf',
}

function extOf(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export function isImageFile(path: string): boolean {
  return IMAGE_EXTS.has(extOf(path))
}

export function isMarkdownFile(path: string): boolean {
  const ext = extOf(path)
  return ext === 'md' || ext === 'markdown'
}

export function isHtmlFile(path: string): boolean {
  const ext = extOf(path)
  return ext === 'html' || ext === 'htm'
}

export function mimeFor(path: string): string {
  return MIME[extOf(path)] ?? 'application/octet-stream'
}

/** True for a file that always opens as a preview, never as a diff. */
export function isPreviewOnlyFile(path: string): boolean {
  return isImageFile(path) || extOf(path) === 'pdf'
}

/**
 * Status → CSS class: `?` becomes `q` (untracked), `!` becomes `x` (ignored)
 * and any two-letter conflict state collapses to its first letter.
 */
export function gitStatusClass(status: string): string {
  if (status === '?') return 'q'
  if (status === '!') return 'x'
  return status.length > 1 ? (status[0] as string) : status
}

/**
 * The single letter a row shows (empty for "no marker").
 *
 * `?` renders as `?`, NOT as `U`. Both are defensible in isolation — VS Code
 * shows `U` for untracked — but here `U` is already the letter a MERGE
 * CONFLICT carries (`bucketStatus` pushes `status: 'U'` for unmerged paths), so
 * mapping untracked onto it made the two indistinguishable in the change list
 * while behaving completely differently on click: a conflict opens the file to
 * resolve markers, an untracked entry opens an empty-side diff. Keeping `?`
 * distinct costs nothing and removes the ambiguity.
 */
export function gitLetter(status: string | undefined): string {
  if (status === undefined || status === '') return ''
  if (status === '!') return 'I'
  return status.length > 1 ? (status[0] as string) : status
}

/** Base name of a POSIX path. */
export function baseName(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] ?? path
}

/** Parent directory of a POSIX path (`/` when at the root). */
export function dirName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  return cut <= 0 ? '/' : trimmed.slice(0, cut)
}

/** Relative time in the UI language (seconds → "3 分钟前"). */
export function relTime(unixSeconds: number, lang: 'zh' | 'en'): string {
  if (unixSeconds <= 0) return ''
  const delta = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds))
  const zh = lang === 'zh'
  if (delta < 60) return zh ? '刚刚' : 'just now'
  if (delta < 3600) {
    const n = Math.floor(delta / 60)
    return zh ? `${n} 分钟前` : `${n} min ago`
  }
  if (delta < 86400) {
    const n = Math.floor(delta / 3600)
    return zh ? `${n} 小时前` : `${n} h ago`
  }
  if (delta < 86400 * 30) {
    const n = Math.floor(delta / 86400)
    return zh ? `${n} 天前` : `${n} d ago`
  }
  const d = new Date(unixSeconds * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Absolute timestamp for tooltips. */
export function fullTime(unixSeconds: number): string {
  if (unixSeconds <= 0) return ''
  const d = new Date(unixSeconds * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// ---------------------------------------------------------- modal + toast

interface ModalRequest {
  id: number
  kind: 'confirm' | 'prompt'
  title: string
  text: string
  danger: boolean
  okText: string | undefined
  cancelText: string | undefined
  initial: string
  placeholder: string | undefined
  resolve: (value: string | boolean | undefined) => void
}

interface ToastItem {
  id: number
  text: string
  error: boolean
}

let modalSeq = 0
let modalRequest: ModalRequest | undefined
let toasts: ToastItem[] = []
/** Mounted dialog hosts in mount order: the first one renders the portal. */
let hostOwners: symbol[] = []
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Themed confirm; resolves false when dismissed. */
export function confirmDialog(opts: {
  title: string
  text?: string
  danger?: boolean
  okText?: string
  cancelText?: string
}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    modalSeq += 1
    modalRequest = {
      id: modalSeq,
      kind: 'confirm',
      title: opts.title,
      text: opts.text ?? '',
      danger: opts.danger === true,
      okText: opts.okText,
      cancelText: opts.cancelText,
      initial: '',
      placeholder: undefined,
      resolve: (value) => resolve(value === true),
    }
    emit()
  })
}

/** Themed prompt; resolves undefined when dismissed. */
export function promptDialog(opts: {
  title: string
  text?: string
  initial?: string
  placeholder?: string
  okText?: string
  cancelText?: string
}): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    modalSeq += 1
    modalRequest = {
      id: modalSeq,
      kind: 'prompt',
      title: opts.title,
      text: opts.text ?? '',
      danger: false,
      okText: opts.okText,
      cancelText: opts.cancelText,
      initial: opts.initial ?? '',
      placeholder: opts.placeholder,
      resolve: (value) => resolve(typeof value === 'string' ? value : undefined),
    }
    emit()
  })
}

/** Transient status message (bottom-right, auto-dismiss). */
export function toast(text: string, error = false): void {
  const id = ++modalSeq
  toasts = [...toasts, { id, text, error }]
  emit()
  const timer = setTimeout(() => {
    toasts = toasts.filter(t => t.id !== id)
    emit()
  }, error ? 6000 : 2600)
  timer.unref?.()
}

/** Dismiss the open modal without a decision. */
function closeModal(): void {
  modalRequest = undefined
  emit()
}

/**
 * The single host that renders the modal + toast layer.
 *
 * Two mount points now exist (the sidebar panel and the conversation-view
 * editor), so ownership is arbitrated: the first mounted host renders, and a
 * later one takes over only after the first unmounts — otherwise every
 * confirm dialog would paint twice.
 */
export function DialogHost(): ReactNode {
  const request = useSyncExternalStore(subscribe, () => modalRequest)
  const items = useSyncExternalStore(subscribe, () => toasts)
  const owners = useSyncExternalStore(subscribe, () => hostOwners)
  const mine = useRef<symbol>(Symbol('rvs-dialog-host'))
  useEffect(() => {
    const id = mine.current
    if (!hostOwners.includes(id)) {
      hostOwners = [...hostOwners, id]
      emit()
    }
    return () => {
      hostOwners = hostOwners.filter(owner => owner !== id)
      emit()
    }
  }, [])
  if (typeof document === 'undefined') return null
  if (owners[0] !== mine.current) return null
  return createPortal(
    <>
      {request !== undefined && <ModalCard key={request.id} request={request} />}
      {items.length > 0 && (
        <div className="rvs-toasts">
          {items.map(item => (
            <div key={item.id} className={item.error ? 'rvs-toast error' : 'rvs-toast'}>{item.text}</div>
          ))}
        </div>
      )}
    </>,
    document.body,
  )
}

function ModalCard(props: { request: ModalRequest }): ReactNode {
  const { request } = props
  const [value, setValue] = useState(request.initial)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (request.kind === 'prompt') {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [request.kind])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        request.resolve(request.kind === 'prompt' ? undefined : false)
        closeModal()
      } else if (e.key === 'Enter' && request.kind === 'prompt' && e.target === inputRef.current) {
        e.preventDefault()
        request.resolve(value)
        closeModal()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request, value])

  const ok = (): void => {
    request.resolve(request.kind === 'prompt' ? value : true)
    closeModal()
  }
  const cancel = (): void => {
    request.resolve(request.kind === 'prompt' ? undefined : false)
    closeModal()
  }

  return (
    <div className="rvs-portal rvs-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) cancel() }}>
      <div className="rvs-modal-box" role="dialog" aria-modal="true">
        <div className="rvs-modal-title">{request.title}</div>
        {request.text !== '' && <div className="rvs-modal-text">{request.text}</div>}
        {request.kind === 'prompt' && (
          <input
            ref={inputRef}
            className="rvs-input"
            value={value}
            placeholder={request.placeholder}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        <div className="rvs-modal-row">
          <button type="button" className="rvs-modal-btn" onClick={cancel}>
            {request.cancelText ?? '取消'}
          </button>
          <button
            type="button"
            className={request.danger ? 'rvs-modal-btn danger' : 'rvs-modal-btn primary'}
            onClick={ok}
          >
            {request.okText ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------- context menu

export interface MenuEntry {
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  hint?: string
  /** Renders a separator before this entry. */
  separated?: boolean
}

/** Portal-rendered context menu, clamped to the viewport before paint. */
export function ContextMenu(props: {
  x: number
  y: number
  entries: MenuEntry[]
  onClose: () => void
}): ReactNode {
  const boxRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: props.x, top: props.y })

  useLayoutEffect(() => {
    const box = boxRef.current
    if (box === null) return
    const edge = 8
    const rect = box.getBoundingClientRect()
    const left = Math.max(edge, Math.min(props.x, window.innerWidth - rect.width - edge))
    const top = Math.max(edge, Math.min(props.y, window.innerHeight - rect.height - edge))
    setPos({ left, top })
  }, [props.x, props.y])

  /**
   * The menu's four window listeners are installed ONCE and read the close
   * handler through a ref. They used to depend on `[props]`, and `props` is a
   * fresh object every render, so any re-render while the menu was open tore
   * down and re-added all four — and a caller passing an inline arrow would
   * have churned them even with a narrower dep list.
   */
  const onCloseRef = useRef(props.onClose)
  useEffect(() => {
    onCloseRef.current = props.onClose
  })

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current?.contains(e.target as Node) === true) return
      onCloseRef.current()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    const onScroll = (): void => onCloseRef.current()
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [])

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="rvs-portal">
      <div ref={boxRef} className="rvs-menu" style={{ left: pos.left, top: pos.top }}>
        {props.entries.map((entry, index) => (
          <div key={`${entry.label}-${index}`}>
            {entry.separated === true && index > 0 && <div className="rvs-menu-sep" />}
            <button
              type="button"
              className={entry.danger === true ? 'rvs-menu-item danger' : 'rvs-menu-item'}
              disabled={entry.disabled === true}
              onClick={() => {
                props.onClose()
                entry.onSelect()
              }}
            >
              <span>{entry.label}</span>
              {entry.hint !== undefined && <span className="rvs-menu-hint">{entry.hint}</span>}
            </button>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  )
}

/** Hook: context-menu state + the handler that opens it. */
export function useContextMenu(): {
  menu: { x: number; y: number; entries: MenuEntry[] } | undefined
  open: (x: number, y: number, entries: MenuEntry[]) => void
  close: () => void
} {
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | undefined>(undefined)
  const open = useCallback((x: number, y: number, entries: MenuEntry[]): void => {
    setMenu({ x, y, entries })
  }, [])
  const close = useCallback((): void => setMenu(undefined), [])
  return { menu, open, close }
}

// -------------------------------------------------------------- utilities

/** Copy text to the clipboard, falling back to a hidden textarea. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    // Fall through: the clipboard API is unavailable over plain HTTP origins.
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  } catch {
    // Ignore: nothing else to try.
  }
}

export interface SegmentedProps<T extends string> {
  value: T
  options: { id: T; label: string; title?: string }[]
  onChange: (value: T) => void
}

/** The small segmented control used by the diff and preview toolbars. */
export function Segmented<T extends string>(props: SegmentedProps<T>): ReactNode {
  return (
    <span className="rvs-seg">
      {props.options.map(option => createElement('button', {
        key: option.id,
        type: 'button',
        title: option.title,
        className: props.value === option.id ? 'active' : '',
        onClick: () => props.onChange(option.id),
      }, option.label))}
    </span>
  )
}

/** A toolbar icon button. */
export function IconButton(props: {
  title: string
  onClick: () => void
  children: ReactNode
  danger?: boolean
  disabled?: boolean
  className?: string
}): ReactNode {
  return (
    <button
      type="button"
      className={`rvs-hbtn${props.danger === true ? ' danger' : ''}${props.className !== undefined ? ` ${props.className}` : ''}`}
      title={props.title}
      aria-label={props.title}
      disabled={props.disabled === true}
      onClick={(e) => {
        e.stopPropagation()
        props.onClick()
      }}
    >
      {props.children}
    </button>
  )
}

/** Spinner used in busy buttons. */
export function MiniSpinner(): ReactNode {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" style={{ verticalAlign: '-2px' }}>
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M 8 1.5 A 6.5 6.5 0 0 1 14.5 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.9s" repeatCount="indefinite" />
      </path>
    </svg>
  )
}
