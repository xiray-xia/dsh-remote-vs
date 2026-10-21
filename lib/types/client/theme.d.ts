/**
 * Live DSH theme access (adapted from dsh-better-sidebar's theme.ts): the
 * app shell projects the resolved scheme onto body[data-ds-dark-theme] and
 * html { color-scheme }. Read the resolved scheme — never the OS media
 * query alone (the user may run a light OS with a dark DSH theme).
 */
/** Whether the app shell resolved to the dark scheme. */
export declare function isDarkScheme(): boolean;
/**
 * Subscribe to color-scheme flips (the presenter toggles the body
 * attribute). The callback fires after the attribute changed; re-read the
 * scheme inside it.
 * @returns the disposer.
 */
export declare function subscribeColorScheme(callback: () => void): () => void;
