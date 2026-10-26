/**
 * Shell quoting for the lines this plugin types into a remote terminal.
 *
 * One rule, one place: the client builds POSIX shell text in three spots (the
 * `cd` typed into a fresh terminal, the bounded suffix search for an unresolved
 * click target, and the terminal command a menu entry sends), and a second copy
 * of the quoting rule is how an injection bug reappears after it was fixed once.
 *
 * Single quotes are the only form that is safe for arbitrary paths — double
 * quotes still expand `$`, backticks and `\` — and the closing quote is the one
 * character they cannot carry, so it is spliced in as `'\''`.
 */
/**
 * Quote one value for a POSIX shell, as a single word.
 *
 * @param value - the raw path or word.
 * @returns `'value'` with every embedded `'` spliced as `'\''`.
 */
export declare function shellQuote(value: string): string;
/**
 * The command typed into a fresh remote terminal to land in one directory.
 *
 * A trailing newline is NOT included: the caller writes the line and the
 * terminal's Enter, which keeps the same string reusable for display.
 *
 * @param dir - absolute remote directory.
 * @returns `cd '<dir>'`.
 */
export declare function cdCommand(dir: string): string;
