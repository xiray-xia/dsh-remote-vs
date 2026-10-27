/**
 * The floating editor window: the plugin's ONE editor pane hosted in a
 * draggable, resizable frame above the app shell.
 *
 * It is mounted by the client entry into the host's frame-wide overlay slot
 * (`shell.overlay`) and reads the same module-level store as every other
 * surface, so tabs / previews / diffs / find / change marks / undo / @file are
 * not a re-implementation: this file only owns the FRAME (position, size,
 * z-order, drag + resize + zoom) and the handoff around the mount swap.
 *
 * The mount is exclusive: `EditorPane` must exist exactly once, so the centre
 * conversation view and the sidebar fallback render a placeholder while
 * `editorSurface === 'float'` (see `FloatingEditorPlaceholder`).
 */
import { type ReactNode } from 'react';
import type { Context } from '@deepseek-ai/cordis';
/** The window frame plus the editor. `ctx` is only needed for the boot hook. */
export declare function FloatingEditorWindow(props: {
    ctx: Context;
}): ReactNode;
