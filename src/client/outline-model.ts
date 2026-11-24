/**
 * 文件符号大纲的纯函数模型：文本 + 路径 → 有序符号列表。
 *
 * 为什么不用编辑器里现成的 lezer 语法树
 * --------------------------------------
 * 1. `ensureSyntaxTree` 有时间预算，长文件尾部会解析不出来；大纲沉默地只覆盖
 *    前一半，比没有大纲更误导（审计对 blame 窗口提过同一类坑）。
 * 2. 大纲必须在文件 dirty 时按**实时 buffer**重算，读 `EditorView` 会把本模块
 *    绑死在编辑器身上，也让纯函数门禁没法跑。
 * 3. 没有 lezer 语法的语言（shell、配置、C 头文件…）本来就要有降级路径；既然
 *    降级要写，就让同一套行扫描服务全部语言 —— 排序/嵌套规则因此完全一致。
 *
 * 做法：先把注释和字符串「挖空」（长度不变、换行保留），再逐行匹配声明。挖空
 * 之后 `// class Fake` 或 `"func Fake()"` 里的关键字不再可能是符号；嵌套用大括
 * 号深度（C 家族）或缩进（Python/未知语言）表达。
 *
 * 这是**大纲**，不是解析器：多行签名、嵌套泛型、宏生成的名字会漏；宁可漏也不
 * 误报成另一种符号 —— UI 会把「猜的」明确标出来。
 */
import { fuzzyScore } from './quickopen-model.ts'

export type OutlineLanguage =
  | 'java' | 'c' | 'cpp' | 'go' | 'rust' | 'python' | 'javascript' | 'typescript' | 'unknown'

export type OutlineKind =
  | 'class' | 'interface' | 'struct' | 'enum' | 'trait' | 'impl' | 'namespace'
  | 'module' | 'function' | 'method' | 'constructor' | 'field' | 'variable' | 'type' | 'macro'

export interface OutlineEntry {
  name: string
  kind: OutlineKind
  /** 1-based 行号（与 `revealRange` 同一套语义）。 */
  line: number
  /** 嵌套层数，0 = 顶层。用缩进表达嵌套，不暴露大括号深度。 */
  depth: number
  /** 直接外层类型/命名空间的名字（没有就是顶层）。 */
  container?: string
}

export interface OutlineResult {
  language: OutlineLanguage
  entries: OutlineEntry[]
  /** 扫描到的符号总数；可能大于 `entries.length`（被上限截断）。 */
  total: number
  truncated: boolean
  /** 语言未识别：条目是按缩进 + 关键字猜的，UI 必须标注。 */
  guessed: boolean
}

/**
 * 单个文件最多列出的条目数。
 *
 * 20k 行的 Java 文件大约几百个符号，5000 已经远超真实代码；设上限是为了让病态
 * 输入（生成代码、压缩成一行的 JSON 式脚本）不会把 DOM 拖垮，同时 `total` 仍然
 * 报出真实数量，截断不撒谎。
 */
export const OUTLINE_MAX_ENTRIES = 5000

/** 面板一次渲染的候选上限（过滤后）。 */
export const OUTLINE_RESULT_LIMIT = 300

/** 扩展名 → 语言。C 头文件与 C++ 头文件都按 C/C++ 处理。 */
const LANGUAGE_BY_EXTENSION: Record<string, OutlineLanguage> = {
  java: 'java',
  c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', inl: 'cpp', ipp: 'cpp',
  go: 'go',
  rs: 'rust',
  py: 'python', pyw: 'python', pyi: 'python',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
}

