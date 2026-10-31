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
import {
  cancelDownload,
  dismissDownload,
  downloadDetailText,
  downloadPercent,
  downloadsStore,
  type DownloadTask,
} from './downloads.ts'
import { FileIcon, FolderIcon, IconButton, IconClose, IconStop } from './vsc/kit.tsx'

const STATUS_KEY: Record<DownloadTask['status'], string> = {
  running: 'downloads.running',
  done: 'downloads.done',
  failed: 'downloads.failed',
  cancelled: 'downloads.cancelled',
  handedOff: 'downloads.handedOff',
}

function DownloadRow(props: { task: DownloadTask; t: (key: string) => string }): ReactNode {
  const { task, t } = props
  // The formatting lives in `downloads.ts` (pure, node-gateable); the dock only
  // renders it.
  const percent = downloadPercent(task)
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
      <div className={`rvs-download-meta ${task.status}`} title={task.error}>{downloadDetailText(task, t)}</div>
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
