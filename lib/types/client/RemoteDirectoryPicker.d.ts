/**
 * Remote directory picker modal (native-picker-styled): path field + Go,
 * Home/Up shortcuts, scrollable directory list, pick-current-folder commit.
 * Directory-only listing over the files API; entering a symlink resolves
 * server-side (a link-to-file surfaces as a readable error).
 */
import { type ReactNode } from 'react';
export declare function RemoteDirectoryPicker(props: {
    t: (k: string) => string;
    open: boolean;
    title: string;
    alias: string;
    initialPath: string;
    onPick: (path: string) => void;
    onCancel: () => void;
}): ReactNode;
