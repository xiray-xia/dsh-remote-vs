/**
 * Shared new-remote-workspace wizard (test -> push -> bind path, enforced in
 * order). Used by the Remote tab's Workspaces view and, in Phase 4, by the
 * native directory-flow occupant: `onSaved` carries the materialized alias
 * path the owner adopts as a real workspace.
 */
import { type ReactNode } from 'react';
import type { RemoteHostSummary, RemoteWorkspaceBinding } from '../protocol.ts';
/**
 * Whether an async result belongs to a host/attempt the wizard has left.
 *
 * Every step is host-scoped (`testHost`, `deployPush`, `stat` all take the alias
 * captured when the request started), so a result that arrives after the user
 * switched hosts — or after a newer attempt in the same step — must be dropped:
 * otherwise host B inherits "tested"/"pushed"/"path verified" from host A, and
 * the bind step can save a path nobody checked on B. Pure so the gate can pin it.
 */
export declare function isStaleWizardResult(requestSequence: number, currentSequence: number, requestAlias: string, currentAlias: string): boolean;
/**
 * Whether the path may be considered verified for the host ON SCREEN.
 *
 * `pathOk` alone is not enough: it is set by whichever `stat` answered last, and
 * a host switch (or a slower, older verify) can leave it true for another host.
 */
export declare function wizardPathVerified(pathOk: boolean, verifiedAlias: string | undefined, currentAlias: string): boolean;
export declare function WorkspaceWizard(props: {
    t: (k: string) => string;
    hosts: RemoteHostSummary[];
    onDone: () => void;
    onCancel: () => void;
    /** Phase 4: fired with the materialized alias path before onDone. */
    onSaved?: (workspace: RemoteWorkspaceBinding, aliasPath: string) => void;
}): ReactNode;
