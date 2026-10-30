/**
 * Download progress dock.
 *
 * Rendered through a PORTAL on `document.body`: the dock starts inside the
 * sidebar's keep-alive slot, and a `position: fixed` descendant of a hidden
 * ancestor disappears with it — which would take the progress bar (and the
 * cancel button) of a running download along when the user switches rail views.
 *
 * The runner lives in `downloads.ts`, outside React, so an unmount of this
 * component never interrupts a transfer; the dock only reads its snapshot.
 */

import { useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cancelDownload, dismissDownload, downloadsStore, formatByteCount, type DownloadTask } from './downloads.ts'
import { FileIcon, FolderIcon, IconButton, IconClose, IconStop } from './vsc/kit.tsx'

const STATUS_KEY: Record<DownloadTask['status'], string> = {
  running: 'downloads.running',
  done: 'downloads.done',
  failed: 'downloads.failed',
  cancelled: 'downloads.cancelled',
}

/** One line of detail under the bar (bytes, fallback note, or the failure). */
function detailText(task: DownloadTask, t: (key: string) => string): string {
  if (task.status === 'failed') return task.error ?? t('downloads.failed')
  if (task.status === 'cancelled') return t('downloads.cancelled')
  if (task.status === 'done') {
    return task.via === 'browserDefault' ? t('downloads.browserDefault') : t('downloads.done')
  }
  const loaded = formatByteCount(task.loaded)
  if (task.total === undefined || task.total <= 0) return `${loaded} · ${t('downloads.indeterminate')}`
  return `${loaded} / ${formatByteCount(task.total)}`
}

/** Percent for the bar, or `undefined` while the size is unknown (archives). */
function percentOf(task: DownloadTask): number | undefined {
  if (task.total === undefined || task.total <= 0) return undefined
  return Math.min(100, Math.round((task.loaded / task.total) * 100))
}

function DownloadRow(props: { task: DownloadTask; t: (key: string) => string }): ReactNode {
  const { task, t } = props
  const percent = percentOf(task)
  return (
    <div className={`rvs-download ${task.status}`}>
      <div className="rvs-download-head">
        <span className="rvs-download-icon">
          {task.directory ? <FolderIcon path={task.name} open={false} size={14} /> : <FileIcon path={task.name} size={14} />}
        </span>
        <span className="rvs-download-name" title={task.name}>{task.name}{task.directory ? '.tar.gz' : ''}</span>
        <span className={`rvs-download-status ${task.status}`}>{t(STATUS_KEY[task.status])}</span>
        {task.status === 'running'
          ? (
              <IconButton title={t('downloads.cancel')} onClick={() => cancelDownload(task.id)}>
                <IconStop size={12} />
              </IconButton>
            )
          : (
              <IconButton title={t('downloads.close')} onClick={() => dismissDownload(task.id)}>
                <IconClose size={12} />
              </IconButton>
            )}
      </div>
      {task.status === 'running' && (
        <div className="rvs-download-bar" aria-hidden="true">
          <div
            className={`rvs-download-fill${percent === undefined ? ' indeterminate' : ''}`}
            style={percent === undefined ? undefined : { width: `${percent}%` }}
          />
        </div>
      )}
      <div className={`rvs-download-meta ${task.status}`} title={task.error}>{detailText(task, t)}</div>
    </div>
  )
}

export function DownloadDock(props: { t: (key: string) => string }): ReactNode {
  const tasks = useSyncExternalStore(downloadsStore.subscribe, downloadsStore.getSnapshot, downloadsStore.getSnapshot)
  if (typeof document === 'undefined') return null
  if (tasks.length === 0) return null
  return createPortal(
    <div className="rvs-downloads" role="status" aria-live="polite">
      {tasks.map(task => <DownloadRow key={task.id} task={task} t={props.t} />)}
    </div>,
    document.body,
  )
}
