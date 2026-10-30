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
import { saveRemoteDir, saveRemoteFile, saveRemoteMany, type DownloadOutcome } from './download.ts'

/** One download's lifecycle state. */
export type DownloadStatus = 'running' | 'done' | 'failed' | 'cancelled'

/** One task as the dock renders it. */
export interface DownloadTask {
  id: string
  /** Basename of the remote path (or `selection-N` for a multi-selection). */
  name: string
  /** Resolved from the stat preflight; `hint.directory` until then. */
  directory: boolean
  /** Entries in a multi-selection archive; absent for a single path. */
  selection?: number
  status: DownloadStatus
  loaded: number
  /** Absent for a streamed archive (chunked, size unknown). */
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

/** Progress sink handed to every starter. */
interface RunnerOptions {
  signal: AbortSignal
  onProgress: (progress: { loaded: number; total?: number }) => void
}

/**
 * Run one task body: progress patches, terminal status, cancel mapping.
 *
 * The task row is published by the caller before any await, so the dock shows
 * the row immediately and only the numbers move afterwards.
 */
const launch = (id: string, controller: AbortController, run: (options: RunnerOptions) => Promise<DownloadOutcome>): void => {
  void (async () => {
    try {
      const outcome = await run({
        signal: controller.signal,
        onProgress: (progress) => {
          if (controller.signal.aborted) return
          patch(id, {
            loaded: progress.loaded,
            ...(progress.total === undefined ? {} : { total: progress.total }),
          })
        },
      })
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
}

/** Publish one running task and return its id plus cancel handle. */
const newTask = (task: Pick<DownloadTask, 'name' | 'directory'> & Partial<Pick<DownloadTask, 'selection'>>): { id: string; controller: AbortController } => {
  const id = `download-${++sequence}`
  const controller = new AbortController()
  controllers.set(id, controller)
  tasks = [...tasks, { ...task, id, status: 'running', loaded: 0, startedAt: Date.now() }]
  notify()
  return { id, controller }
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
  const { id, controller } = newTask({ name: hint.name, directory: hint.directory })
  launch(id, controller, async (options) => {
    const entry = await api.fileOp.stat(alias, path)
    // Seed the size from the stat, not from the HTTP response alone: the route
    // sends `content-length`, but a shell or proxy in front of the page may
    // strip it (DSH Desktop's forwarder deletes it), and then a plain file
    // download would fall back to the archive wording ("packaging…").
    patch(id, entry.isDir ? { directory: true } : { directory: false, total: entry.size })
    return entry.isDir ? await saveRemoteDir(alias, path, options) : await saveRemoteFile(alias, path, options)
  })
  return id
}

/**
 * Start one multi-selection download.
 *
 * The Host archives every selected entry into a single `.tar.gz`, so the user
 * picks one destination instead of answering N save dialogs; mixed files and
 * directories are fine (tar recurses). Entry validation happens Host-side
 * before the archive starts, so no client preflight round trip is needed.
 */
export function startSelectionDownload(alias: string, paths: readonly string[]): string {
  const { id, controller } = newTask({ name: `selection-${paths.length}`, directory: true, selection: paths.length })
  launch(id, controller, options => saveRemoteMany(alias, paths, options))
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
