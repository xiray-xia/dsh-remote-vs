/**
 * The conversation-view tab: the same editor (tab strip, previews, diff, status
 * bar) mounted next to 对话 / 轨迹 at full width.
 *
 * This is the OPTIONAL seat now: the docked sidebar pane is the default one, so
 * a file click lands there and this tab shows a "docked in the sidebar"
 * placeholder until the editor's own surface button moves it here. Both seats
 * read the same module-level store, so a diff opened from source control
 * appears here too and a save here repaints the sidebar's change list.
 *
 * While the editor floats (`editorSurface === 'float'`) this tab is NOT the
 * editor's mount any more, so it renders a placeholder instead: mounting a
 * second `EditorPane` would give the same tab two live buffers.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ReactNode } from 'react';
/**
 * The conversation-view body. The editor surface flag is the STORE's (the
 * docked pane is the default; this view renders only while the user has moved
 * the editor here), and deliberately not derived from this component's own
 * mount: the view is unmounted while another conversation tab is selected, so
 * inferring the surface from mount/unmount would flip the sidebar's rail — and
 * its editor — on every host tab switch.
 */
export declare function RemoteEditorView(props: {
    ctx: Context;
}): ReactNode;
