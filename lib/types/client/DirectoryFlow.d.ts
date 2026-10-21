/**
 * Phase 4 native directory-flow occupant: a Local/Remote tabbed dialog that
 * shadows the stock picker (registered at priority -1 into both
 * directory-flow holes).
 *
 * - Local leg: dual-mode. When the Host serves the browse capability, a
 *   compact in-app browser drives uiWorkspace.listDirectory/createDirectory.
 *   When it serves native (this Windows machine), one button opens the OS
 *   chooser via uiWorkspace.pickDirectory. The mode is probed once per open:
 *   a working list() means browse, `directory-picker/unavailable` means
 *   native, anything else is an inline error with retry.
 * - Remote leg: the shared WorkspaceWizard; on save the materialized alias
 *   path goes to onPicked and the owner adopts it as a real workspace
 *   (its title was already set to `<server> > <base>` by syncWorkspaces).
 *
 * The occupant never drives the owner's onError arm: every failure stays
 * inside the dialog (stock BrowseDirectoryFlow does the same), and Cancel is
 * always available. If this entry ever crashes, slot shadowing retires it and
 * the stock picker renders (graceful fallback, no dead surface).
 */
import { type ReactNode } from 'react';
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types';
/** Injected face: uiWorkspace directory primitives (bound in apply's closure). */
export interface DirectoryFlowInjected {
    listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>;
    createDirectory: (path: string, name: string) => Promise<string>;
    pickDirectory: () => Promise<string | null>;
}
export declare function RemoteDirectoryFlow(props: DirectoryFlowOwnerProps & DirectoryFlowInjected): ReactNode;
