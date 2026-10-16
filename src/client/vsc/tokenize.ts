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
export type TokenKind =
  | 'plain'
  | 'comment'
  | 'string'
  | 'keyword'
  | 'number'
  | 'func'
  | 'type'
  | 'attr'
  | 'variable'
  | 'operator'
  | 'punct'
  | 'tag'
  | 'meta'
  | 'insert'
  | 'delete'

export interface Token {
  text: string
  kind: TokenKind
}

/** Carry-over state between lines (block comments, python docstrings). */
export interface LexState {
  blockEnd: string | undefined
}

/** Language ids this tokenizer knows. */
export type LangId =
  | 'js' | 'ts' | 'json' | 'python' | 'shell' | 'yaml' | 'xml' | 'css' | 'markdown' | 'clike' | 'diff'

interface LangSpec {
  lineComment?: string[]
  block?: [string, string]
  /** Quote styles, in scan priority order. */
  strings: { open: string; close: string; escape: boolean; kind?: TokenKind }[]
  keywords: ReadonlySet<string>
  types?: ReadonlySet<string>
  /** Identifiers directly followed by `(` render as functions. */
  callIsFunc?: boolean
  /** `@foo` / `@media` markers. */
  at?: boolean
  /** `#foo` markers (css ids, shell comments handled separately). */
  hash?: 'comment' | 'number' | 'attr'
  /** Backtick command substitution (shell). */
  backticks?: boolean
}

const C_KEYWORDS = `alignas alignof asm auto break case catch class concept const consteval constexpr constinit const_cast continue co_await co_return co_yield
decltype default delete do dynamic_cast else enum explicit export extern false for friend goto if inline mutable namespace new noexcept nullptr operator
override private protected public register reinterpret_cast requires return sizeof static static_assert static_cast struct switch template this thread_local
throw true try typedef typeid typename union using virtual volatile while bool int char double float long short signed unsigned void wchar_t size_t
package import func defer go chan map range select interface struct var let mut impl trait pub fn use mod match loop where async await dyn ref self
super type enum crate abstract assert boolean byte extends final finally implements instanceof native strictfp synchronized throws transient try val
def elif except from global in is lambda nonlocal pass raise with yield None True False and or not`
  .split(/\s+/)
  .filter(s => s !== '')

const JS_KEYWORDS = `await async break case catch class const continue debugger default delete do else enum export extends false finally for from function
get if implements import in instanceof interface let new null of package private protected public return satisfies set static super switch this throw true
try type typeof var void while with yield as declare namespace readonly keyof infer is asserts any unknown never string number boolean symbol bigint
object undefined NaN Infinity`
  .split(/\s+/)
  .filter(s => s !== '')

const PY_KEYWORDS = `and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or
pass raise return try while with yield match case None True False self cls print`
  .split(/\s+/)
  .filter(s => s !== '')

const SHELL_KEYWORDS = `if then else elif fi for while until do done case esac function return break continue local export readonly declare unset set
shift source alias echo printf cd exit test trap eval exec`
  .split(/\s+/)
  .filter(s => s !== '')

const YAML_KEYWORDS = `true false null yes no on off True False Null`
  .split(/\s+/)
  .filter(s => s !== '')

const TYPE_WORDS = `string number boolean any void unknown never object Array Promise Record Map Set Partial Readonly Pick Omit String Number Boolean Object
Integer Float Double Long Int32 Int64 Uint8 uint32_t int32_t uint64_t int64_t size_t FILE std string vector map set unique_ptr shared_ptr auto`
  .split(/\s+/)
  .filter(s => s !== '')

