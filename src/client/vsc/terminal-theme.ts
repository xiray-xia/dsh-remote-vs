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
import type { ITheme } from '@xterm/xterm'

/** The dark scheme palette. */
export const DARK_TERMINAL_THEME: ITheme = {
  background: '#0e0e13',
  foreground: '#e8e8e8',
  cursor: '#e8e8e8',
  selectionBackground: '#264f78',
  selectionInactiveBackground: '#333c48',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e910',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#7a7a7a',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
}

/** The light scheme palette. */
export const LIGHT_TERMINAL_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#1a1a1a',
  cursor: '#1a1a1a',
  selectionBackground: '#add6ff',
  selectionInactiveBackground: '#d7e7f5',
  black: '#000000',
  red: '#cd3131',
  green: '#00bc67',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
}

/** The palette for one scheme. */
export function terminalTheme(dark: boolean): ITheme {
  return dark ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME
}
