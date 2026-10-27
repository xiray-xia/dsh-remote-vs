/**
 * What the centre conversation view and the sidebar fallback show while the
 * editor is popped out: the editor itself is a single instance and lives in the
 * floating window, so these surfaces must not mount a second one (that would
 * be two live CodeMirror buffers for one tab — the exact defect `EditorPane`'s
 * header warns about). A dock button keeps the surface from looking broken.
 */
import type { ReactNode } from 'react'
import { useExplorer } from './store.tsx'
import { Btn } from './ui.tsx'

export function FloatingEditorPlaceholder(): ReactNode {
  const store = useExplorer()
  const t = store.t
  return (
    <div className="rvs-float-placeholder">
      <div className="rvs-float-placeholder-title">{t('float.placeholder')}</div>
      <div className="rvs-float-placeholder-text">{t('float.placeholderHint')}</div>
      <Btn kind="primary" onClick={() => { store.dockFloatingEditor() }}>{t('float.dockBack')}</Btn>
    </div>
  )
}