const SPECS: Record<LangId, LangSpec> = {
  js: {
    lineComment: ['//'],
    block: ['/*', '*/'],
    strings: [
      { open: '`', close: '`', escape: true, kind: 'string' },
      { open: "'", close: "'", escape: true },
      { open: '"', close: '"', escape: true },
    ],
    keywords: new Set(JS_KEYWORDS),
    types: new Set(TYPE_WORDS),
    callIsFunc: true,
  },
  ts: {
    lineComment: ['//'],
    block: ['/*', '*/'],
    strings: [
      { open: '`', close: '`', escape: true, kind: 'string' },
      { open: "'", close: "'", escape: true },
      { open: '"', close: '"', escape: true },
    ],
    keywords: new Set(JS_KEYWORDS),
    types: new Set(TYPE_WORDS),
    callIsFunc: true,
    at: true,
  },
  json: {
    lineComment: [],
    strings: [{ open: '"', close: '"', escape: true }],
    keywords: new Set(['true', 'false', 'null']),
    callIsFunc: false,
  },
  python: {
    lineComment: ['#'],
    strings: [
      { open: "'''", close: "'''", escape: false, kind: 'string' },
      { open: '"""', close: '"""', escape: false, kind: 'string' },
      { open: "'", close: "'", escape: true },
      { open: '"', close: '"', escape: true },
    ],
    keywords: new Set(PY_KEYWORDS),
    types: new Set(TYPE_WORDS),
    callIsFunc: true,
    at: true,
  },
  shell: {
    lineComment: ['#'],
    strings: [
      { open: "'", close: "'", escape: false },
      { open: '"', close: '"', escape: true },
    ],
    keywords: new Set(SHELL_KEYWORDS),
    callIsFunc: false,
    backticks: true,
  },
  yaml: {
    lineComment: ['#'],
    strings: [
      { open: "'", close: "'", escape: false },
      { open: '"', close: '"', escape: true },
    ],
    keywords: new Set(YAML_KEYWORDS),
    callIsFunc: false,
  },
  xml: {
    lineComment: [],
    block: ['<!--', '-->'],
    strings: [
      { open: '"', close: '"', escape: false, kind: 'string' },
      { open: "'", close: "'", escape: false, kind: 'string' },
    ],
    keywords: new Set<string>(),
    callIsFunc: false,
  },
  css: {
    lineComment: [],
    block: ['/*', '*/'],
    strings: [
      { open: '"', close: '"', escape: true },
      { open: "'", close: "'", escape: true },
    ],
    keywords: new Set(['important', 'media', 'supports', 'root', 'import', 'keyframes', 'from', 'to', 'and', 'not']),
    callIsFunc: false,
    at: true,
    hash: 'attr',
  },
  markdown: {
    lineComment: [],
    block: ['<!--', '-->'],
    strings: [
      { open: '`', close: '`', escape: false, kind: 'string' },
    ],
    keywords: new Set<string>(),
    callIsFunc: false,
  },
  clike: {
    lineComment: ['//'],
    block: ['/*', '*/'],
    strings: [
      { open: '"', close: '"', escape: true },
      { open: "'", close: "'", escape: true },
    ],
    keywords: new Set(C_KEYWORDS),
    types: new Set(TYPE_WORDS),
    callIsFunc: true,
    at: true,
  },
  diff: {
    lineComment: [],
    strings: [],
    keywords: new Set<string>(),
    callIsFunc: false,
  },
}

const EXT_LANG: Record<string, LangId> = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', vue: 'js', svelte: 'js',
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  json: 'json', jsonc: 'json', json5: 'json', lock: 'json',
  py: 'python', pyi: 'python',
  sh: 'shell', bash: 'shell', zsh: 'shell', ksh: 'shell', fish: 'shell', ps1: 'shell',
  yml: 'yaml', yaml: 'yaml',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', xhtml: 'xml',
  css: 'css', scss: 'css', less: 'css', sass: 'css',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  c: 'clike', h: 'clike', cc: 'clike', cpp: 'clike', cxx: 'clike', hpp: 'clike', hh: 'clike', hxx: 'clike',
  java: 'clike', cs: 'clike', go: 'clike', rs: 'clike', kt: 'clike', kts: 'clike', swift: 'clike',
  m: 'clike', mm: 'clike', php: 'clike', scala: 'clike', groovy: 'clike', sql: 'clike',
  diff: 'diff', patch: 'diff',
}

/** Language for a path (extension based). */
export function langFromPath(path: string): LangId | undefined {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return undefined
  return EXT_LANG[name.slice(dot + 1).toLowerCase()]
}

/** Human label for the editor info row. */
export function langLabel(lang: LangId | undefined): string {
  switch (lang) {
    case 'js': return 'JavaScript'
    case 'ts': return 'TypeScript'
    case 'json': return 'JSON'
    case 'python': return 'Python'
    case 'shell': return 'Shell'
    case 'yaml': return 'YAML'
    case 'xml': return 'HTML/XML'
    case 'css': return 'CSS'
    case 'markdown': return 'Markdown'
    case 'clike': return 'C-family'
    case 'diff': return 'Diff'
    default: return 'Text'
  }
}

const IDENT_START = /[A-Za-z_$\\]/
const IDENT = /[A-Za-z0-9_$]/
const DIGIT = /[0-9]/

/** Fresh state for a new document. */
export function lexState(): LexState {
  return { blockEnd: undefined }
}

