/**
 * xterm colour theme, kept free of React/DOM so a gate can assert it.
 *
 * The palette is OPAQUE on purpose: xterm's contrast engine cannot reason about
 * translucent colours, and a terminal over a wallpaper needs a definite surface.
 *
 * Selection colours are explicit per scheme. xterm's defaults assume a dark
 * background, so in the light theme a selected block rendered white-on-white —
 * copy worked while "selecting" looked like it did nothing (reported
 * 2026-11-23). These are the VS Code selection colours, with a dimmer variant
 * for an unfocused window.
 *
 * Only a TYPE import from xterm here: the module must stay loadable in Node for
 * the gate (`@xterm/xterm`'s entry pulls CSS/UMD code).
 */
import type { ITheme } from '@xterm/xterm';
/** The dark scheme palette. */
export declare const DARK_TERMINAL_THEME: ITheme;
/** The light scheme palette. */
export declare const LIGHT_TERMINAL_THEME: ITheme;
/** The palette for one scheme. */
export declare function terminalTheme(dark: boolean): ITheme;
