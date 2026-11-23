/**
 * Track what the user has typed on the CURRENT terminal line (pure).
 *
 * Why this exists: `Ctrl+B` should save the command the user is about to run as
 * a snippet, pre-filled. The PTY protocol has no "current line" query, and asking
 * the shell would mean typing into it — so the client reconstructs the line from
 * the same `onData` stream it forwards: printable characters append, backspace
 * removes, Enter/Ctrl+C/Ctrl+U clear, escape sequences (arrows, F-keys, history
 * recall) are ignored.
 *
 * The result is a BEST-EFFORT draft, not a shell parser: after cursor movement or
 * history recall it can differ from the real line. That is acceptable because it
 * only pre-fills an editable form — nothing is executed, and the user can fix it.
 */

/** Longest line worth remembering (a snippet's command is capped separately). */
export const TERMINAL_LINE_MAX = 4000

/**
 * Apply one chunk of terminal INPUT to the current line.
 *
 * @param line - the line reconstructed so far.
 * @param data - the chunk as handed to the PTY (bracketed-paste markers already
 *   stripped by the caller).
 * @returns the new line.
 */
export function applyTerminalInput(line: string, data: string): string {
  if (data === '') return line
  let next = line
  /**
   * Escape-sequence state: xterm hands whole control sequences (arrows, F-keys,
   * history, mouse reports), and none of their bytes may become text.
   *
   *  - `esc`  just saw ESC: look at the introducer;
   *  - `csi`  ESC `[` — consume until a final byte (0x40..0x7e);
   *  - `ss3`  ESC `O` — consume exactly one more byte;
   *  - `osc`  ESC `]` — consume until BEL or ESC `\`.
   */
  let escape: 'none' | 'esc' | 'csi' | 'ss3' | 'osc' | 'osc-esc' = 'none'
  for (const character of data) {
    const code = character.codePointAt(0) ?? 0
    if (escape !== 'none') {
      if (escape === 'esc') {
        if (character === '[') escape = 'csi'
        else if (character === 'O') escape = 'ss3'
        else if (character === ']') escape = 'osc'
        else escape = 'none'
        continue
      }
      if (escape === 'csi') {
        if (code >= 0x40 && code <= 0x7e) escape = 'none'
        continue
      }
      if (escape === 'ss3') {
        escape = 'none'
        continue
      }
      // OSC: BEL ends it, ESC may start the ST terminator.
      if (escape === 'osc') {
        if (code === 0x07) escape = 'none'
        else if (character === '\x1b') escape = 'osc-esc'
        continue
      }
      // `osc-esc`: ESC `\` closes the OSC; anything else resumes the payload.
      escape = character === '\\' ? 'none' : 'osc'
      continue
    }
    if (character === '\r' || character === '\n') {
      // The command was submitted (or a blank line was accepted).
      next = ''
      continue
    }
    if (character === '\x7f' || character === '\b') {
      // Backspace deletes one CODE POINT (not one UTF-16 unit).
      next = next.slice(0, next.length - Math.min(next.length, codePointLengthAtEnd(next)))
      continue
    }
    // Ctrl+C / Ctrl+U / Ctrl+W abandon whatever was typed.
    if (character === '\x03' || character === '\x15' || character === '\x17') {
      next = ''
      continue
    }
    if (character === '\x1b') {
      escape = 'esc'
      continue
    }
    // Other control characters (Ctrl+A/E/B/F/L, Tab completion, …) do not add
    // text; they also do not erase what is there.
    if (code < 0x20) continue
    next += character
    if (next.length > TERMINAL_LINE_MAX) next = next.slice(next.length - TERMINAL_LINE_MAX)
  }
  return next
}

/** UTF-16 length of the last code point in `value` (1 or 2). */
function codePointLengthAtEnd(value: string): number {
  const last = value.charCodeAt(value.length - 1)
  // A low surrogate means the last code point is a surrogate pair.
  return last >= 0xdc00 && last <= 0xdfff ? 2 : 1
}
