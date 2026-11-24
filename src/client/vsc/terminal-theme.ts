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

/**
 * The dark scheme palette.
 *
 * Contrast is measured against `background` (#0e0e13): the VS Code Dark+ ANSI
 * set, with red / blue / magenta / brightBlack lifted just past 4.5:1 (`black`
 * is left at #000000 on purpose — ANSI black is a background-fill colour by
 * convention and is not read as text; 1.09:1). `brightCyan` is lifted off the
 * plain cyan (#29b8db sat only ΔE76 6.0 from #11a8cd — the pair read as one
 * colour) to #4dd0e1: ΔE76 18.5, 10.5:1 on the terminal surface.
 */
export const DARK_TERMINAL_THEME: ITheme = {
  background: '#0e0e13',
  foreground: '#e8e8e8',
  cursor: '#e8e8e8',
  selectionBackground: '#264f78',
  selectionInactiveBackground: '#333c48',
  black: '#000000',
  red: '#d54f4f',
  green: '#0dbc79',
  yellow: '#e5e910',
  blue: '#2f7fd6',
  magenta: '#cc55cc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#858585',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#4dd0e1',
  brightWhite: '#ffffff',
}

/**
 * The light scheme palette.
 *
 * Re-taken for a WHITE background (2026-11-23): the Dark+ ANSI set this used to
 * copy measured 1.0–3.6:1 on #ffffff (brightWhite was white-on-white = 1.00,
 * brightYellow 1.17). Text here is targeted at ≥4.5:1, and every colour is.
 *
 * "Bright" cannot mean "lighter" on white, so the bright group is the more
 * saturated sibling of its hue rather than a lighter one; where a hue had to be
 * re-picked the normal/bright pair keeps a visible difference. `brightWhite` is
 * the one colour that has no readable white-ish form: it is #767676, the
 * lightest neutral of the ramp, which keeps "bright white" distinguishable from
 * `white`/`brightBlack` while reaching 4.54:1 (VS Code Light+ ships #e5e5e5,
 * 1.05:1 — unreadable). `black` stays #000000 (ANSI background-fill convention).
 * `brightCyan` moves to the teal step #0f766e: the previous #0e7490 sat ΔE76
 * 4.0 from `cyan` (#0b6d84) and read as the same colour; the new value is ΔE76
 * 20.5 away at 5.47:1.
 */
export const LIGHT_TERMINAL_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#1a1a1a',
  cursor: '#1a1a1a',
  selectionBackground: '#add6ff',
  selectionInactiveBackground: '#d7e7f5',
  black: '#000000',
  red: '#b02a2a',
  green: '#0b6b0b',
  yellow: '#6f5f00',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0b6d84',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#107c10',
  brightYellow: '#8a6d00',
  brightBlue: '#1a6fc4',
  brightMagenta: '#bd31bd',
  brightCyan: '#0f766e',
  brightWhite: '#767676',
}

/** The palette for one scheme. */
export function terminalTheme(dark: boolean): ITheme {
  return dark ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME
}
