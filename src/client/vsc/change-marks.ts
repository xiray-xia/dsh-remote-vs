/**
 * "What this session changed", painted into the file editor (Cursor style).
 *
 * 本模块只做三件事：把调用方算好的行号画成行背景、在左侧 gutter 上打三种标记、
 * 以及在文档一旦被编辑时把整份标记作废。数据全部从 `setChangeSet` 这个
 * StateEffect 进来 —— 这里不发任何请求，也不自己算 diff。
 *
 * 关键取舍（为什么编辑后是"清空"而不是"跟着映射"）：改动点的行号来自"磁盘上
 * 那一刻"的基线。`value.map(tr.changes)` 只保证装饰不崩、位置不乱序，但不保证
 * 语义还对：用户在改动点之前插入或删除几行，后面每一个改动点都整体平移，映射
 * 出来的边界不再等于真实改动边界，而且偏得越久越离谱。与其显示一份看起来仍准
 * 的假标记，不如立刻作废、让上层重新拉数据（`changeStaleField` 就是给上层的
 * 那个信号）。这与 landing 高亮（`reveal-line.ts`，一次性、2600ms 后自行熄灭）
 * 的处理方式不同，因为那里错了也无非闪一下，这里是长期驻留的视觉事实。
 *
 * 性能：装饰只用视口内的 `RangeSetBuilder` 构建（照 `fallback-highlight.ts` 的
 * 写法），所以 1 万行文件 + 500 个改动点的成本被视口钉死；gutter 标记同样是
 * 视口内构建，并且按"视口 + 当前数据"做了单条缓存，滚动时才重算。
 */
import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type RangeSet,
  type Text,
  type Transaction,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutter,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'

/** 改动点的三种形态。 */
export type ChangeKind = 'add' | 'mod' | 'del'

/**
 * 一处改动：**1-based、闭区间**的行号。
 *
 * `del` 没有真实存在的行可画，用"删除位置锚点行"表示（`from === to`）——
 * CodeMirror 的文档里不存在"被删掉的那一行"，只能画在它原本所在的位置上。
 */
export interface ChangeMark {
  from: number
  to: number
  kind: ChangeKind
  /**
   * 这块标记属于第几个 hunk（`ChangeSet.hunks` / `ChangeSet.patches` 的下标）。
   *
   * 悬浮撤销要精确到"这一处改动"，而行号会在 `spansOf` 里被裁切合并，所以归属
   * 只能由数据层在算 mark 时一起带下来。
   */
  hunk?: number
}

/** 一个文件的全部改动，由上层（会话改动数据层）算好送进来。 */
export interface ChangeSet {
  marks: ChangeMark[]
  /** 每处改动的起始行号（1-based、升序），供「上一个/下一个改动点」跳转。 */
  hunks: number[]
  /** 数据快照标识（例如 mtime + 大小）。仅用于判定"是不是同一份数据"。 */
  stamp: string
  /**
   * 与 `hunks` 一一对应的 git hunk patch（`UnifiedHunk.patch`）。
   *
   * 「撤销这处改动」把它交给 `applyHunk(alias, root, patch, 'revert')`：反向应用
   * 由 `git apply -R` 完成，上下文不匹配时它自己就会拒绝——这正是我们要的冲突
   * 护栏，比在浏览器里重算一遍替换区间可靠。
   */
  patches?: string[]
}

/** 换一份改动标记；`null` = 清空（有改动数据，但没有任何要画的东西）。 */
export const setChangeSet = StateEffect.define<ChangeSet | null>()

/** 已经规整过的行段：互不重叠、都落在文档现有的行数里。 */
interface Span {
  first: number
  last: number
  kind: ChangeKind
}

/**
 * 同一行被多个 mark 命中时的优先级。
 *
 * `del` 排在最后：删除锚点常常紧挨着一段新增/修改（"这里删了两行、又补了三行"
 * 在两个 hunk 里会重叠在锚点行上），而真实存在的行应该显示它自己的颜色，不能
 * 被一个"其实已经不在了"的锚点抢走。
 */
