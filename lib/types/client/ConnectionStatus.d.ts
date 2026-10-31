/**
 * Connection status for the workspace on screen.
 *
 * Two renderings, one source of truth: a chip in the remote surface's top bar
 * (dot + label) and a compact dot in the editor's info bar. Clicking an errored
 * chip retries the connection; the Host's pool records the attempt, and the next
 * status poll (or the retry itself) repaints the chip.
 */
import { type ReactNode } from 'react';
export declare function ConnectionStatusChip(props: {
    compact?: boolean;
}): ReactNode;
