/**
 * Document previews for remote files.
 *
 * Text sources (Markdown/HTML/SVG/CSV) are rendered from the editor buffer. PDF,
 * audio/video and Office bytes never pass through `fs.read` (it is a UTF-8 API
 * with a 4 MiB cap): they are streamed from the existing `/download` route into
 * a blob URL, and Office is first converted to PDF by a LibreOffice already
 * present on the REMOTE host. When that engine is missing the notice says so;
 * the plugin never claims a corrupt file.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, RemoteApiError } from '../api.ts'
import { downloadUrl } from '../download.ts'
import { shQuote } from '../../git-format.ts'
import { DEFAULT_TABLE_LIMITS, extensionOf, mediaTypeOf, parseDelimited, tableDelimiterOf, type PreviewKind } from './preview-model.ts'
import { readWorkspaceBytes, renderOfficePdf, type PreviewFailureReason } from './preview-services.ts'

/** Never assemble a larger preview body than this in the tab. */
export const MAX_PREVIEW_BYTES = 64 * 1024 * 1024

type PreviewError = { kind: PreviewFailureReason; message: string }

export function officeExtensionOf(path: string): string | undefined {
  const ext = extensionOf(path)
  return ext === 'doc' || ext === 'docx' || ext === 'ppt' || ext === 'pptx' || ext === 'xls' || ext === 'xlsx'
    ? ext
    : undefined
}

/**
 * Convert one remote Office document to PDF on the remote host.
 *
 * Paths and the extension are quoted/validated here; the only value that ends
 * up in the shell is the remote path. A missing engine is reported as
 * `@@RVS_NO_SOFFICE` (notice), not as a corrupt document.
 */
export function officeConvertCommand(path: string): string {
  const ext = officeExtensionOf(path)
  if (ext === undefined) throw new Error('unsupported office extension')
  const input = `input.${ext}`
  return [
    "tmp=$(mktemp -d) || { echo '@@RVS_FAIL mktemp'; exit 2; }",
    `cp ${shQuote(path)} "$tmp/${input}" || { rm -rf "$tmp"; echo '@@RVS_FAIL copy'; exit 3; }`,
    'if command -v soffice >/dev/null 2>&1; then bin=soffice;',
    'elif command -v libreoffice >/dev/null 2>&1; then bin=libreoffice;',
    'else rm -rf "$tmp"; echo "@@RVS_NO_SOFFICE"; exit 4; fi',
    "cd \"$tmp\" || { rm -rf \"$tmp\"; echo '@@RVS_FAIL cd'; exit 5; }",
    `"$bin" --headless --convert-to pdf --outdir "$tmp" "$tmp/${input}" >/dev/null 2>&1`,
    'if [ ! -f "$tmp/input.pdf" ]; then rm -rf "$tmp"; echo "@@RVS_FAIL convert"; exit 6; fi',
    'echo "@@RVS_PDF $tmp"',
  ].join('\n')
}

function errorMessage(error: unknown): string {
  return error instanceof RemoteApiError ? error.message : error instanceof Error ? error.message : String(error)
}

/** Fetch one remote file body through the streaming download route. */
export async function fetchRemoteBytes(alias: string, path: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(downloadUrl(alias, path), { signal })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let message = `download failed: HTTP ${response.status}`
    try {
      const body = JSON.parse(text) as { error?: unknown }
      if (typeof body.error === 'string') message = body.error
    } catch {
      // Not JSON: keep the status message.
    }
    throw new Error(message)
  }
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_PREVIEW_BYTES) {
    throw Object.assign(new Error(`file is larger than ${MAX_PREVIEW_BYTES} bytes`), { previewKind: 'too-large' })
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_PREVIEW_BYTES) {
    throw Object.assign(new Error(`file is larger than ${MAX_PREVIEW_BYTES} bytes`), { previewKind: 'too-large' })
  }
  return bytes
}

async function fetchOfficePdf(alias: string, path: string, signal?: AbortSignal): Promise<Uint8Array> {
  if (officeExtensionOf(path) === undefined) throw new Error('unsupported office document')
  const result = await api.exec(alias, officeConvertCommand(path), 60_000, { signal })
  if (result.error !== undefined) throw new Error(result.error)
  if (result.timedOut) throw new Error('remote LibreOffice conversion timed out')
  const line = result.stdout.split('\n').map(item => item.trim()).find(item => item.startsWith('@@RVS_PDF '))
  if (line === undefined) {
    if (result.stdout.includes('@@RVS_NO_SOFFICE')) {
      throw Object.assign(new Error('LibreOffice is not installed on the remote host'), { previewKind: 'unavailable' })
    }
    throw new Error(result.stderr.trim() || 'remote LibreOffice conversion failed')
  }
  const tempDir = line.slice('@@RVS_PDF '.length).trim()
  try {
    return await fetchRemoteBytes(alias, `${tempDir}/input.pdf`, signal)
  } finally {
    // Best-effort cleanup; a failed rm must not turn a rendered document into
    // an error, but it also must never be skipped silently in this function.
    void api.exec(alias, `rm -rf ${shQuote(tempDir)}`, 15_000).catch(() => undefined)
  }
}