const KIND_PRIORITY: Record<ChangeKind, number> = { add: 0, mod: 1, del: 2 }

/** Gutter 符号与说明（三种形态靠符号 + 颜色双重区分）。 */
const GLYPH: Record<ChangeKind, string> = { add: '+', mod: '●', del: '−' }
const LABEL: Record<ChangeKind, string> = { add: '新增行', mod: '修改行', del: '删除行' }

/** 空标记集。构造一次，避免每次清空都新建一个 RangeSet。 */
const NO_MARKERS = new RangeSetBuilder<GutterMarker>().finish()

/** 行装饰：三种 kind 各一个共享实例（装饰不可变，可复用）。 */
const lineDecorationCache = new Map<ChangeKind, Decoration>()

function lineDecoration(kind: ChangeKind): Decoration {
  let decoration = lineDecorationCache.get(kind)
  if (decoration === undefined) {
    decoration = Decoration.line({ class: `rvs-change-line rvs-change-${kind}` })
    lineDecorationCache.set(kind, decoration)
  }
  return decoration
}

/**
 * 一行在 gutter 上的标记。
 *
 * `elementClass` 落到 `.cm-gutterElement` 上（CodeMirror 会把 marker 上这个
 * 字符串拼进元素 class），行背景之外再给 gutter 那一格一条色条，才像 VS Code 的
 * 改动栏。
 */
class KindMarker extends GutterMarker {
  readonly kind: ChangeKind
  readonly elementClass: string

  constructor(kind: ChangeKind) {
    super()
    this.kind = kind
    this.elementClass = `rvs-change-gutter-${kind}`
  }

  eq(other: GutterMarker): boolean {
    return other instanceof KindMarker && other.kind === this.kind
  }

  toDOM(): Node {
    const span = document.createElement('span')
    span.className = `rvs-change-mark rvs-change-mark-${this.kind}`
    span.textContent = GLYPH[this.kind]
    span.title = LABEL[this.kind]
    span.setAttribute('aria-label', LABEL[this.kind])
    return span
  }
}

/** 三种 kind 的共享实例（`eq` 让相邻同 kind 的行合并成一条 gutter 色条）。 */
const MARKERS: Record<ChangeKind, GutterMarker> = {
  add: new KindMarker('add'),
  mod: new KindMarker('mod'),
  del: new KindMarker('del'),
}

/**
 * 撑住 gutter 的基础宽度。
 *
 * 没有它，行号左侧那一栏的宽度取决于"当前视口里正好有哪个符号"，滚动到没有改动
 * 的地方时会整列跳动，行号跟着左右位移。
 */
class SpacerMarker extends GutterMarker {
  toDOM(): Node {
    const span = document.createElement('span')
    span.className = 'rvs-change-mark rvs-change-spacer'
    span.textContent = '+'
    span.setAttribute('aria-hidden', 'true')
    return span
  }
}

const SPACER = new SpacerMarker()

/** 1-based 行号夹到 `[1, maxLine]`；NaN/小数也在这里被收编。 */
function clampLine(value: number, maxLine: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(Math.max(1, Math.round(value)), maxLine)
}

/**
 * 把外面送进来的 marks 规整成"互不重叠、已夹进文档行数"的行段。
 *
 * 必须在渲染前做：`RangeSetBuilder` 要求按位置升序且不许回退，而外部数据完全
 * 可能带着重叠区间、或者比当前文档还长的行号（保存前后换了基线）来。与其在
 * builder 里抛异常把整个编辑器搞挂，不如在这里裁掉。
 */
function spansOf(set: ChangeSet | null, doc: Text): Span[] {
  if (set === null || set.marks.length === 0) return []
  const maxLine = doc.lines
  const sorted: Span[] = []
  for (const mark of set.marks) {
    const kind = mark.kind
    if (kind !== 'add' && kind !== 'mod' && kind !== 'del') continue
    const first = clampLine(mark.from, maxLine)
    const last = Math.min(Math.max(first, clampLine(mark.to, maxLine)), maxLine)
    sorted.push({ first, last, kind })
  }
  sorted.sort((a, b) => a.first - b.first || KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind])
  const spans: Span[] = []
  for (const span of sorted) {
    const previous = spans[spans.length - 1]
    const first = previous === undefined ? span.first : Math.max(span.first, previous.last + 1)
    if (first > span.last) continue
    spans.push({ first, last: span.last, kind: span.kind })
  }
  return spans
}

