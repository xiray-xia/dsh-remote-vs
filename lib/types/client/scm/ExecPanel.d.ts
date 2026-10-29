/**
 * Live output panel for the long network verbs (fetch / pull / push / sync).
 *
 * The unary exec route can only answer after the fact, so a 20-minute Gerrit
 * push used to look like a frozen button. This panel is fed by the streaming
 * exec route: it shows the git/remote output while it runs, a running clock,
 * a cancel button that really stops the remote process group, and keeps the
 * full (tail-capped) log for copying after the fact.
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
