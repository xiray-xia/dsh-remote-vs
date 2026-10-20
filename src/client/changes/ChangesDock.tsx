/**
 * The session change panel above the composer (the Cursor-style review list).
 *
 * Placement is the point: `conversation.input.dock` is the one full-width seat
 * the shell renders directly above the composer card — the todo, goal and queue
 * panels already live there — so the list is visible while the user types the
 * next instruction instead of being scrolled away in the conversation.
 *
 * Data comes from the plugin's own ledger (`/api/dsh-remote/changes`), not from
 * DSH's `workspaceChanges`: that recorder cannot see a routed session at all
 * (its git baseline is parsed with host path semantics and its scratch index is
 * written with `node:fs`), which the probe measured as 58 remote sessions with
 * zero change events.
 *
 * Clicking a row opens the file in the remote editor and hands the editor the
 * same hunks, so the changed lines are painted in place.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.ts'
import {
  applyChangeSet,
  bootstrap,
  followSessionWorkspace,
  openRemoteFileInBinding,
  refreshAll,
  readRepoSubdir,
  remoteOpenBindings,
  useExplorer,
} from '../store.tsx'
import { bindingForChangedFile } from '../remote-file-open-target.ts'
import { useRemoteChatTarget } from '../use-remote-chat-target.ts'
import type { RemoteChangedFile, RemoteChangesSummary } from '../../protocol.ts'
import { EMPTY_CHANGE_SET, changeSetFromHunks, type ChangeSet } from './model.ts'
import { setUndoContext } from './undo-context.ts'
import { FileIcon } from '../vsc/kit.tsx'
import './changes.css'

/** How often an open panel re-reads the ledger (the host refreshes it per turn). */
const POLL_MS = 3000

/**
 * Props the composer dock hands us.
 *
 * Typed narrowly on purpose: the slot's full owner/standard prop surface comes
 * from `dsh-client-ui-conversation`, and depending on that package for types
 * drags a second DSH chain into this repo (same reason `conversation.view` is
 * soft-typed in index.tsx). Everything else is read from the plugin's own store.
 */
export interface ChangesDockProps {
  /** `SessionSnapshot` (the client contract names it `sessionId`, not `id`). */
  session?: { sessionId?: string; id?: string }
  sessionId?: string
}

/** One row's status, spelled out for the tooltip (the row itself shows counts). */
function statusWord(file: RemoteChangedFile, t: (key: string) => string): string {
  if (file.status === 'A') return t('changes.statusAdded')
  if (file.status === 'D') return t('changes.statusDeleted')
  if (file.status === 'R') return t('changes.statusRenamed')
  return t('changes.statusModified')
}

/** Split a display path into its directory prefix and file name. */
function splitDisplay(display: string): { dir: string; name: string } {
  const at = display.lastIndexOf('/')
  return at < 0 ? { dir: '', name: display } : { dir: display.slice(0, at + 1), name: display.slice(at + 1) }
}

