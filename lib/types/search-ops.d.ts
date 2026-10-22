export interface ContentSearchOptions {
    /** Regex (ERE) instead of a literal substring. */
    regex: boolean;
    /** Case-sensitive match (grep defaults to sensitive; the UI defaults to off). */
    caseSensitive: boolean;
    /** Match whole words only. */
    wholeWord: boolean;
    /** Maximum result lines returned (a `head` cap, plus a truncation marker). */
    maxResults: number;
    /** Per-line character cap: a minified file must not carry megabytes of one line. */
    maxLineChars: number;
    /** Extra directory names to prune. */
    prune?: readonly string[];
}
export declare const DEFAULT_CONTENT_OPTIONS: ContentSearchOptions;
/** Assert a search query (printable, bounded, no NUL/newline). */
export declare function assertQuery(query: string): string;
/**
 * Recursive content search under one absolute remote directory: `rg` when the
 * host has it, `grep -r` when it does not.
 *
 * Measured on a monorepo of a few million files (two kernel source trees among
 * them): the `grep` form was still running when a 300 s timeout killed it, while
 * the same query scoped to one subtree answers in milliseconds — on a tree that
 * size the SCOPE matters more than the tool, but rg is the faster one, so it is
 * preferred, with the previous grep command kept verbatim as the fallback so
 * behaviour can never get worse than today.
 *
 * Two deliberate differences on the rg path:
 *   - it honours .gitignore (grep never did), which is what keeps build outputs
 *     and kernel artifacts out of an interactive search — the same default VS
 *     Code ships, and the reason `--no-ignore` is NOT passed here;
 *   - `--hidden` keeps dotfiles searchable (`.github/workflows/*.yml`), with
 *     `.git` excluded explicitly so `--hidden` cannot walk a nested repository.
 *
 * The output SHAPE is identical either way (`path\0line:text`, verified byte for
 * byte against both tools on a real host), so `parseContentHits` is unchanged.
 *
 * `--null` puts a NUL between the path and the `line:text` half so a path
 * containing `:` still parses; `cut` bounds each line and `head` bounds the
 * result count (asked for one more than the cap so "truncated" is detectable).
 */
export declare function contentSearchCommand(dir: string, query: string, options?: ContentSearchOptions): string;
/** One content-search hit. */
export interface ContentHit {
    /** Absolute remote path. */
    path: string;
    /** 1-based line number. */
    line: number;
    /** The matching line (possibly truncated by the per-line cap). */
    text: string;
}
export interface ContentSearchResult {
    hits: ContentHit[];
    /** True when the result cap cut the listing short. */
    truncated: boolean;
    /** True when the per-line cap truncated at least one line. */
    linesClipped: boolean;
}
/**
 * Parse the NUL-separated grep output (tolerating a fallback colon format).
 *
 * `maxLineChars` must be the cap the COMMAND was built with, not the default:
 * the parser cannot otherwise know where the `cut` happened, and comparing
 * against the default reports "line clipped" on lines of the wrong length.
 */
export declare function parseContentHits(stdout: string, maxResults?: number, maxLineChars?: number): ContentSearchResult;
/** Group hits by file for display (keeps hit order). */
export declare function groupHits(hits: readonly ContentHit[]): {
    path: string;
    hits: ContentHit[];
}[];
/**
 * Split a line around every match of the query, for highlighting.
 * A regex that does not compile degrades to a literal match.
 *
 * `compiled` is for callers that split MANY lines with one query: compiling a
 * `RegExp` per call costs a few microseconds, which is invisible for one line
 * and adds up to milliseconds for the up-to-400 result rows a content search
 * renders. Pass the same pattern the flags describe (`g`/`gi`, regex mode); a
 * caller that passes nothing keeps the old behaviour.
 */
export declare function splitMatches(text: string, query: string, regex: boolean, caseSensitive: boolean, compiled?: RegExp | null): {
    text: string;
    hit: boolean;
}[];
