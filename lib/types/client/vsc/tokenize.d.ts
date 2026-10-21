/**
 * Line tokenizer for the read-only panes (diff sides, history file peek).
 *
 * The plugin ships no syntax-highlighting dependency: CodeMirror already
 * colors the editor, and this module covers the read-only surfaces with one
 * small scanner driven by per-language descriptors, producing token runs the
 * views turn into `<span class="rvs-t-*">`. Line-based by design (the diff
 * aligns rows, so a per-line API is what the callers need); the only
 * carry-over state is "inside a block comment", which is the case that
 * visibly breaks a line-by-line colorizer.
 */
/** Token classes (mirrors the GitHub Dark palette in vsc.css). */
export type TokenKind = 'plain' | 'comment' | 'string' | 'keyword' | 'number' | 'func' | 'type' | 'attr' | 'variable' | 'operator' | 'punct' | 'tag' | 'meta' | 'insert' | 'delete';
export interface Token {
    text: string;
    kind: TokenKind;
}
/**
 * Carry-over state between lines: BLOCK COMMENTS ONLY.
 *
 * Python triple-quoted strings deliberately do not carry over — the python
 * branch returns as soon as it finds no closing quote on the line, so a
 * multi-line docstring is coloured on its first line and left plain after it.
 * The docstring here used to claim otherwise.
 */
export interface LexState {
    blockEnd: string | undefined;
}
/** Language ids this tokenizer knows. */
export type LangId = 'js' | 'ts' | 'json' | 'python' | 'shell' | 'yaml' | 'xml' | 'css' | 'markdown' | 'clike' | 'diff';
/** Language for a path (extension based). */
export declare function langFromPath(path: string): LangId | undefined;
/** Human label for the editor info row. */
export declare function langLabel(lang: LangId | undefined): string;
/** Fresh state for a new document. */
export declare function lexState(): LexState;
/** Tokenize one line, carrying block-comment state across calls. */
export declare function tokenizeLine(line: string, lang: LangId | undefined, state: LexState): Token[];
/** Tokenize a whole document (used by the read-only whole-file panes). */
export declare function tokenizeDocument(text: string, lang: LangId | undefined): Token[][];
/**
 * A `Text`-backed token cache that survives edits.
 *
 * Why it exists: the fallback colorer used to run `tokenizeDocument(doc
 * .toString())` on every keystroke — a full-document string plus one array
 * per line, re-allocated for each key, on precisely the large files the
 * fallback is for. Here each line keeps its text, tokens and the block state
 * it entered with, so an unchanged line is carried over untouched and only
 * the edited region is re-tokenized.
 *
 * Lives next to the tokenizer (instead of inside the CodeMirror plugin) so
 * the plugin and its self-check exercise the SAME code — a harness that
 * reimplements the cache proves nothing about the shipped one.
 *
 * Correctness rests on one property: a line whose text AND entry block state
 * both match the previous run retokenizes to exactly the same thing, so it can
 * be carried over untouched. Nothing here tries to stop early — the block
 * state can legitimately return to an earlier value (a closing marker ends a
 * block comment), so "the state matches again" does NOT imply the rest is
 * unchanged and an early break would reuse a stale tail.
 *
 * What is actually saved per keystroke is the full-document string the old
 * path materialized (doc.toString plus split on newline, i.e. one array per
 * line) and every token array outside the edited region; walking the lines is
 * what remains.
 */
export declare class LineTokenCache {
    /**
     * `entry`/`exit` are the block state BEFORE and AFTER the line.
     *
     * Both are needed. The entry state decides whether the cached tokens are
     * still valid (closing a block comment above re-colors every line below even
     * though their text is untouched), and the exit state is what lets a reused
     * line advance the walk — without it the tokenizer state would stay frozen
     * at a reused line and every later line would be classified against the
     * wrong state.
     */
    private lines;
    /** The `tokens` getter's result, dropped by `refresh` (see the getter). */
    private tokensCache;
    private source;
    private readonly lang;
    constructor(lang: LangId | undefined);
    /**
     * Tokenized lines, aligned with the document's lines.
     *
     * Cached, because this is read on the PAINT path: the fallback highlighter
     * asks for it on every viewport change, and `.map()` over every line
     * allocated a fresh N-element array (N = the whole document's line count) per
     * access — one whole-document array per scrolled frame. The cache is dropped
     * whenever `refresh` replaces `lines` (below), and the per-line token arrays
     * it collects are the same objects that are reused across refreshes.
     */
    get tokens(): readonly Token[][];
    /** Lines actually re-tokenized by the last refresh (tests and diagnostics). */
    lastTokenizedCount: number;
    /** Bring the cache up to date with a CodeMirror Text. */
    refresh(doc: {
        lines: number;
        line(number: number): {
            text: string;
        };
    }): void;
}
