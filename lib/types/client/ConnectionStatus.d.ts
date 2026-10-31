/**
 * Connection status for the workspace on screen.
 *
 * Two renderings, one source of truth: a chip in the remote surface's top bar
 * (dot + label) and a compact dot in the editor's info bar. The chip is a
 * read-out in the healthy states and a RETRY control in the errored one.
 *
 * An errored link self-heals: a bounded auto-retry (one dial per tick, at most
 * AUTO_RETRY_MAX_ATTEMPTS in a row) runs while the page is visible, so a network
 * that comes back does not need a user action. It stops after the budget and
 * leaves the manual click — repeated dials against a password-auth host can
 * count towards a lockout, so this is deliberately not an endless loop.
 */
import { type ReactNode } from 'react';
export declare function ConnectionStatusChip(props: {
    compact?: boolean;
}): ReactNode;
