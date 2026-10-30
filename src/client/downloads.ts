/**
 * Download runner and its tiny observable store.
 *
 * The explorer/search menus start one download each; this module owns the
 * stat preflight, the file-vs-directory choice, the cancel handle and the
 * progress/status snapshot the dock renders. Kept outside React on purpose:
 * the dock is portaled to `<body>` and may unmount with its sidebar tab, while
 * a download already streaming must keep running to completion.
 */

import { api } from './api.ts'
import { saveRemoteDir, saveRemoteFile } from './download.ts'

/** One download's lifecycle state. */
export type DownloadStatus = 'running' | 'done' | 'failed' | 'cancelled'

/** One task as the dock renders it. */
export interface DownloadTask {
  id: string
  /** Basename of the remote path. */
  name: string
  /** Resolved from the stat preflight; `hint.directory` until then. */
  directory: boolean
  status: DownloadStatus
  loaded: number
  /** Absent for a streamed directory archive (chunked, size unknown). */
  total?: number
  /** Failure text, or the note shown for the browser-default fallback. */
  error?: string
  /** `browserDefault` means no save dialog existed and the file went to Downloads. */
  via?: 'picker' | 'browserDefault'
  startedAt: number
  finishedAt?: number
}

/** Human byte size for the progress line. */
export function formatByteCount(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

let tasks: readonly DownloadTask[] = []
const listeners = new Set<() => void>()
const controllers = new Map<string, AbortController>()
let sequence = 0

const notify = (): void => {
  for (const listener of [...listeners]) listener()
}

const patch = (id: string, next: Partial<DownloadTask>): void => {
  tasks = tasks.map(task => (task.id === id ? { ...task, ...next } : task))
  notify()
}

/** Store surface: `useSyncExternalStore(subscribe, getSnapshot, getSnapshot)`. */
export const downloadsStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  getSnapshot(): readonly DownloadTask[] {
    return tasks
  },
}

/**
 * Start one download (file or directory) and return its task id.
 *
 * The stat preflight runs here — not in the menus — so a deleted/unreadable
 * remote path becomes a failed task with the Host's real message, and the
 * file-vs-directory decision comes from the Host rather than a possibly stale
 * tree row.
 */
export function startDownload(alias: string, path: string, hint: { name: string; directory: boolean }): string {
  const id = `download-${++sequence}`
  const controller = new AbortController()
  controllers.set(id, controller)
  tasks = [...tasks, {
    id,
    name: hint.name,
    directory: hint.directory,
    status: 'running',
    loaded: 0,
    startedAt: Date.now(),
  }]
  notify()
  void (async () => {
    try {
      const entry = await api.fileOp.stat(alias, path)
      const directory = entry.isDir
      patch(id, { directory })
      const options = {
        signal: controller.signal,
        onProgress: (progress: { loaded: number; total?: number }): void => {
          if (controller.signal.aborted) return
          patch(id, {
            loaded: progress.loaded,
            ...(progress.total === undefined ? {} : { total: progress.total }),
          })
        },
      }
      const outcome = directory
        ? await saveRemoteDir(alias, path, options)
        : await saveRemoteFile(alias, path, options)
      patch(id, {
        status: 'done',
        finishedAt: Date.now(),
        via: outcome === 'downloaded' ? 'browserDefault' : 'picker',
      })
    } catch (error) {
      const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
      patch(id, {
        status: aborted ? 'cancelled' : 'failed',
        finishedAt: Date.now(),
        ...(aborted ? {} : { error: error instanceof Error ? error.message : String(error) }),
      })
    } finally {
      controllers.delete(id)
    }
  })()
  return id
}

/** Cancel one running download (the panel's stop button). */
export function cancelDownload(id: string): void {
  controllers.get(id)?.abort()
}

/** Drop one task from the dock (finished tasks only in practice). */
export function dismissDownload(id: string): void {
  controllers.get(id)?.abort()
  controllers.delete(id)
  tasks = tasks.filter(task => task.id !== id)
  notify()
}