function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function PreviewNotice(props: {
  path: string
  title: string
  hint: string
  detail?: string
  t: (key: string) => string
  onRetry?: () => void
}): ReactNode {
  return (
    <div className="rvs-preview-notice" role="alert">
      <div className="rvs-preview-notice-title">{props.title}</div>
      <div className="rvs-preview-notice-path">{props.path}</div>
      <div className="rvs-preview-notice-hint">{props.hint}</div>
      {props.detail !== undefined && <div className="rvs-preview-notice-detail">{props.detail}</div>}
      {props.onRetry !== undefined && (
        <button type="button" className="rvs-preview-retry" onClick={props.onRetry}>{props.t('common.retry')}</button>
      )}
    </div>
  )
}

export function BytePreview(props: {
  alias: string
  path: string
  /** DSH session; lets the host workspaceFiles/officeKit remotes resolve the
   *  same remote workspace before the plugin's own download fallback. */
  sessionId?: string
  kind: 'pdf' | 'office' | 'media'
  revision: number
  t: (key: string) => string
}): ReactNode {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready'; url: string; size: number } | { status: 'failed'; error: PreviewError }>({ status: 'loading' })
  const [elementFailed, setElementFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  useEffect(() => { setElementFailed(false) }, [props.path, props.kind])

  useEffect(() => {
    const controller = new AbortController()
    let url: string | undefined
    let hostReason: PreviewFailureReason = 'failed'
    setState({ status: 'loading' })
    const download = props.kind === 'office'
      ? () => fetchOfficePdf(props.alias, props.path, controller.signal)
      : () => fetchRemoteBytes(props.alias, props.path, controller.signal)
    const hostRead = props.kind === 'office'
      ? renderOfficePdf(props.sessionId ?? '', props.path, controller.signal)
      : readWorkspaceBytes(props.sessionId ?? '', props.path, controller.signal)
    void hostRead.then((host) => {
      if (host.ok) return host.data
      hostReason = host.reason
      // A missing service or a path the host cannot resolve is exactly why the
      // plugin keeps its own /download path; only the fallback can succeed.
      return download()
    }).then((bytes) => {
      if (!alive.current) return
      const mime = props.kind === 'media'
        ? mediaTypeOf(props.path)?.mime ?? 'application/octet-stream'
        : 'application/pdf'
      url = URL.createObjectURL(new Blob([bytes], { type: mime }))
      setState({ status: 'ready', url, size: bytes.byteLength })
    }).catch((error: unknown) => {
      if (!alive.current) return
      const reason = typeof error === 'object' && error !== null && 'previewKind' in error
        ? (error as { previewKind: PreviewError['kind'] }).previewKind
        : hostReason
      setState({ status: 'failed', error: { kind: reason, message: errorMessage(error) } })
    })
    return () => {
      controller.abort()
      if (url !== undefined) URL.revokeObjectURL(url)
    }
  }, [props.alias, props.path, props.kind, props.revision, attempt])

  if (state.status === 'loading') {
    return (
      <div className="rvs-preview-loading" role="status">
        <span className="rvs-preview-spinner" aria-hidden="true" />
        <span>{props.kind === 'office' ? props.t('preview.converting') : props.t('common.loading')}</span>
        {props.kind === 'office' && <span className="rvs-preview-loading-hint">{props.t('preview.convertingHint')}</span>}
      </div>
    )
  }
  if (state.status === 'failed') {
    const title = state.error.kind === 'too-large'
      ? props.t('preview.tooLargeTitle')
      : state.error.kind === 'unavailable'
        ? props.t(props.kind === 'office' ? 'preview.officeUnavailableTitle' : 'preview.unavailableTitle')
        : state.error.kind === 'not-found'
          ? props.t('preview.notFoundTitle')
          : state.error.kind === 'remote'
            ? props.t('preview.remoteTitle')
        : props.t('preview.failedTitle')
    const hint = state.error.kind === 'too-large'
      ? props.t('preview.tooLargeHint')
      : state.error.kind === 'unavailable'
        ? props.t('preview.unavailableHint')
        : state.error.kind === 'not-found'
          ? props.t('preview.notFoundHint')
          : state.error.kind === 'remote'
            ? props.t('preview.remoteHint')
        : props.t('preview.failedHint')
    return <PreviewNotice path={props.path} title={title} hint={hint} detail={state.error.message} t={props.t} onRetry={() => { setAttempt(value => value + 1) }} />
  }
  if (props.kind === 'media') {
    const media = mediaTypeOf(props.path)
    if (elementFailed) {
      return <PreviewNotice path={props.path} title={props.t('preview.failedTitle')} hint={props.t('preview.mediaUnsupported')} t={props.t} onRetry={() => { setElementFailed(false); setAttempt(value => value + 1) }} />
    }
    return (
      <div className={`rvs-preview-media${media?.kind === 'video' ? ' rvs-preview-media-video' : ''}`}>
        {media?.kind === 'video'
          ? <video className="rvs-preview-media-el" src={state.url} controls onError={() => { setElementFailed(true) }} />
          : <audio className="rvs-preview-media-el" src={state.url} controls onError={() => { setElementFailed(true) }} />}
        <div className="rvs-preview-media-meta">
          {sizeText(state.size)}
          <span className="rvs-preview-document-hint">{props.path}</span>
        </div>
      </div>
    )
  }
  return (
    <div className="rvs-preview-document">
      <iframe className="rvs-preview-document-frame" src={state.url} title={props.path} />
      <div className="rvs-preview-document-meta">
        {sizeText(state.size)}
        <span className="rvs-preview-document-hint">{props.t('preview.documentHint')}</span>
      </div>
    </div>
  )
}

export function SvgPreview(props: { path: string; text: string; truncated: boolean; t: (key: string) => string }): ReactNode {
  const [url, setUrl] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([props.text], { type: 'image/svg+xml' }))
    setUrl(next)
    return () => { URL.revokeObjectURL(next) }
  }, [props.text])
  useEffect(() => { setFailed(false) }, [url])
  if (failed) {
    return <PreviewNotice path={props.path} title={props.t('preview.svgFailed')} hint={props.t('preview.svgFailedHint')} t={props.t} />
  }
  if (url === undefined) return null
  return (
    <div className="rvs-preview-svg">
      <img className="rvs-preview-svg-img" src={url} alt={props.path} onError={() => { setFailed(true) }} />
      <div className="rvs-preview-svg-hint">{props.truncated ? props.t('preview.truncated') : props.t('preview.svgHint')}</div>
    </div>
  )
}