/** 当前行段状态：原始数据 + 规整后的行段。行段随数据一次性算好，滚动不再重算。 */
interface MarksState {
  set: ChangeSet | null
  spans: readonly Span[]
}

const EMPTY_STATE: MarksState = { set: null, spans: [] }

/**
 * 一次事务之后该显示哪份改动数据。
 *
 * 有 `setChangeSet` 效应就用它（同一次事务里既改文档又换数据时，新数据是权威）；
 * 否则只要文档变了就清空 —— 见文件头的取舍说明。
 */
function nextSet(value: ChangeSet | null, tr: Transaction): ChangeSet | null {
  for (const effect of tr.effects) {
    if (effect.is(setChangeSet)) return effect.value
  }
  return tr.docChanged ? null : value
}

/** 改动数据 + 规整后的行段。装饰与 gutter 都从这里读，状态只有一份。 */
const marksField = StateField.define<MarksState>({
  create: () => EMPTY_STATE,
  update(value, tr) {
    const next = nextSet(value.set, tr)
    if (next === value.set) return value
    if (next === null) return EMPTY_STATE
    return { set: next, spans: spansOf(next, tr.newDoc) }
  },
})

/**
 * 标记是否已经因为编辑而作废（true = 屏幕上不会再画任何改动点，上层该重新拉）。
 *
 * 独立成一个 StateField 而不是让调用方去比对 `marksField`：它要能被
 * `CodeEditor` 的 handle（`getChangeStale`）直接读，而且语义上就是"数据过期"这一
 * 个布尔事实。
 */
export const changeStaleField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setChangeSet)) return false
    }
    return tr.docChanged ? true : value
  },
})

/** 当前生效的改动数据（`null` = 没有 / 已被编辑作废）。 */
export function changeSetOf(state: EditorState): ChangeSet | null {
  return state.field(marksField, false)?.set ?? null
}

/**
 * `line`（1-based）所在的改动块，用作「跳到这个改动点」时选中的区间。
 *
 * 跳转只拿到一个起始行号（`ChangeSet.hunks`），选中整块才看得出这次改动有多大；
 * 该行不在任何 mark 里时退回单行，调用方永远拿到一个可用的区间。
 */
export function changeBlockAt(state: EditorState, line: number): { from: number; to: number } {
  const spans = state.field(marksField, false)?.spans ?? []
  const target = Math.max(1, Math.round(line))
  for (const span of spans) {
    if (target >= span.first && target <= span.last) return { from: span.first, to: span.last }
  }
  return { from: target, to: target }
}

/** 二分找到第一个"末尾不早于 line"的行段，省掉每次滚动都线性扫完 500 个 mark。 */
function firstSpanFrom(spans: readonly Span[], line: number): number {
  let low = 0
  let high = spans.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (spans[mid].last < line) low = mid + 1
    else high = mid
  }
  return low
}

/**
 * 只给视口内的行加 `Decoration.line`。
 *
 * 每次滚动都重算（`viewportChanged`），所以成本是 `O(log n + 视口行数)`：1 万行
 * 文件里 500 个改动点，在任何一屏上都只建几十个装饰。
 */
class ChangeMarkHighlighter {
  decorations: DecorationSet = Decoration.none
  private readonly view: EditorView

  constructor(view: EditorView) {
    this.view = view
    this.rebuild()
  }

  update(update: ViewUpdate): void {
    const changed = update.docChanged
      || update.viewportChanged
      || update.startState.field(marksField, false) !== update.state.field(marksField, false)
    if (changed) this.rebuild()
  }

