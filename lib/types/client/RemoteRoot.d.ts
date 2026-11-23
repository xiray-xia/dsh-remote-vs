/**
 * Sidebar surface (better-sidebar tab, or the native right-Sidebar fallback):
 * a VS Code-style activity rail plus one column that shows the active view.
 *
 * The DOCKED editor is the default seat (`editorSurface === 'sidebar'`) and it
 * is a FULL-COLUMN rail page — one view at a time, like the local sidebar
 * plugin: opening a file switches the column to the editor, and closing its last
 * file switches back to the directory. The conversation-view tab next to 轨迹 is
 * the OPTIONAL full-width seat the editor's own button switches to.
 */
import type { Context } from '@deepseek-ai/cordis';
import { type ReactNode } from 'react';
/**
 * Which tabs a recovered link must reload, and how many dirty tabs to warn about.
 *
 * Pure so the gate can drive it with a synthetic list: the recovery timer used
 * to close over the tab array of the render that STARTED it (10 s earlier), so a
 * tab opened or closed in that window was missed. Only clean file/diff tabs are
 * reloaded; a dirty tab is the user's unsaved work and must never be replaced.
 */
export declare function planRecoveryReload(tabs: readonly {
    id: string;
    dirty: boolean;
    loading: boolean;
    kind: string;
}[]): {
    dirty: number;
    reload: string[];
};
export declare function RemoteRoot(props: {
    ctx: Context;
    visible?: boolean;
}): ReactNode;
