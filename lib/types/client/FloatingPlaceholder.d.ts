/**
 * What the centre conversation view and the sidebar fallback show while the
 * editor is popped out: the editor itself is a single instance and lives in the
 * floating window, so these surfaces must not mount a second one (that would
 * be two live CodeMirror buffers for one tab — the exact defect `EditorPane`'s
 * header warns about). A dock button keeps the surface from looking broken.
 */
import type { ReactNode } from 'react';
export declare function FloatingEditorPlaceholder(): ReactNode;
