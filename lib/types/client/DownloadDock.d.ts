/**
 * Download progress dock.
 *
 * Rendered through a PORTAL on `document.body`: the dock starts inside the
 * sidebar's keep-alive slot, and a `position: fixed` descendant of a hidden
 * ancestor disappears with it — which would take the progress bar (and the
 * cancel button) of a running download along when the user switches rail views.
 *
 * The runner lives in `downloads.ts`, outside React, so an unmount of this
 * component never interrupts a transfer; the dock only reads its snapshot.
 */
import { type ReactNode } from 'react';
export declare function DownloadDock(props: {
    t: (key: string) => string;
}): ReactNode;
