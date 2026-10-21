/**
 * Settings section occupants (`settings.section`, ids `remote-hosts` and
 * `remote-workspaces`): the full host manager plus the binding list/wizard,
 * living in the DSH Settings dialog instead of the Remote tab.
 * Self-contained: each section fetches its own data so they work without any
 * injected face or sidebar.
 *
 * They also feed the sidebar's shared store after a mutation (see `reload`):
 * the two surfaces list the same hosts/bindings, and a workspace created here
 * used to stay invisible in the Remote tab until the whole page reloaded.
 */
import { type ReactNode } from 'react';
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client';
export declare function SettingsHostsSection(_props: SettingsSectionOwnerProps): ReactNode;
export declare function SettingsWorkspacesSection(_props: SettingsSectionOwnerProps): ReactNode;
