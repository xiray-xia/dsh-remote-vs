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
import { extensionOf, mediaTypeOf, parseDelimited, tableDelimiterOf, type PreviewKind } from './preview-model.ts'

/** Never assemble a larger preview body than this in the tab. */
export const MAX_PREVIEW_BYTES = 64 * 1024 * 1024

type PreviewError = { kind: 'too-large' | 'unavailable' | 'failed'; message: string }

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

function PreviewNotice(props: { title: string; detail?: string; t: (key: string) => string; onRetry?: () => void }): ReactNode {
  return (
    <div className="rvs-preview-notice" role="alert">
      <div className="rvs-preview-notice-title">{props.title}</div>
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
  kind: 'pdf' | 'office' | 'media'
  revision: number
  t: (key: string) => string
}): ReactNode {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready'; url: string } | { status: 'failed'; error: PreviewError }>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let url: string | undefined
    setState({ status: 'loading' })
    const load = props.kind === 'office'
      ? fetchOfficePdf(props.alias, props.path, controller.signal)
      : fetchRemoteBytes(props.alias, props.path, controller.signal)
    void load.then((bytes) => {
      if (!alive.current) return
      const mime = props.kind === 'media'
        ? mediaTypeOf(props.path)?.mime ?? 'application/octet-stream'
        : 'application/pdf'
      url = URL.createObjectURL(new Blob([bytes], { type: mime }))
      setState({ status: 'ready', url })
    }).catch((error: unknown) => {
      if (!alive.current) return
      const reason = typeof error === 'object' && error !== null && 'previewKind' in error
        ? (error as { previewKind: PreviewError['kind'] }).previewKind
        : 'failed'
      setState({ status: 'failed', error: { kind: reason, message: errorMessage(error) } })
    })
    return () => {
      controller.abort()
      if (url !== undefined) URL.revokeObjectURL(url)
    }
  }, [props.alias, props.path, props.kind, props.revision, attempt])

  if (state.status === 'loading') {
    return <div className="rvs-preview-loading" role="status"><span className="rvs-preview-spinner" aria-hidden="true" />{props.kind === 'office' ? props.t('preview.converting') : props.t('common.loading')}</div>
  }
  if (state.status === 'failed') {
    const title = state.error.kind === 'too-large'
      ? props.t('preview.tooLargeTitle')
      : state.error.kind === 'unavailable'
        ? props.t('preview.officeUnavailableTitle')
        : props.t('preview.failedTitle')
    return <PreviewNotice title={title} detail={state.error.message} t={props.t} onRetry={() => { setAttempt(value => value + 1) }} />
  }
  if (props.kind === 'media') {
    const media = mediaTypeOf(props.path)
    return (
      <div className="rvs-preview-media">
        {media?.kind === 'video'
          ? <video className="rvs-preview-video" src={state.url} controls aria-label={props.path} />
          : <audio className="rvs-preview-audio" src={state.url} controls aria-label={props.path} />}
      </div>
    )
  }
  return <iframe className="rvs-preview-pdf" src={state.url} title={props.path} />
}

export function SvgPreview(props: { path: string; text: string; truncated: boolean; t: (key: string) => string }): ReactNode {
  const url = useMemo(
    () => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(props.text)}`,
    [props.text],
  )
  return (
    <div className="rvs-preview-svg-wrap">
      {props.truncated && <div className="rvs-preview-banner">{props.t('preview.truncated')}</div>}
      <img className="rvs-preview-svg" src={url} alt={props.path} />
    </div>
  )
}

export function TablePreview(props: { path: string; text: string; truncated: boolean; t: (key: string) => string }): ReactNode {
  const parsed = useMemo(
    () => parseDelimited(props.text, tableDelimiterOf(props.path)),
    [props.text, props.path],
  )
  const [header, ...body] = parsed.rows
  return (
    <div className="rvs-preview-table-wrap">
      {(props.truncated || parsed.truncated) && <div className="rvs-preview-banner">{props.t('preview.tableTruncated')}</div>}
      <table className="rvs-preview-table">
        {header !== undefined && (
          <thead>
            <tr>
              <th className="rvs-preview-row-no" aria-hidden="true" />
              {header.map((cell, index) => <th key={index}>{cell}</th>)}
            </tr>
          </thead>
        )}
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <th className="rvs-preview-row-no" scope="row">{rowIndex + 1}</th>
              {Array.from({ length: parsed.columns }, (_, index) => <td key={index}>{row[index] ?? ''}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function previewLabelFor(kind: PreviewKind): string | undefined {
  return kind === 'text' ? undefined : kind
}
