/**
 * The conversation-view tab: the same editor tab strip, previews and diff as
 * the sidebar, mounted next to 对话 / 轨迹 at full width.
 *
 * Registered into the `conversation.view` slot when that slot exists; the
 * sidebar then keeps the whole column for the explorer. Both surfaces read
 * the same module-level store, so a diff opened from source control appears
 * here, and a save here repaints the sidebar's change list.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import { EditorPane } from './EditorPane.tsx'
import { useBootstrap, useExplorer } from './store.tsx'
import { DialogHost } from './vsc/kit.tsx'

/**
 * The conversation-view body. The editor surface flag is owned by the client
 * entry (registration success decides it), NOT by this component: the view
 * may be unmounted while another conversation tab is selected, and flipping
 * the flag here would make the sidebar's rail flicker on every tab switch.
 */
export function RemoteEditorView(props: { ctx: Context }): ReactNode {
  useBootstrap(props.ctx)
  const store = useExplorer()
  return (
    <>
      <DialogHost />
      <div className="rvs-root rvs-center">
        <div className="rvs-column">
          <div className="rvs-globalbar">
            <select
              className="rvs-select"
              value={store.workspace?.id ?? ''}
              onChange={(e) => store.selectWorkspace(e.target.value)}
              title={store.t('files.selectWorkspace')}
            >
              {store.workspaces.map(item => (
                <option key={item.id} value={item.id}>{item.name} ({item.alias})</option>
              ))}
            </select>
            {store.repoRoot !== undefined && store.head !== undefined && (
              <span className="rvs-pill" title={store.repoRoot}>
                ⑂ {store.head.detached ? store.t('scm.detached') : store.head.branch}
                {store.head.ahead > 0 && ` ↑${store.head.ahead}`}
                {store.head.behind > 0 && ` ↓${store.head.behind}`}
              </span>
            )}
          </div>
          <EditorPane visible />
        </div>
      </div>
    </>
  )
}
