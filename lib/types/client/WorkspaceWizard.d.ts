/**
 * Shared new-remote-workspace wizard (test -> push -> bind path, enforced in
 * order). Used by the Remote tab's Workspaces view and, in Phase 4, by the
 * native directory-flow occupant: `onSaved` carries the materialized alias
 * path the owner adopts as a real workspace.
 */
import { type ReactNode } from 'react';
import type { RemoteHostSummary, RemoteWorkspaceBinding } from '../protocol.ts';
export declare function WorkspaceWizard(props: {
    t: (k: string) => string;
    hosts: RemoteHostSummary[];
    onDone: () => void;
    onCancel: () => void;
    /** Phase 4: fired with the materialized alias path before onDone. */
    onSaved?: (workspace: RemoteWorkspaceBinding, aliasPath: string) => void;
}): ReactNode;
