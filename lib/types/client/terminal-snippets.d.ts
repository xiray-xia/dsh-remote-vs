/**
 * Common-command snippets: the little "常用指令" library above the terminal.
 *
 * A snippet is a NAME plus the COMMAND it stands for. Clicking one in the panel
 * pastes the command into the active terminal's command line WITHOUT pressing
 * Enter — the user reviews and runs it themselves, so a misclick cannot execute
 * `rm -rf`.
 *
 * Storage is per browser (localStorage), like the port-forward rules and the
 * editor preferences: this is a personal convenience list, not workspace state,
 * and the host is told nothing about it. The pure half is exported so the gate
 * can drive parsing / CRUD / ordering without a DOM, and the module-level store
 * (snapshot + subscribe) is what makes the popover and the Ctrl+B shortcut share
 * one list.
 */
/** One saved command. */
export interface TerminalSnippet {
    /** Stable identity (never reused, so drag/reorder cannot swap rows). */
    id: string;
    /** Short label shown in the list. */
    name: string;
    /** The command text pasted into the terminal (not executed). */
    command: string;
}
/** localStorage key (one JSON array, so the list cannot half-update). */
export declare const SNIPPETS_KEY = "dsh-remote-vs.term.snippets";
/** Hard caps: a snippet list is a convenience, not a dataset. */
export declare const SNIPPETS_MAX = 200;
export declare const SNIPPET_NAME_MAX = 80;
export declare const SNIPPET_COMMAND_MAX = 4000;
/** A fresh identity for one snippet. */
export declare function createSnippetId(): string;
/**
 * Normalize one user-entered snippet; `undefined` when it is unusable.
 *
 * Both fields are required (an unnamed command is unfindable, an empty command
 * does nothing) and both are trimmed — a leading/trailing newline in a pasted
 * command would otherwise send an empty line and RUN the command, which is
 * exactly what this feature promises not to do.
 */
export declare function sanitizeSnippetInput(input: {
    name?: string;
    command?: string;
}): {
    name: string;
    command: string;
} | undefined;
/** Parse the persisted JSON; anything malformed is dropped, never repaired silently. */
export declare function parseSnippets(raw: string | null | undefined): TerminalSnippet[];
/** Serialize only the known fields. */
export declare function serializeSnippets(list: readonly TerminalSnippet[]): string;
/** Append one snippet (newest last); returns the SAME array when it is invalid. */
export declare function addSnippet(list: readonly TerminalSnippet[], input: {
    name?: string;
    command?: string;
}, id?: string): SnippetList;
/** Replace one snippet's fields; an invalid edit leaves the list untouched. */
export declare function updateSnippet(list: readonly TerminalSnippet[], id: string, input: {
    name?: string;
    command?: string;
}): SnippetList;
/** Drop one snippet. */
export declare function removeSnippet(list: readonly TerminalSnippet[], id: string): SnippetList;
/**
 * Move one snippet to another index (drag & drop), clamping both ends.
 *
 * Returning the SAME list for a no-op keeps the store's "did it change" test
 * cheap and stops a drag that lands on its own row from re-rendering everything.
 */
export declare function moveSnippet(list: readonly TerminalSnippet[], from: number, to: number): SnippetList;
/** A list type that is either the caller's unchanged value or a new array. */
type SnippetList = readonly TerminalSnippet[];
/** Current list (identity-stable while unchanged, safe for useSyncExternalStore). */
export declare function snippetsSnapshot(): readonly TerminalSnippet[];
/** Subscribe to snippet changes; returns the unsubscribe. */
export declare function subscribeSnippets(listener: () => void): () => void;
/**
 * Apply one pure transition and persist it when it really changed.
 *
 * The updater must be pure and return either the same array (no change → no
 * notification, no write) or a new one; every CRUD helper above already does.
 */
export declare function updateSnippets(updater: (list: readonly TerminalSnippet[]) => readonly TerminalSnippet[]): void;
/** Reset the module store (the gate drives it directly; production never calls it). */
export declare function resetSnippetsForTests(list?: readonly TerminalSnippet[]): void;
export {};