  private rebuild(): void {
    const state = this.view.state
    const spans = state.field(marksField, false)?.spans ?? []
    if (spans.length === 0) {
      this.decorations = Decoration.none
      return
    }
    // `Decoration.line` 的装饰只能落在行首（from === to === line.from），同一行
    // 只挂一个：行段已经在 `spansOf` 里规整成互不重叠，这里不会重复添加。
    const doc = state.doc
    const builder = new RangeSetBuilder<Decoration>()
    for (const range of this.view.visibleRanges) {
      const firstLine = doc.lineAt(range.from).number
      const lastLine = doc.lineAt(range.to).number
      for (let index = firstSpanFrom(spans, firstLine); index < spans.length; index += 1) {
        const span = spans[index]
        if (span.first > lastLine) break
        const start = Math.max(span.first, firstLine)
        const end = Math.min(span.last, lastLine)
        const decoration = lineDecoration(span.kind)
        for (let number = start; number <= end; number += 1) {
          const position = doc.line(number).from
          builder.add(position, position, decoration)
        }
      }
    }
    this.decorations = builder.finish()
  }
}

/**
 * 视口内行装饰的 ViewPlugin。
 *
 * 导出是为了让自检脚本能直接读 `view.plugin(changeMarkPlugin).decorations.size`
 * —— "只装饰视口内的行"这件事在 DOM 上看不出来（CodeMirror 本来就让 DOM 只保留
 * 可见行），只有读这份 RangeSet 的条数才有判别力。
 */
export const changeMarkPlugin = ViewPlugin.fromClass(ChangeMarkHighlighter, {
  decorations: value => value.decorations,
})

/**
 * 视口内的 gutter 标记，带一条缓存。
 *
 * gutter 的 `markers` 回调在**每一次**视图更新都会跑（选中、滚动、输入都算），
 * 而且它比较的是"视口内那一段"的 RangeSet。所以这里按"数据 + 视口"做单条缓存：
 * 没有新数据、没滚动时直接返回已有结果，滚动时只重建视口那几十行。
 */
let gutterCache: { state: MarksState; from: number; to: number; markers: RangeSet<GutterMarker> } | undefined

function viewportMarkers(view: EditorView): RangeSet<GutterMarker> {
  const marks = view.state.field(marksField, false) ?? EMPTY_STATE
  const from = view.viewport.from
  const to = view.viewport.to
  const cached = gutterCache
  if (cached !== undefined && cached.state === marks && cached.from === from && cached.to === to) {
    return cached.markers
  }
  let markers = NO_MARKERS
  if (marks.spans.length > 0) {
    const doc = view.state.doc
    const firstLine = doc.lineAt(from).number
    const lastLine = doc.lineAt(to).number
    const builder = new RangeSetBuilder<GutterMarker>()
    for (let index = firstSpanFrom(marks.spans, firstLine); index < marks.spans.length; index += 1) {
      const span = marks.spans[index]
      if (span.first > lastLine) break
      const start = Math.max(span.first, firstLine)
      const end = Math.min(span.last, lastLine)
      const marker = MARKERS[span.kind]
      // 每一行必须是**独立**的标记区间：gutter 只在 `marker.from === line.from`
      // 时才把该标记放进这一行（view 的 `advanceCursor`），一个跨多行的区间只会
      // 出现在第一行上。
      for (let number = start; number <= end; number += 1) {
        const line = doc.line(number)
        builder.add(line.from, line.to, marker)
      }
    }
    markers = builder.finish()
  }
  gutterCache = { state: marks, from, to, markers }
  return markers
}

/**
 * 编辑器侧的完整扩展：数据字段 + 作废标记 + 左侧 gutter + 行背景。
 *
 * `CodeEditor` 只在调用方真的传了 `changeSet` 时把它装进编辑器（Compartment），
 * 没传时不装 —— 这样"没有会话改动"的文件连一条 gutter 都不会多出来。
 */
export const changeMarksExtension: Extension = [
  marksField,
  changeStaleField,
  gutter({
    class: 'rvs-change-gutter',
    markers: view => viewportMarkers(view),
    initialSpacer: () => SPACER,
    lineMarkerChange: update => update.startState.field(marksField, false) !== update.state.field(marksField, false),
  }),
  changeMarkPlugin,
]