export function ChangesDock(props: ChangesDockProps): React.ReactNode {
  const explorer = useExplorer()
  // The dock is a second surface of the same store as the explorer, and it can
  // mount without the explorer ever being opened — without this the workspace
  // list would be empty and a click could not resolve its binding.
  useEffect(() => {
    if (explorer.ctx !== undefined) bootstrap(explorer.ctx)
  }, [explorer.ctx])
  const t = explorer.t
  const sessionId = props.sessionId ?? props.session?.sessionId ?? props.session?.id
  /**
   * The last answer, TAGGED with the session it belongs to.
   *
   * One panel serves whichever session is on screen, so an untagged summary
   * survives a session switch and keeps describing the previous conversation —
   * which is exactly how a stale "computing…" from another session appeared in
   * a session whose own ledger had not even been created yet.
   */
  const [data, setData] = useState<{ id: string; summary: RemoteChangesSummary | null } | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  // Collapsed by default: the header already carries the file count and the totals,
  // and the list is one click away — a turn that touched twenty files should not
  // push the composer off the screen.
  const [collapsed, setCollapsed] = useState(true)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const alive = useRef(true)
  const currentSession = useRef(sessionId)
  currentSession.current = sessionId
  // The Source Control panel's repository directory, resolved at call time: it is
  // the user's explicit answer to "which repository in this workspace", and it
  // outranks the host's one-level guess. A ref (not a value) so a change made
  // while this panel is open is picked up by the next poll.
  const repoSubdirOf = (): string => {
    const id = explorer.workspaceId
    return id === undefined || id === '' ? '' : readRepoSubdir(id)
  }

  const load = useCallback(async (force = false): Promise<void> => {
    if (sessionId === undefined || sessionId === '') return
    const asked = sessionId
    try {
      const next = await api.changes.list(asked, force, repoSubdirOf())
      // Two guards: the panel may be gone, and the user may have switched
      // sessions while this was in flight — a late answer for the old session
      // must not be filed under the new one.
      if (!alive.current || currentSession.current !== asked) return
      setData({ id: asked, summary: next })
      setError(undefined)
    } catch (problem) {
      if (!alive.current || currentSession.current !== asked) return
      setError(problem instanceof Error ? problem.message : String(problem))
    }
  }, [sessionId])
  const summary = data !== null && data.id === sessionId ? data.summary : null

  useEffect(() => {
    alive.current = true
    void load()
    const timer = window.setInterval(() => { void load() }, POLL_MS)
    return () => {
      alive.current = false
      window.clearInterval(timer)
    }
  }, [load])

  // Keep the revert affordance pointed at the workspace this panel lists. It is
  // written on every summary so a rebound workspace cannot leave a stale root
  // behind, and cleared on unmount so an affordance in another session's editor
  // can never act on this one.
  useEffect(() => {
    if (sessionId === undefined || summary === null || summary.root === '') return
    setUndoContext({ sessionId, alias: summary.alias, root: summary.root })
  }, [sessionId, summary])

  useEffect(() => () => { setUndoContext(undefined) }, [])

  /**
   * Follow the session's workspace from the panel's own evidence.
   *
   * The panel holds the host's alias + remote root for THIS session, so it can
   * point the sidebar (and the editor's workspace selector, which reads the same
   * store) at the right binding even when the sidebar's own follow found nothing
   * yet — and it is the surface that is mounted whenever a conversation is.
   * Only the session actually on screen may steer the selector, and only once
   * per session (the store's policy), so a parked dock cannot move it.
   */
  const chatTarget = useRemoteChatTarget(explorer.ctx)
  useEffect(() => {
    if (sessionId === undefined || summary === null || summary.root === '') return
    if (chatTarget.sessionId === undefined || chatTarget.sessionId !== sessionId) return
    followSessionWorkspace({ sessionId, alias: summary.alias, remoteRoot: summary.root })
  }, [sessionId, summary, chatTarget.sessionId])

  /** Open one listed file in the remote editor with its change marks. */
  const openChanged = useCallback(async (file: RemoteChangedFile): Promise<void> => {
    if (sessionId === undefined || summary === null) return
    setBusy(file.path)
    try {
      const diff = await api.changes.diff(sessionId, file.path, repoSubdirOf())
      if (!alive.current) return
      const stamp = `${file.path}@${summary.at}@${summary.turn}`
      const set: ChangeSet = diff !== null && diff.kind === 'text'
        ? changeSetFromHunks(diff.hunks, stamp)
        : { ...EMPTY_CHANGE_SET, stamp }
      // The store may still be loading its workspace table on a cold page, so a
      // miss is worth one refresh before giving up on the click. Read through
      // the snapshot accessor, not the render-time props, so the retry actually
      // sees what the load wrote.
      //
      // Resolved by the session's REMOTE root, never by the alias alone: one
      // alias carries several bindings (repo-a and repo-b both live on
      // `alias-a`), and the alias-only form picked whichever came first —
      // the file opened while the tree and the selector stayed on the other
      // workspace. That was the reported bug.
      let binding = bindingForChangedFile(remoteOpenBindings(), summary, file.path)
      if (binding === undefined) {
        refreshAll()
        await new Promise(resolve => { window.setTimeout(resolve, 300) })
        binding = bindingForChangedFile(remoteOpenBindings(), summary, file.path)
      }
      if (binding === undefined) {
        explorer.info(t('changes.noWorkspace'))
        return
      }
      openRemoteFileInBinding(binding.id, file.path, set.hunks[0] === undefined ? {} : { line: set.hunks[0] })
      // The tab id is deterministic (store.openFile builds it the same way), so
      // the marks can be attached without waiting for the file read to settle.
      applyChangeSet(`file:${binding.alias}:${file.path}`, set)
    } catch (problem) {
      if (alive.current) explorer.info(`${t('changes.diffFailed')}: ${problem instanceof Error ? problem.message : String(problem)}`)
    } finally {
      if (alive.current) setBusy(undefined)
    }
  }, [explorer, sessionId, summary, t])

  const files = summary?.files ?? []
  const activeTab = explorer.tabs.find(candidate => candidate.id === explorer.activeTabId)
  const visible = useMemo(() => {
    if (summary === null) return false
    return files.length > 0 || summary.pending === true || summary.unavailable !== undefined
  }, [files.length, summary])

  if (sessionId === undefined || sessionId === '') return null
  if (!visible && error === undefined) return null

  const stale = activeTab?.changeStale === true
  const title = files.length > 0 ? `${t('changes.title')} · ${files.length}` : t('changes.title')

  return (
    <div className="rvs-changes" data-collapsed={collapsed ? '1' : '0'}>
      <div className="rvs-changes-head">
        <button
          type="button"
          className="rvs-changes-toggle"
          aria-expanded={!collapsed}
          onClick={() => { setCollapsed(value => !value) }}
          title={t('changes.toggle')}
        >
          <span className="rvs-changes-chevron" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
          <span className="rvs-changes-title">{title}</span>
        </button>
        {files.length > 0 && (
          <span className="rvs-changes-totals">
            <span className="rvs-chg-add">+{summary?.added ?? 0}</span>
            <span className="rvs-chg-del">−{summary?.deleted ?? 0}</span>
          </span>
        )}
        {summary?.pending === true && <span className="rvs-changes-pending">{t('changes.pending')}</span>}
        <span className="rvs-changes-spacer" />
        {stale && <span className="rvs-changes-stale" title={t('changes.staleHint')}>{t('changes.stale')}</span>}
        <button
          type="button"
          className="rvs-changes-refresh"
          onClick={() => { void load(true) }}
          title={t('changes.refresh')}
        >⟳</button>
      </div>
      {!collapsed && (
        <div className="rvs-changes-body">
          {error !== undefined && <div className="rvs-changes-note rvs-changes-error">{t('changes.failed')}: {error}</div>}
          {summary?.unavailable !== undefined && (
            <div className="rvs-changes-note">{t('changes.unavailable')} · {summary.unavailable}</div>
          )}
          {files.length === 0 && summary?.unavailable === undefined && summary?.pending !== true && (
            <div className="rvs-changes-note">{t('changes.empty')}</div>
          )}
          {files.map(file => {
            const { dir, name } = splitDisplay(file.display)
            return (
              <button
                type="button"
                key={file.path}
                className={`rvs-chg-row${busy === file.path ? ' rvs-chg-loading' : ''}`}
                title={`${file.path}\n${statusWord(file, t)}`}
                onClick={() => { void openChanged(file) }}
              >
                <span className="rvs-chg-icon" aria-hidden="true"><FileIcon path={file.display} size={14} /></span>
                <span className="rvs-chg-path">
                  <span className="rvs-chg-dir">{dir}</span>
                  <span className="rvs-chg-name">{name}</span>
                </span>
                <span className="rvs-chg-counts">
                  {file.oversized === true
                    ? <span className="rvs-chg-note">{t('changes.oversized')}</span>
                    : file.binary === true
                      ? <span className="rvs-chg-note">{t('changes.binary')}</span>
                      : (
                        <>
                          <span className="rvs-chg-add">+{file.added}</span>
                          <span className="rvs-chg-del">−{file.deleted}</span>
                        </>
                        )}
                </span>
              </button>
            )
          })}
          {summary?.truncated === true && <div className="rvs-changes-note">{t('changes.truncated')}</div>}
        </div>
      )}
    </div>
  )
}
