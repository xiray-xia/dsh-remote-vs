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
import type { ReactNode } from 'react';
/** Which seat currently owns the editor. */
export type PlaceholderMode = 'float' | 'sidebar' | 'center';
export declare function FloatingEditorPlaceholder(props: {
    mode?: PlaceholderMode;
}): ReactNode;
