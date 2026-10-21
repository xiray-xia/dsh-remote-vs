/**
 * Remote file explorer, VS Code style: per-type icons, git status letters and
 * name tinting, ignored-path greying, right-click file operations, multi
 * select, drag & drop and inline create / rename.
 *
 * The tree stays lazy — one SFTP listing per expanded directory — so git
 * precedence (directory roll-up, ignored inheritance) is computed from the
 * status path set instead of from materialized children; see `scm/status-map`.
 * The `@文件` insertion and the row hover affordance are kept from the
 * previous explorer, and `insertRemoteReference` still writes into the
 * on-screen session's composer draft.
 */
import { type ReactNode } from 'react';
export declare function RemoteExplorer(props: {
    showHidden: boolean;
    onToggleHidden: () => void;
    visible: boolean;
}): ReactNode;