/** Tokenize one line, carrying block-comment state across calls. */
export function tokenizeLine(line: string, lang: LangId | undefined, state: LexState): Token[] {
  if (lang === undefined) return line === '' ? [] : [{ text: line, kind: 'plain' }]
  if (lang === 'diff') return tokenizeDiffLine(line)
  if (lang === 'markdown') return tokenizeMarkdown(line)
  const spec = SPECS[lang]
  const out: Token[] = []
  let i = 0
  const push = (text: string, kind: TokenKind): void => {
    if (text === '') return
    const last = out[out.length - 1]
    if (last !== undefined && last.kind === kind) last.text += text
    else out.push({ text, kind })
  }

  while (i < line.length) {
    // Inside a block comment: consume until the terminator.
    if (state.blockEnd !== undefined) {
      const end = line.indexOf(state.blockEnd, i)
      if (end < 0) {
        push(line.slice(i), 'comment')
        return out
      }
      push(line.slice(i, end + state.blockEnd.length), 'comment')
      i = end + state.blockEnd.length
      state.blockEnd = undefined
      continue
    }
    const ch = line[i] as string
    const rest = line.slice(i)

    // Line comments.
    const lc = spec.lineComment?.find(marker => rest.startsWith(marker))
    if (lc !== undefined) {
      if (lang === 'shell' && i > 0 && IDENT.test(line[i - 1] as string)) {
        // `$#`/`${#x}` style: not a comment when glued to a word.
        push(ch, 'plain')
        i += 1
        continue
      }
      push(rest, 'comment')
      return out
    }
    // Block comments.
    if (spec.block !== undefined && rest.startsWith(spec.block[0])) {
      state.blockEnd = spec.block[1]
      continue
    }
    if (lang === 'python' && (rest.startsWith('"""') || rest.startsWith("'''"))) {
      const quote = rest.slice(0, 3)
      const end = line.indexOf(quote, i + 3)
      if (end < 0) {
        push(rest, 'string')
        return out
      }
      push(line.slice(i, end + 3), 'string')
      i = end + 3
      continue
    }
    // Strings.
    const str = spec.strings.find(s => rest.startsWith(s.open))
    if (str !== undefined) {
      let j = i + str.open.length
      let closed = false
      while (j < line.length) {
        if (str.escape && line[j] === '\\') {
          j += 2
          continue
        }
        if (line.startsWith(str.close, j)) {
          j += str.close.length
          closed = true
          break
        }
        j += 1
      }
      push(line.slice(i, closed ? j : line.length), str.kind ?? 'string')
      i = closed ? j : line.length
      continue
    }
    // Numbers.
    if (DIGIT.test(ch) && !IDENT.test(line[i - 1] ?? '')) {
      let j = i
      while (j < line.length && /[0-9a-fA-FxXbBoO._eE+-]/.test(line[j] as string)) {
        // Stop the `+`/`-` run when it is clearly not an exponent.
        const c = line[j] as string
        if ((c === '+' || c === '-') && !/[eE]/.test(line[j - 1] as string)) break
        j += 1
      }
      push(line.slice(i, j), 'number')
      i = j
      continue
    }
    // Identifiers / keywords.
    if (IDENT_START.test(ch)) {
      let j = i + 1
      while (j < line.length && IDENT.test(line[j] as string)) j += 1
      const word = line.slice(i, j)
      let after = j
      while (after < line.length && line[after] === ' ') after += 1
      const kind: TokenKind = spec.keywords.has(word)
        ? 'keyword'
        : (spec.types?.has(word) === true ? 'type' : (spec.callIsFunc === true && line[after] === '(' ? 'func' : 'plain'))
      push(word, kind)
      i = j
      continue
    }
    if (spec.at === true && ch === '@') {
      let j = i + 1
      while (j < line.length && IDENT.test(line[j] as string)) j += 1
      push(line.slice(i, j), 'meta')
      i = j
      continue
    }
    if (spec.hash === 'attr' && ch === '#') {
      let j = i + 1
      while (j < line.length && /[A-Za-z0-9_-]/.test(line[j] as string)) j += 1
      push(line.slice(i, j), 'attr')
      i = j
      continue
    }
    if (spec.backticks === true && ch === '`') {
      const end = line.indexOf('`', i + 1)
      const stop = end < 0 ? line.length : end + 1
      push(line.slice(i, stop), 'string')
      i = stop
      continue
    }
    if (lang === 'xml' && (ch === '<' || ch === '>')) {
      push(ch, 'punct')
      i += 1
      continue
    }
    if (/[{}()[\].,;:]/.test(ch)) {
      push(ch, 'punct')
      i += 1
      continue
    }
    if (/[+\-*/%=<>!&|^~?]/.test(ch)) {
      let j = i + 1
      while (j < line.length && /[+\-*/%=<>!&|^~?]/.test(line[j] as string)) j += 1
      push(line.slice(i, j), 'operator')
      i = j
      continue
    }
    push(ch, 'plain')
    i += 1
  }
  return out
}

