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
export declare const TERMINAL_LINE_MAX = 4000;
/**
 * Apply one chunk of terminal INPUT to the current line.
 *
 * @param line - the line reconstructed so far.
 * @param data - the chunk as handed to the PTY (bracketed-paste markers already
 *   stripped by the caller).
 * @returns the new line.
 */
export declare function applyTerminalInput(line: string, data: string): string;