/** 由远端路径判断语言；不认识就返回 `unknown`（走降级大纲）。 */
export function outlineLanguageOf(path: string): OutlineLanguage {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/[?#].*$/, '')
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'unknown'
  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? 'unknown'
}

// --------------------------------------------------------------- 注释/字符串挖空

interface MaskRules {
  /** `//` 行注释 */
  lineSlash: boolean
  /** `/* ... *\/` 块注释 */
  blockSlash: boolean
  /** `#` 行注释（Python / 未知语言） */
  hash: boolean
  /** `'...'` 字符串（Rust 关掉：`'a` 是生命周期，不是字符字面量） */
  single: boolean
  double: boolean
  backtick: boolean
  /** `'''` / `"""` 多行字符串（Python 文档字符串） */
  triple: boolean
}

function maskRulesFor(language: OutlineLanguage): MaskRules {
  if (language === 'python') {
    return { lineSlash: false, blockSlash: false, hash: true, single: true, double: true, backtick: false, triple: true }
  }
  if (language === 'unknown') {
    return { lineSlash: true, blockSlash: true, hash: true, single: true, double: true, backtick: true, triple: false }
  }
  return {
    lineSlash: true,
    blockSlash: true,
    hash: false,
    single: language !== 'rust',
    double: true,
    backtick: true,
    triple: false,
  }
}

/**
 * 把注释与字符串逐字符替换成空格（换行保留），返回按行切好的副本。
 *
 * 「长度不变」很重要：任何后续的行内偏移都还对得上原文件，行号也直接来自下标。
 * 状态机是近似的（C++ 原始字符串、Java 文本块、JS 正则字面量不特殊处理），目标
 * 是让「注释/字符串里的伪符号」不出现，不是做词法分析。
 */
export function maskSource(text: string, language: OutlineLanguage): string[] {
  const rules = maskRulesFor(language)
  const masked: string[] = []
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'backtick' | 'triple' = 'code'
  let tripleQuote = ''
  let escaped = false
  for (let at = 0; at < text.length; at += 1) {
    const character = text[at] as string
    if (character === '\n') {
      // 行注释和单行字符串到行尾结束；块注释/三引号跨行延续。
      if (mode === 'line' || mode === 'single' || mode === 'double') mode = 'code'
      escaped = false
      masked.push('\n')
      continue
    }
    if (mode === 'code') {
      const next = text[at + 1]
      if (rules.lineSlash && character === '/' && next === '/') { mode = 'line'; masked.push('  '); at += 1; continue }
      if (rules.blockSlash && character === '/' && next === '*') { mode = 'block'; masked.push('  '); at += 1; continue }
      if (rules.hash && character === '#') { mode = 'line'; masked.push(' '); continue }
      if (rules.triple && (character === '"' || character === "'") && text.startsWith(character.repeat(3), at)) {
        mode = 'triple'
        tripleQuote = character
        masked.push('   ')
        at += 2
        continue
      }
      if (rules.single && character === "'") { mode = 'single'; masked.push(' '); continue }
      if (rules.double && character === '"') { mode = 'double'; masked.push(' '); continue }
      if (rules.backtick && character === '`') { mode = 'backtick'; masked.push(' '); continue }
      masked.push(character)
      continue
    }
    // 注释/字符串内部：一律挖成空格，只有结束符能把状态切回去。
    masked.push(' ')
    if (mode === 'block') {
      if (character === '*' && text[at + 1] === '/') { mode = 'code'; masked.push(' '); at += 1 }
      continue
    }
    if (escaped) { escaped = false; continue }
    if (character === '\\') { escaped = true; continue }
    if (mode === 'triple') {
      if (character === tripleQuote && text.startsWith(tripleQuote.repeat(3), at)) {
        mode = 'code'
        masked.push('  ')
        at += 2
      }
      continue
    }
    if ((mode === 'single' && character === "'")
      || (mode === 'double' && character === '"')
      || (mode === 'backtick' && character === '`')) mode = 'code'
  }
  return masked.join('').split('\n')
}

// ------------------------------------------------------------------ 行内工具

/** 一行里从 `startDepth` 开始、走到 `position` 之前的大括号深度。 */
function depthAtIn(line: string, startDepth: number, position: number): number {
  let next = startDepth
  const end = Math.min(position, line.length)
  for (let at = 0; at < end; at += 1) {
    const character = line[at]
    if (character === '{') next += 1
    else if (character === '}') next -= 1
  }
  return next
}

/** 处理完整行之后的大括号深度。 */
function depthAfter(line: string, startDepth: number): number {
  return depthAtIn(line, startDepth, line.length)
}

/** Net `(` minus `)` on one masked line, for multi-line signature detection. */
function parenDelta(line: string): number {
  let delta = 0
  for (const character of line) {
    if (character === '(') delta += 1
    else if (character === ')') delta -= 1
  }
  return delta
}

/** 行的缩进列数（tab 按 4 列算，与常见编辑器默认一致）。 */
function indentOf(line: string): number {
  let width = 0
  for (let at = 0; at < line.length; at += 1) {
    const character = line[at]
    if (character === ' ') width += 1
    else if (character === '\t') width += 4
    else break
  }
  return width
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 出现在「名字 + (`」位置但绝不是函数声明的关键字。 */
const NOT_CALLABLE = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'else', 'do', 'try', 'case', 'throw',
  'delete', 'sizeof', 'typeof', 'await', 'yield', 'goto', 'assert', 'using', 'import', 'package',
  'typedef', 'namespace', 'define', 'include', 'ifdef', 'ifndef', 'endif', 'pragma', 'undef',
  'class', 'struct', 'enum', 'interface', 'func', 'fn', 'def', 'type', 'let', 'const', 'var',
  'public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized', 'native',
  'transient', 'volatile', 'default', 'readonly', 'override', 'declare', 'export', 'async',
])

/** 这些容器直接成员算「方法」；其余（模块、命名空间…）里的可调用成员算「函数」。 */
const METHOD_OWNERS = new Set<OutlineKind>([
  'class', 'interface', 'struct', 'trait', 'impl', 'enum',
])

/**
 * 会打开一个「成员作用域」的条目。
 *
 * 只有类型/命名空间进栈：函数体不是文件结构，把方法也压栈会让 2k 行 Java 文件
 * 里的每个局部变量都变成一条「字段」（审计样本里就是这个问题）。
 */
const BLOCK_KINDS = new Set<OutlineKind>([
  'class', 'interface', 'struct', 'enum', 'trait', 'impl', 'namespace', 'module',
])

interface RawSymbol {
  name: string
  kind: OutlineKind
  line: number
  depth: number
  container?: string
}

interface OpenContainer {
  name: string
  kind: OutlineKind
  /** 这个容器**直接成员**所在的大括号深度。 */
  bodyDepth: number
}

interface Match {
  name: string
  kind: OutlineKind
}

// ------------------------------------------------------------- C 家族（大括号）

/**
 * Java/C/C++/Go/Rust/JS/TS 共用的扫描骨架。
 *
 * 只收「顶层」与「类型体的直接成员」：函数体里的局部声明（`int x = 1;`）全都
 * 在更深的大括号层级，被 `direct` 判定挡掉 —— 否则 2k 行的 Java 文件会列出一万
 * 条局部变量，大纲就没法用了。
 */
function scanBraceLanguages(
  text: string,
  language: Exclude<OutlineLanguage, 'python' | 'unknown'>,
): RawSymbol[] {
  const lines = maskSource(text, language)
  const found: RawSymbol[] = []
  const containers: OpenContainer[] = []
  let depth = 0
  let continuationParens = 0
  /** A type declaration whose `{` is on the next line (Allman style). */
  let pendingContainer: (OpenContainer & { at: number }) | undefined
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    const trimmed = line.trim()
    if (trimmed === '') continue
    const startDepth = depth
    const owner = containers.length === 0 ? undefined : containers[containers.length - 1]
    // 预处理行（`#include` / `#[derive]`）不是声明；同时避免 `#define F(x)` 被
    // 当成函数。JS/TS 的 `#private` 字段不是指令，不能整行跳过。
    const directiveLine = trimmed.startsWith('#') && language !== 'javascript' && language !== 'typescript'
    // 预处理行也不参与大括号计数：`#define BEGIN {` 的 `{` 不是作用域，记进去会
    // 让后面每一行都深一层（C 代码里很常见）。
    if (directiveLine) continue
    // Allman style: `class Foo` followed by `{` on its own line. Hold the
    // declaration until that brace arrives instead of silently losing every
    // member of the type.
    if (pendingContainer !== undefined) {
      if (trimmed.startsWith('{')) {
        const bodyDepth = depthAfter(line, startDepth)
        containers.push({
          name: pendingContainer.name,
          kind: pendingContainer.kind,
          bodyDepth: Math.max(startDepth + 1, bodyDepth),
        })
        depth = Math.max(0, bodyDepth)
        pendingContainer = undefined
        continue
      }
      pendingContainer = undefined
    }
    // `extern "C" {` is a transparent wrapper: its braces must not shift every
    // wrapped declaration one level down (the old behaviour made the whole
    // file outline empty). The matching close brace clamps at 0.
    if (/^extern\s*\{/.test(trimmed)) {
      depth = startDepth
      continue
    }
    // A multi-line parameter list: continuation lines such as `int a,` are
    // parameters, not fields. Suppress declaration matching until the
    // parenthesis balance returns to zero (braces still update normally).
    const continuation = continuationParens > 0
    if (!continuation) {
      const match = matchDeclaration(language, trimmed, owner)
      if (match !== undefined) {
        const lead = line.length - line.trimStart().length
        const at = depthAtIn(line, startDepth, lead)
        const direct = owner === undefined ? at === 0 : at === owner.bodyDepth
        if (direct) {
          found.push({
            name: match.name,
            kind: match.kind,
            line: index + 1,
            depth: containers.length,
            ...(owner === undefined ? {} : { container: owner.name }),
          })
          const bodyDepth = depthAfter(line, startDepth)
          if (bodyDepth > at && BLOCK_KINDS.has(match.kind)) {
            containers.push({ name: match.name, kind: match.kind, bodyDepth })
          } else if (BLOCK_KINDS.has(match.kind)) {
            pendingContainer = { name: match.name, kind: match.kind, bodyDepth: at, at }
          }
        }
      }
    }
    continuationParens = Math.max(0, continuationParens + parenDelta(line))
    // 夹到 0：不配平的文件（半截代码、被注释掉的括号）不能让深度变成负数。
    depth = Math.max(0, depthAfter(line, startDepth))
    while (containers.length > 0 && (containers[containers.length - 1] as OpenContainer).bodyDepth > depth) {
      containers.pop()
    }
  }
  return found
}

function matchDeclaration(
  language: Exclude<OutlineLanguage, 'python' | 'unknown'>,
  trimmed: string,
  owner: OpenContainer | undefined,
): Match | undefined {
  if (language === 'java') return matchJava(trimmed, owner)
  if (language === 'c' || language === 'cpp') return matchCpp(trimmed, owner)
  if (language === 'go') return matchGo(trimmed, owner)
  if (language === 'rust') return matchRust(trimmed, owner)
  return matchScript(trimmed, owner)
}

const JAVA_MODIFIERS = /^(?:(?:@[A-Za-z_$][\w$.]*(?:\([^)]*\))?|public|private|protected|static|final|abstract|synchronized|native|transient|volatile|strictfp|sealed|non-sealed)\s+)+/

function matchJava(trimmed: string, owner: OpenContainer | undefined): Match | undefined {
  const rest = trimmed.replace(JAVA_MODIFIERS, '')
  const type = /^(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/.exec(rest)
  if (type !== null) {
    return { name: type[2] as string, kind: type[1] === 'record' ? 'class' : type[1] as OutlineKind }
  }
  // 构造器：名字就是外层类型名（`public Foo(` / `Foo<T>(`）。
  if (owner !== undefined && new RegExp(`^${escapeRegExp(owner.name)}(?:\\s*<[^>]*>)?\\s*\\(`).test(rest)) {
    return { name: owner.name, kind: 'constructor' }
  }
  // 方法：`返回类型 名字(`。`new Foo(` / `return Foo(` 由关键字表挡掉。
  const method = /^(?:<[^>]+>\s*)?([A-Za-z_$][\w$.]*(?:\s*<[^>]*>)?(?:\s*\[\s*\])*)\s+([A-Za-z_$][\w$]*)\s*\(/.exec(rest)
  if (method !== null && !NOT_CALLABLE.has(method[1] as string)) {
    return { name: method[2] as string, kind: owner === undefined ? 'function' : 'method' }
  }
  // 字段：`类型 名字 = / ; / ,`。名字后面跟 `(` 的是方法，上面已经处理。
  const field = /^([A-Za-z_$][\w$.]*(?:\s*<[^>]*>)?(?:\s*\[\s*\])*)\s+([A-Za-z_$][\w$]*)\s*(?:=|;|,)/.exec(rest)
  if (field !== null && owner !== undefined && !NOT_CALLABLE.has(field[1] as string)) {
    return { name: field[2] as string, kind: 'field' }
  }
  return undefined
}

const CPP_SPECIFIERS = /^(?:inline|static|extern|constexpr|consteval|constinit|virtual|explicit|friend|const|volatile|unsigned|signed|register|thread_local|struct|class|enum|typename)\s+/

function matchCpp(trimmed: string, owner: OpenContainer | undefined): Match | undefined {
  // `template<...>` 前缀不是声明本身；`extern "C" {` 同理只是包装。
  const head = trimmed.replace(/^template\s*<[^>]*>\s*/, '').replace(/^typedef\s+/, '')
  // 类型声明必须先在「去掉说明符」之前匹配：`struct` 既是说明符也是声明关键字，
  // 先剥说明符会把 `struct Point {` 剥成 `Point {`，整个结构体就没了。
  const type = /^(struct|union|enum|class)\s+(?:class\s+|struct\s+)?([A-Za-z_]\w*)/.exec(head)
  if (type !== null) {
    const keyword = type[1] as string
    const kind: OutlineKind = keyword === 'enum' ? 'enum' : keyword === 'class' ? 'class' : 'struct'
    return { name: type[2] as string, kind }
  }
  const namespace = /^(?:inline\s+)?namespace\s+([A-Za-z_]\w*)/.exec(head)
  if (namespace !== null) return { name: namespace[1] as string, kind: 'namespace' }
  let rest = head
  rest = rest.replace(/^extern\s*$/, '')
  for (let guard = 0; guard < 8; guard += 1) {
    const next = rest.replace(CPP_SPECIFIERS, '')
    if (next === rest) break
    rest = next
  }
  // 类体内的构造/析构：`Widget(` / `Widget() : x_(0)` / `~Widget()` 没有返回类型，
  // 通用的「类型 名字(」模式匹配不到；只认名字等于类名或以 `~` 开头，避免把宏调用
  // （`SOME_MACRO(x)`）当成构造器。
  if (owner !== undefined && METHOD_OWNERS.has(owner.kind)) {
    const bare = /^(~?[A-Za-z_]\w*)\s*\(/.exec(rest)
    if (bare !== null) {
      const name = bare[1] as string
      if ((name === owner.name || name.startsWith('~')) && !NOT_CALLABLE.has(name)) {
        return { name, kind: 'constructor' }
      }
    }
  }
  // `typedef struct {...} Name;` 的名字在收尾行上，这里只处理带名字的直接声明。
  const callable = /^([A-Za-z_][\w:<>,\s*&]*?)\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*|~[A-Za-z_]\w*)\s*\(/.exec(rest)
  if (callable !== null
    && !NOT_CALLABLE.has((callable[1] as string).trim())
    && !NOT_CALLABLE.has(callable[2] as string)) {
    const name = callable[2] as string
    return {
      name,
      // 类外定义的成员函数（`Widget::draw`）也是方法：限定名本身就是类名。
      kind: (owner !== undefined && METHOD_OWNERS.has(owner.kind)) || name.includes('::')
        ? 'method'
        : 'function',
    }
  }
  // 成员/全局变量：`类型 [*&]名字 [数组] (;|=)`。
  const variable = /^([A-Za-z_][\w:<>,\s*&]*?)\s+[*&]*([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*(?:=|;)/.exec(rest)
  if (variable !== null && !NOT_CALLABLE.has(variable[1] as string)) {
    return { name: variable[2] as string, kind: owner === undefined ? 'variable' : 'field' }
  }
  return undefined
}

function matchGo(trimmed: string, owner: OpenContainer | undefined): Match | undefined {
  const callable = /^func\s+(?:\(\s*[A-Za-z_]\w*\s+\*?\s*([A-Za-z_]\w*)\s*\)\s*)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(/.exec(trimmed)
  if (callable !== null) {
    return { name: callable[2] as string, kind: callable[1] === undefined ? 'function' : 'method' }
  }
  const type = /^type\s+([A-Za-z_]\w*)\s+(struct|interface|func|map|chan|\[|\*|[A-Za-z_])/.exec(trimmed)
  if (type !== null) {
    const keyword = type[2] as string
    const kind: OutlineKind = keyword === 'struct' ? 'struct' : keyword === 'interface' ? 'interface' : 'type'
    return { name: type[1] as string, kind }
  }
  if (owner !== undefined && (owner.kind === 'struct' || owner.kind === 'interface')) {
    // 接口里的方法声明没有 `func` 关键字：`Read(p []byte) (int, error)`。方法体
    // 没有 `{`（接口方法不带实现），所以行内出现 `(` 就是签名。
    if (owner.kind === 'interface') {
      const signature = /^([A-Za-z_]\w*)\s*\(/.exec(trimmed)
      if (signature !== null && !NOT_CALLABLE.has(signature[1] as string)) {
        return { name: signature[1] as string, kind: 'method' }
      }
    }
    // `Name Type` / `A, B Type`。嵌入字段没有名字，不列。
    const field = /^([A-Za-z_]\w*)(?:\s*,\s*[A-Za-z_]\w*)*\s+[*\[]?[\w.\[\]*]+$/.exec(trimmed)
    if (field !== null && !NOT_CALLABLE.has(field[1] as string)) {
      return { name: field[1] as string, kind: 'field' }
    }
  }
  return undefined
}

function matchRust(trimmed: string, owner: OpenContainer | undefined): Match | undefined {
  const callable = /^(?:pub(?:\s*\([^)]*\))?\s+)?(?:(?:async|unsafe|const|extern|default)\s+)*fn\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)/.exec(trimmed)
  if (callable !== null) {
    return {
      name: callable[1] as string,
      kind: owner !== undefined && METHOD_OWNERS.has(owner.kind) ? 'method' : 'function',
    }
  }
  const impl = /^(?:pub(?:\s*\([^)]*\))?\s+)?(?:unsafe\s+)?(?:default\s+)?impl(?:\s*<[^>]*>)?\s+(?:[\w:<>, ]+?\s+for\s+)?([A-Za-z_]\w*)/.exec(trimmed)
  if (impl !== null) return { name: impl[1] as string, kind: 'impl' }
  const type = /^(?:pub(?:\s*\([^)]*\))?\s+)?(struct|enum|trait|union)\s+([A-Za-z_]\w*)/.exec(trimmed)
  if (type !== null) {
    const keyword = type[1] as string
    const kind: OutlineKind = keyword === 'trait' ? 'trait' : keyword === 'enum' ? 'enum' : 'struct'
    return { name: type[2] as string, kind }
  }
  const module = /^(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/.exec(trimmed)
  if (module !== null) return { name: module[1] as string, kind: 'module' }
  const alias = /^(?:pub(?:\s*\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/.exec(trimmed)
  if (alias !== null) return { name: alias[1] as string, kind: 'type' }
  const constant = /^(?:pub(?:\s*\([^)]*\))?\s+)?(?:const|static)\s+(?:mut\s+)?([A-Za-z_]\w*)/.exec(trimmed)
  if (constant !== null) {
    return { name: constant[1] as string, kind: owner === undefined ? 'variable' : 'field' }
  }
  const macro = /^macro_rules!\s*([A-Za-z_]\w*)/.exec(trimmed)
  if (macro !== null) return { name: macro[1] as string, kind: 'macro' }
  if (owner !== undefined && (owner.kind === 'struct' || owner.kind === 'trait' || owner.kind === 'enum')) {
    const field = /^(?:pub(?:\s*\([^)]*\))?\s+)?([A-Za-z_]\w*)\s*:\s*\S/.exec(trimmed)
    if (field !== null && !NOT_CALLABLE.has(field[1] as string)) {
      return { name: field[1] as string, kind: 'field' }
    }
  }
  return undefined
}

const SCRIPT_KEYWORDS = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?/
const SCRIPT_METHOD_MODIFIERS = /^(?:(?:@[A-Za-z_$][\w$.]*(?:\([^)]*\))?|public|private|protected|static|readonly|async|get|set|override|abstract|declare|accessor)\s+)+/

function matchScript(trimmed: string, owner: OpenContainer | undefined): Match | undefined {
  const rest = trimmed.replace(SCRIPT_KEYWORDS, '')
  const type = /^(?:abstract\s+)?(class|interface|enum|namespace|module)\s+([A-Za-z_$][\w$]*)/.exec(rest)
  if (type !== null) {
    return { name: type[2] as string, kind: type[1] as OutlineKind }
  }
  const alias = /^type\s+([A-Za-z_$][\w$]*)\s*[=<]/.exec(rest)
  if (alias !== null) return { name: alias[1] as string, kind: 'type' }
  const named = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(rest)
  if (named !== null) {
    return {
      name: named[1] as string,
      kind: owner !== undefined && METHOD_OWNERS.has(owner.kind) ? 'method' : 'function',
    }
  }
  const declaration = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*([\s\S]*)$/.exec(rest)
  if (declaration !== null) {
    const value = declaration[2] as string
    const callable = /^(?:async\s+)?(?:function\b|\([^()]*\)\s*(?::[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>)/.test(value)
    return { name: declaration[1] as string, kind: callable ? 'function' : 'variable' }
  }
  if (owner !== undefined && METHOD_OWNERS.has(owner.kind)) {
    const member = rest.replace(SCRIPT_METHOD_MODIFIERS, '')
    // 成员方法/接口签名的形状：`name(...)` 之后跟可选的 `: 返回类型`，再跟 `{`
    // （类里的实现）或 `;`（interface/abstract 的签名）。类体里的调用或字段初始化
    // 器（`x = foo(...)`）两者都不满足，所以不会被当成方法。
    const method = /^#?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;{]*\)\s*(?::[^{;]*)?[;{]/.exec(member)
    if (method !== null && !NOT_CALLABLE.has(method[1] as string)) {
      const name = method[1] as string
      if (name === 'constructor' || name === owner.name) return { name, kind: 'constructor' }
      return { name, kind: 'method' }
    }
    const field = /^#?([A-Za-z_$][\w$]*)\s*(?:[?!])?\s*[:=]/.exec(member)
    if (field !== null && !NOT_CALLABLE.has(field[1] as string)) {
      return { name: field[1] as string, kind: 'field' }
    }
  }
  return undefined
}

// ------------------------------------------------------- Python（缩进 + 关键字）

const PYTHON_KEYWORDS = new Set([
  'if', 'elif', 'else', 'for', 'while', 'return', 'yield', 'with', 'try', 'except', 'finally',
  'import', 'from', 'assert', 'del', 'raise', 'global', 'nonlocal', 'lambda', 'and', 'or', 'not',
  'print', 'pass', 'break', 'continue', 'def', 'class', 'async', 'await', 'in', 'is', 'as', 'match',
])

/**
 * Python 大纲：`class` / `def` / 模块与类体里的赋值。
 *
 * 缩进就是结构：`def`/`class` 压栈，缩进回退就出栈。函数体里的局部变量**不列**
 * （那是噪音，不是文件结构），所以只有「模块级」和「类体直接成员」进入结果。
 */
function scanPython(text: string): RawSymbol[] {
  const lines = maskSource(text, 'python')
  const found: RawSymbol[] = []
  const containers: { indent: number; name: string; kind: OutlineKind }[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    const trimmed = line.trim()
    if (trimmed === '') continue
    const indent = indentOf(line)
    while (containers.length > 0 && (containers[containers.length - 1] as { indent: number }).indent >= indent) {
      containers.pop()
    }
    const owner = containers.length > 0 ? containers[containers.length - 1] : undefined
    const direct = owner === undefined || owner.kind === 'class'
    if (direct) {
      const classDecl = /^class\s+([A-Za-z_]\w*)/.exec(trimmed)
      const def = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(trimmed)
      const assignment = /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/.exec(trimmed)
      if (classDecl !== null) {
        found.push({
          name: classDecl[1] as string,
          kind: 'class',
          line: index + 1,
          depth: containers.length,
          ...(owner === undefined ? {} : { container: owner.name }),
        })
        containers.push({ indent, name: classDecl[1] as string, kind: 'class' })
        continue
      }
      if (def !== null) {
        const kind: OutlineKind = owner !== undefined && owner.kind === 'class' ? 'method' : 'function'
        found.push({
          name: def[1] as string,
          kind,
          line: index + 1,
          depth: containers.length,
          ...(owner === undefined ? {} : { container: owner.name }),
        })
        // 函数也压栈，这样函数体里的行缩进更深却被 `direct` 挡掉；同时保证
        // 退出函数后类的成员还能正确挂回类上。
        containers.push({ indent, name: def[1] as string, kind: 'function' })
        continue
      }
      if (assignment !== null && !PYTHON_KEYWORDS.has(assignment[1] as string)) {
        found.push({
          name: assignment[1] as string,
          kind: owner === undefined ? 'variable' : 'field',
          line: index + 1,
          depth: containers.length,
          ...(owner === undefined ? {} : { container: owner.name }),
        })
      }
    }
  }
  return found
}

// -------------------------------------------------- 未知语言（缩进 + 关键字猜测）

const GUESS_TYPE_KEYWORDS = /^(?:export\s+|public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|pub\s+|async\s+|default\s+)*(class|interface|struct|enum|trait|impl|namespace|module)\s+([A-Za-z_$][\w$]*)/

/** 未知语言：关键字 + 缩进，结果一律标记为「猜的」。 */
function scanGuessed(text: string): RawSymbol[] {
  const lines = maskSource(text, 'unknown')
  const found: RawSymbol[] = []
  const containers: { indent: number; name: string; kind: OutlineKind }[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = indentOf(line)
    while (containers.length > 0 && (containers[containers.length - 1] as { indent: number }).indent >= indent) {
      containers.pop()
    }
    const owner = containers.length > 0 ? containers[containers.length - 1] : undefined
    const push = (name: string, kind: OutlineKind): void => {
      found.push({
        name,
        kind,
        line: index + 1,
        depth: containers.length,
        ...(owner === undefined ? {} : { container: owner.name }),
      })
      containers.push({ indent, name, kind })
    }
    const type = GUESS_TYPE_KEYWORDS.exec(trimmed)
    if (type !== null) {
      const keyword = type[1] as string
      const kind: OutlineKind = keyword === 'class' ? 'class'
        : keyword === 'interface' ? 'interface'
          : keyword === 'struct' ? 'struct'
            : keyword === 'enum' ? 'enum'
              : keyword === 'trait' ? 'trait'
                : keyword === 'impl' ? 'impl'
                  : keyword === 'namespace' ? 'namespace' : 'module'
      push(type[2] as string, kind)
      continue
    }
    const callable = /^(?:export\s+|pub\s+|async\s+|static\s+|public\s+|private\s+)*(?:def|func|function|fn|sub|proc|method)\s+([A-Za-z_$][\w$]*)/.exec(trimmed)
    if (callable !== null) {
      push(callable[1] as string, owner !== undefined && METHOD_OWNERS.has(owner.kind) ? 'method' : 'function')
      continue
    }
    // shell 的 `name() {` 之类：关键字表抓不到，靠形状猜（结果本来就标着「猜的」）。
    const shaped = /^([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*(?::[^{]*)?\{/.exec(trimmed)
    if (shaped !== null && !NOT_CALLABLE.has(shaped[1] as string)) {
      push(shaped[1] as string, owner !== undefined && METHOD_OWNERS.has(owner.kind) ? 'method' : 'function')
      continue
    }
    const assignment = /^([A-Za-z_][\w$]*)\s*[:=](?!=)/.exec(trimmed)
    if (assignment !== null && !NOT_CALLABLE.has(assignment[1] as string)) {
      found.push({
        name: assignment[1] as string,
        kind: owner === undefined ? 'variable' : 'field',
        line: index + 1,
        depth: containers.length,
        ...(owner === undefined ? {} : { container: owner.name }),
      })
    }
  }
  return found
}

// ---------------------------------------------------------------------- 入口

function finish(language: OutlineLanguage, raw: RawSymbol[], guessed: boolean): OutlineResult {
  const total = raw.length
  const entries: OutlineEntry[] = raw.slice(0, OUTLINE_MAX_ENTRIES)
  return {
    language,
    entries,
    total,
    truncated: total > entries.length,
    guessed,
  }
}

/**
 * 从源文本生成大纲。
 *
 * `text` 必须是**实时缓冲区**（dirty 时不是 `tab.text`）；行号 1-based 直接对应
 * `CodeEditorHandle.revealRange`。
 */
export function buildOutline(text: string, path: string): OutlineResult {
  const language = outlineLanguageOf(path)
  if (language === 'python') return finish(language, scanPython(text), false)
  if (language === 'unknown') return finish(language, scanGuessed(text), true)
  const raw = scanBraceLanguages(text, language)
  // A known brace language that produced nothing while the file clearly has
  // structure (an unbalanced/lone brace from `extern "C" {`, a disabled block,
  // or a string form the masker does not understand) must not claim "no
  // symbols". Fall back to the indentation heuristic and say it is guessed.
  if (raw.length === 0 && /[{}]/.test(text)) return finish(language, scanGuessed(text), true)
  return finish(language, raw, false)
}

/**
 * 按查询过滤并排序符号。
 *
 * 空查询 = 源码顺序（大纲的默认视图）；有查询时复用 quick open 的 `fuzzyScore`
 * 打分，同分按行号升序 —— 排序必须确定，否则两次相同的输入会闪出两种顺序。
 * 名字不匹配但 `容器.名字` 匹配（用户常敲 `Foo.bar`）时也算命中。
 */
export function rankOutline(
  query: string,
  entries: readonly OutlineEntry[],
  limit: number,
): { hits: OutlineEntry[]; truncated: boolean } {
  const cap = Math.max(0, Math.floor(limit))
  const needle = query.trim()
  if (needle === '') return { hits: entries.slice(0, cap), truncated: entries.length > cap }
  const scored: { entry: OutlineEntry; score: number }[] = []
  for (const entry of entries) {
    const own = fuzzyScore(needle, entry.name)
    const score = own ?? (entry.container === undefined ? undefined : fuzzyScore(needle, `${entry.container}.${entry.name}`))
    if (score !== undefined) scored.push({ entry, score })
  }
  scored.sort((left, right) => (right.score - left.score) || (left.entry.line - right.entry.line))
  return { hits: scored.slice(0, cap).map(item => item.entry), truncated: scored.length > cap }
}