/** Diff bodies: keep git's own leading marker as the token class. */
function tokenizeDiffLine(line: string): Token[] {
  if (line.startsWith('@@')) return [{ text: line, kind: 'meta' }]
  if (line.startsWith('+++') || line.startsWith('---')) return [{ text: line, kind: 'meta' }]
  if (line.startsWith('+')) return [{ text: line, kind: 'insert' }]
  if (line.startsWith('-')) return [{ text: line, kind: 'delete' }]
  return [{ text: line, kind: 'plain' }]
}

/** Markdown: headings, list bullets, fenced code, emphasis, links. */
function tokenizeMarkdown(line: string): Token[] {
  const heading = /^(#{1,6}\s)(.*)$/.exec(line)
  if (heading !== null) {
    return [{ text: heading[1] as string, kind: 'meta' }, { text: heading[2] as string, kind: 'keyword' }]
  }
  const bullet = /^(\s*)([-*+]|\d+\.)(\s)(.*)$/.exec(line)
  if (bullet !== null) {
    return [
      { text: bullet[1] as string, kind: 'plain' },
      { text: bullet[2] as string, kind: 'operator' },
      { text: bullet[3] as string, kind: 'plain' },
      { text: bullet[4] as string, kind: 'plain' },
    ]
  }
  if (/^\s*>/.test(line)) return [{ text: line, kind: 'comment' }]
  if (/^\s*(```|~~~)/.test(line)) return [{ text: line, kind: 'meta' }]
  // Inline-code / link pass keeps the rendering honest without a real parser.
  const out: Token[] = []
  const pattern = /(`[^`]*`)|(\*\*[^*]+\*\*)|(\[[^\]]*\]\([^)]*\))/g
  let last = 0
  for (let m = pattern.exec(line); m !== null; m = pattern.exec(line)) {
    if (m.index > last) out.push({ text: line.slice(last, m.index), kind: 'plain' })
    out.push({ text: m[0], kind: m[1] !== undefined ? 'string' : m[2] !== undefined ? 'keyword' : 'func' })
    last = m.index + m[0].length
  }
  if (last < line.length) out.push({ text: line.slice(last), kind: 'plain' })
  return out
}

/** Tokenize a whole document (used by the read-only whole-file panes). */
export function tokenizeDocument(text: string, lang: LangId | undefined): Token[][] {
  const state = lexState()
  return text.split('\n').map(line => tokenizeLine(line, lang, state))
}

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
export class LineTokenCache {
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
  private lines: { text: string; tokens: Token[]; entry: string | undefined; exit: string | undefined }[] = []
  private source: unknown = undefined
  private readonly lang: LangId | undefined

  // NOTE: an explicit field, not a constructor parameter property — the local
  // self-checks run the TypeScript sources directly through Node's strip-only
  // TypeScript support (see the README's self-check section), and that mode
  // rejects a parameter property such as constructor(private readonly x).
  constructor(lang: LangId | undefined) {
    this.lang = lang
  }

  /** Tokenized lines, aligned with the document's lines. */
  get tokens(): readonly Token[][] {
    return this.lines.map(line => line.tokens)
  }

  /** Lines actually re-tokenized by the last refresh (tests and diagnostics). */
  lastTokenizedCount = 0

  /** Bring the cache up to date with a CodeMirror Text. */
  refresh(doc: { lines: number; line(number: number): { text: string } }): void {
    if (doc === this.source) {
      this.lastTokenizedCount = 0
      return
    }
    const next: { text: string; tokens: Token[]; entry: string | undefined; exit: string | undefined }[] = []
    let tokenized = 0
    let carry: string | undefined
    for (let index = 0; index < doc.lines; index += 1) {
      const text = doc.line(index + 1).text
      const prev = this.lines[index]
      if (prev !== undefined && prev.text === text && prev.entry === carry) {
        next.push(prev)
        carry = prev.exit
        continue
      }
      const state = lexState()
      state.blockEnd = carry
      const tokens = tokenizeLine(text, this.lang, state)
      next.push({ text, tokens, entry: carry, exit: state.blockEnd })
      carry = state.blockEnd
      tokenized += 1
    }
    this.lines = next
    this.source = doc
    this.lastTokenizedCount = tokenized
  }
}
