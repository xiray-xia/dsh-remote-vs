/**
 * Live output panel for the long network verbs (fetch / pull / push / sync).
 *
 * The unary exec route can only answer after the fact, so a 20-minute Gerrit
 * push used to look like a frozen button. This panel is fed by the streaming
 * exec route: it shows the git/remote output while it runs, a running clock,
 * a stop button that really kills the remote process group, and keeps the full
 * (tail-capped) log for copying after the fact.
 *
 * Rendered through a PORTAL on `document.body`: the SCM panel lives inside the
 * sidebar's keep-alive slot, which the host hides with `display:none` when
 * another rail view is picked — and a `position: fixed` descendant of a hidden
 * ancestor disappears with it, taking the only cancel affordance of a running
 * push along. The portal keeps the panel (and its stop button) reachable.
 */
import { type ReactNode } from 'react';
export type ExecPanelStatus = 'running' | 'done' | 'error' | 'cancelled';
export interface ExecPanelState {
    title: string;
    output: string;
    status: ExecPanelStatus;
    /** Wall-clock start, so the timer survives re-renders. */
    startedAt: number;
    elapsedMs: number;
    /** One-line footer: exit code / duration / error. */
    exitText?: string;
}
export interface ExecPanelProps {
    state: ExecPanelState;
    onCancel: () => void;
    onClose: () => void;
    t: (key: string) => string;
}
export declare function ExecPanel(props: ExecPanelProps): ReactNode;
