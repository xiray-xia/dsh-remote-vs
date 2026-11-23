/**
 * The "常用指令" panel above the terminal: a personal library of NAME + COMMAND
 * pairs that paste into the active terminal's command line WITHOUT pressing
 * Enter (misclick safety: the user still reviews and runs it).
 *
 * Why it is a popover rather than a dock: the terminal needs the whole column
 * for output; the list is opened deliberately, used once, and dismissed. The
 * panel is portaled with fixed coordinates so the terminal's own scroller and
 * the sidebar's `overflow: hidden` cannot clip it.
 *
 * Snapshot + subscribe come from `terminal-snippets.ts` (one list shared with the
 * Ctrl+B quick-add shortcut, which `XTerm` reports as a counter prop).
 */
import { type ReactNode } from 'react';
/** Props of the panel (plus the button that opens it). */
export interface TerminalSnippetsProps {
    /** Translator. */
    t: (key: string) => string;
    /** Insert one command into the active terminal; false when none is mounted. */
    onInsert: (command: string) => boolean;
    /** Bumped by the Ctrl+B shortcut; each change opens the ADD dialog. */
    addRequest: number;
    /**
     * Draft the Ctrl+B form starts with (the terminal selection, else the line
     * reconstructed from keystrokes). Empty for the panel's own "+" button.
     */
    addContent: string;
}
/**
 * The panel.
 *
 * Kept in one component on purpose: the button, the popover, the form and their
 * shared focus/dismissal rules are one interaction, and splitting them would
 * need a context for four pieces of state.
 */
export declare function TerminalSnippets(props: TerminalSnippetsProps): ReactNode;