/** DOM ceilings (parsing itself allows more; the rest gets a banner). */
const RENDER_ROWS = 400
const RENDER_COLUMNS = 48

function padRow(row: readonly string[], columns: number): string[] {
  const cells = row.slice(0, columns)
  while (cells.length < columns) cells.push('')
  return cells
}

export function TablePreview(props: { path: string; text: string; truncated: boolean; t: (key: string) => string }): ReactNode {
  const parsed = useMemo(
    () => parseDelimited(props.text, tableDelimiterOf(props.path)),
    [props.text, props.path],
  )
  const columns = Math.min(parsed.columns, RENDER_COLUMNS)
  const rows = parsed.rows.slice(0, RENDER_ROWS)
  const header = rows[0]
  const body = rows.slice(1)
  const hiddenRows = parsed.rows.length - rows.length
  const hiddenColumns = parsed.columns - columns
  const notes: string[] = []
  if (props.truncated) notes.push(props.t('preview.truncated'))
  if (parsed.truncated) {
    notes.push(props.t('preview.tableTruncated')
      .replace('{rows}', String(DEFAULT_TABLE_LIMITS.maxRows))
      .replace('{cells}', String(DEFAULT_TABLE_LIMITS.maxCells)))
  }
  if (hiddenRows > 0) notes.push(props.t('preview.tableHiddenRows').replace('{shown}', String(rows.length)).replace('{rest}', String(hiddenRows)))
  if (hiddenColumns > 0) notes.push(props.t('preview.tableHiddenColumns').replace('{shown}', String(columns)).replace('{rest}', String(hiddenColumns)))
  if (parsed.rows.length === 0) {
    return <PreviewNotice path={props.path} title={props.t('preview.tableEmptyTitle')} hint={props.t('preview.tableEmptyHint')} t={props.t} />
  }
  return (
    <div className="rvs-preview-table-wrap">
      {notes.map(note => <div className="rvs-preview-banner" key={note}>{note}</div>)}
      <div className="rvs-preview-table-scroll">
        <table className="rvs-preview-table">
          <thead>
            <tr>
              <th className="rvs-preview-rownum" scope="col">#</th>
              {padRow(header ?? [], columns).map((cell, index) => <th key={index} scope="col">{cell}</th>)}
            </tr>
          </thead>
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <th className="rvs-preview-rownum" scope="row">{rowIndex + 2}</th>
                {padRow(row, columns).map((cell, cellIndex) => <td key={cellIndex} title={cell}>{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function previewLabelFor(kind: PreviewKind): string | undefined {
  return kind === 'text' ? undefined : kind
}
