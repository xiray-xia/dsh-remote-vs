/**
 * Inline image preview for the editor body.
 *
 * A remote image has no text to edit, so the editor shows the picture instead
 * of the "binary file" notice. Presentation only: the base64 payload comes from
 * the tab's read (the same SFTP read every other preview uses), and this
 * component owns nothing but the fit / actual-size toggle and the load-failure
 * state.
 *
 * Why an `<img>` with a `data:` URL and not an object URL: the payload already
 * arrived base64 from the file route, so there is nothing extra to fetch — and
 * nothing to revoke when the tab closes.
 */
import { useState, type ReactNode } from 'react'

/** Props of {@link ImagePreview}. */
export interface ImagePreviewProps {
  /** `data:` URL built from the tab's base64 payload. */
  src: string
  /** Absolute remote path (tooltip / aria label). */
  path: string
  /** File size in bytes (shown next to the dimensions). */
  size: number
  /** Set when the read was capped: a partial image cannot decode. */
  truncated?: boolean
  /** i18n lookup (falls back to the inline English when the key is missing). */
  t?: (key: string) => string
}

/** Human size for the meta line. */
export function imageSizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Translate one key, falling back to the inline copy when the dictionary lacks it. */
function tr(t: ((key: string) => string) | undefined, key: string, fallback: string): string {
  const value = t?.(key)
  return value === undefined || value === '' || value === key ? fallback : value
}

/**
 * The preview body: the image, a click-to-toggle zoom, and a meta line.
 *
 * `fit` scales the picture down to the pane (the common case: look at it);
 * `actual` shows it at natural size inside a scrollable pane (inspect pixels).
 */
export function ImagePreview(props: ImagePreviewProps): ReactNode {
  const [actual, setActual] = useState(false)
  const [failed, setFailed] = useState(false)
  const [natural, setNatural] = useState<{ width: number; height: number } | undefined>(undefined)
  const hint = tr(props.t, 'editor.imageHint', '点击切换适应窗口 / 原始大小')
  const meta = [
    imageSizeText(props.size),
    natural === undefined ? '' : `${natural.width} × ${natural.height}`,
  ].filter((part) => part !== '').join(' · ')
  if (props.truncated === true) {
    return (
      <div className="rvs-editor-notice">
        <div className="rvs-editor-notice-title">{tr(props.t, 'editor.imageTooLargeTitle', '图片过大')}</div>
        <div>{props.path}</div>
        <div>
          {tr(props.t, 'editor.imageTooLargeHint', '大小 {size} KiB，超出读取上限，不提供预览。')
            .replace('{size}', String(Math.max(1, Math.round(props.size / 1024))))}
        </div>
      </div>
    )
  }
  if (failed) {
    return (
      <div className="rvs-image-preview rvs-image-preview-failed">
        <div className="rvs-editor-notice-title">{tr(props.t, 'editor.imageFailed', '图片读取失败。')}</div>
        <div>{props.path}</div>
        <div>{tr(props.t, 'editor.imageFailedHint', '文件可能已损坏，或不是受支持的图片格式。')}</div>
      </div>
    )
  }
  return (
    <div
      className={`rvs-image-preview${actual ? ' rvs-image-actual' : ''}`}
      title={`${props.path}\n${hint}`}
      role="img"
      aria-label={props.path}
      onClick={() => setActual((value) => !value)}
    >
      <img
        className="rvs-image-preview-img"
        src={props.src}
        alt={props.path}
        draggable={false}
        onDragStart={(event) => event.preventDefault()}
        onLoad={(event) => {
          setNatural({
            width: event.currentTarget.naturalWidth,
            height: event.currentTarget.naturalHeight,
          })
        }}
        onError={() => setFailed(true)}
      />
      <div className="rvs-image-preview-meta">
        <span>{meta}</span>
        <span className="rvs-image-preview-hint">{actual
          ? tr(props.t, 'editor.imageFitHint', '点击适应窗口')
          : hint}</span>
      </div>
    </div>
  )
}
