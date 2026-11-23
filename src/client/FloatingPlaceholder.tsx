/**
 * What the centre conversation view and the sidebar fallback show while the
 * editor lives somewhere else: the editor itself is a single instance, so these
 * surfaces must not mount a second one (that would be two live CodeMirror
 * buffers for one tab — the exact defect `EditorPane`'s header warns about).
 *
 * Three such places exist now that the DOCKED sidebar pane is the default seat:
 *  - `float`: the editor is popped out into the frame-wide window;
 *  - `sidebar`: the editor is docked in the sidebar column, and the
 *    conversation-view tab is only its optional full-width seat;
 *  - `center`: the reverse — the conversation tab owns the editor, and the
 *    sidebar's editor page explains how to bring it back.
 * A button per mode keeps the surface from looking broken.
 */
import type { ReactNode } from 'react'
import { useExplorer } from './store.tsx'
import { Btn } from './ui.tsx'

/** Which seat currently owns the editor. */
export type PlaceholderMode = 'float' | 'sidebar' | 'center'

export function FloatingEditorPlaceholder(props: { mode?: PlaceholderMode }): ReactNode {
  const store = useExplorer()
  const t = store.t
  const mode = props.mode ?? 'float'
  if (mode === 'center') {
    return (
      <div className="rvs-float-placeholder">
        <div className="rvs-float-placeholder-title">{t('float.centerElsewhere')}</div>
        <div className="rvs-float-placeholder-text">{t('float.centerElsewhereHint')}</div>
        <Btn kind="primary" onClick={() => { store.dockEditorSidebar() }}>{t('editor.dockToSidebar')}</Btn>
      </div>
    )
  }
  if (mode === 'sidebar') {
    return (
      <div className="rvs-float-placeholder">
        <div className="rvs-float-placeholder-title">{t('float.dockedElsewhere')}</div>
        <div className="rvs-float-placeholder-text">{t('float.dockedElsewhereHint')}</div>
        <Btn kind="primary" onClick={() => { store.openEditorInCenter() }}>{t('float.openHere')}</Btn>
      </div>
    )
  }
  return (
    <div className="rvs-float-placeholder">
      <div className="rvs-float-placeholder-title">{t('float.placeholder')}</div>
      <div className="rvs-float-placeholder-text">{t('float.placeholderHint')}</div>
      <Btn kind="primary" onClick={() => { store.dockFloatingEditor() }}>{t('float.dockBack')}</Btn>
    </div>
  )
}
