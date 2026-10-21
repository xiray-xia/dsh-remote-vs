/**
 * Workspaces view: bindings list + the shared new-remote-workspace wizard.
 */
import { type ReactNode } from 'react';
import type { RemoteHostSummary, RemoteRoutingStatus, RemoteWorkspaceBinding } from '../protocol.ts';
export declare function WorkspacesView(props: {
    t: (k: string) => string;
    hosts: RemoteHostSummary[];
    workspaces: RemoteWorkspaceBinding[];
    routing: RemoteRoutingStatus;
    onChanged: () => void;
    /** Open the files view for a binding; omitted where no files view exists (settings section hides the button). */
    onOpenFiles?: (workspaceId: string) => void;
}): ReactNode;
