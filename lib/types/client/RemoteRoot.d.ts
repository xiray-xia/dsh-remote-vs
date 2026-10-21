/**
 * Sidebar surface (better-sidebar tab, or the native right-Sidebar fallback):
 * a VS Code-style activity rail plus one column that shows the active view.
 *
 * The editor itself lives in the conversation view next to 轨迹 whenever that
 * registration succeeds (`editorSurface === 'center'`), so the tree keeps the
 * whole column; on a host where the conversation slot is unavailable the old
 * split (panel above the editor) still applies and nothing becomes
 * unreachable.
 */
import type { Context } from '@deepseek-ai/cordis';
import { type ReactNode } from 'react';
export declare function RemoteRoot(props: {
    ctx: Context;
    visible?: boolean;
}): ReactNode;
