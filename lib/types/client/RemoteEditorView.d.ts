/**
 * The conversation-view tab: the same editor tab strip, previews and diff as
 * the sidebar, mounted next to 对话 / 轨迹 at full width.
 *
 * Registered into the `conversation.view` slot when that slot exists; the
 * sidebar then keeps the whole column for the explorer. Both surfaces read
 * the same module-level store, so a diff opened from source control appears
 * here, and a save here repaints the sidebar's change list.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ReactNode } from 'react';
/**
 * The conversation-view body. The editor surface flag is owned by the client
 * entry (registration success decides it), NOT by this component: the view
 * may be unmounted while another conversation tab is selected, and flipping
 * the flag here would make the sidebar's rail flicker on every tab switch.
 */
export declare function RemoteEditorView(props: {
    ctx: Context;
}): ReactNode;
