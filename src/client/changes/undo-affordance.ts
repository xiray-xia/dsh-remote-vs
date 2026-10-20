/**
 * 「把鼠标停在这一行上，撤销这处改动」。
 *
 * 为什么不用 `hoverTooltip`：它把浮层挂进 CodeMirror 自己的 `.cm-tooltip` 层，位置
 * 由文本坐标算，形态只有"命中点正上方/正下方"两档。这对文字注释刚好，对一个**要点的
 * 按钮**有两个毛病：
 * 1. 落不到行的**右侧** —— 我们要按钮贴着行尾，不能盖住正在看的改动行；
 * 2. 浮层仍在编辑器的 DOM 树里，宿主容器（`.rvs-editor-host`）一旦 `overflow: hidden`
 *    就会被裁掉半截。
 * 所以这里用等价机制：一个 ViewPlugin 只负责"命中判定 + 悬停计时"，按钮则是
 * `position: fixed` 挂到 `document.body` 上去的元素 —— 与「添加到对话」那个浮层
 * （`selection-popup.ts` / `CodeEditor` 里的 portal）是同一种形态，天然不受任何
 * 滚动、`overflow`、`transform` 祖先影响。
 *
 * 命中规则与 CodeMirror 的装饰无关，只读 `changeSetOf(state).marks`（1-based 闭区间）：
 * **只有真的落在某个 mark 里才弹**。刻意不用 `changeBlockAt` —— 它带单行兜底，任何
 * 一行都会返回一个区间，那样悬浮在任何地方都会冒出撤销按钮。
 *
 * 本模块只回答"用户点了哪一处改动"：`onUndo(mark)` 收到的是 `marks` 里的那个对象，
 * 其中 `hunk` 是 `ChangeSet.patches` 的下标。真正的撤销（远端 `git apply -R`）由
 * 调用方完成，按钮文案也由调用方的 i18n 决定（扩展不写死文案，只把 `kind` 交出去，
 * 删除锚点因此可以有自己的说法）。
 */
import type { EditorState, Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type Rect, type ViewUpdate } from '@codemirror/view'
import { changeSetOf, type ChangeMark } from '../vsc/change-marks.ts'

/** 按钮的 class（样式在 `vsc/vsc.css` 的 `session changes` 一节）。 */
const BUTTON_CLASS = 'rvs-undo-affordance'

/**
 * 悬停多久后弹出（毫秒）。
 *
 * 250–400ms 是"看得出是悬停、又不至于让人以为坏了"的区间：太短会在鼠标划过改动行时
 * 闪一下，太长会让想撤销的人以为这行没有按钮。
 */
const DEFAULT_HOVER_MS = 300

/**
 * 指针离开编辑器内容后，按钮还留多久（毫秒）。
 *
 * 只为跨越"行尾 → 按钮"之间那段空隙：空隙只有几个像素，150ms 足够走过去，又不至于
 * 让一个已经离开的按钮在屏幕上赖着。
 */
const LEAVE_GRACE_MS = 150

/** 默认按钮文案。真实调用方（`CodeEditor`）总会传自己 i18n 的那一条。 */
export const DEFAULT_UNDO_LABEL = '撤销这处改动'

export interface UndoAffordanceOptions {
  /**
   * 点了按钮：`mark` 就是 `ChangeSet.marks` 里的那个对象（`hunk` = `patches` 下标）。
   * 不给时整块扩展不安装（`[]`），行为与没有这个功能时完全一致。
   */
  onUndo?: (mark: ChangeMark) => void
  /**
   * 按钮文案。默认只是兜底：真实调用方按 `kind` 给出自己的（i18n）说法，
   * 例如删除锚点说「撤销这处删除」。
   */
  label?: (mark: ChangeMark) => string
  /** 悬停延迟，缺省 300ms。 */
  hoverTime?: number
}

/** 指针底下那一行命中的改动（1-based 行号 + `marks` 里的原对象）。 */
interface Hovered {
  mark: ChangeMark
  line: number
  /** 悬停的 `.cm-line` 元素，位置测量在拿不到文本坐标时的退路。 */
  element: Element | null
}

/**
 * 这一行落在哪一处改动里。
 *
 * `line` 与 mark 的 `[from, to]` 都是 1-based、闭区间（见 `change-marks.ts`）。同一行
 * 可能被多个 mark 盖住（"这里删两行、又补三行"时删除锚点就紧挨着新增块），有真实存在
 * 的行时优先给那块：删除锚点标的是"已经不在的内容"，它不该抢走这一行的按钮。
 */
function markAtLine(state: EditorState, line: number): ChangeMark | undefined {
  const set = changeSetOf(state)
  if (set === null) return undefined
  let anchor: ChangeMark | undefined
  for (const mark of set.marks) {
    if (line < mark.from || line > mark.to) continue
    if (mark.kind !== 'del') return mark
    anchor ??= mark
  }
  return anchor
}

/** 指针所在的 `.cm-line`（不属于编辑器内容时为 null）。 */
function lineElementAt(view: EditorView, event: MouseEvent): Element | null {
  const node = event.target instanceof Node ? event.target : null
  if (node === null || !view.contentDOM.contains(node)) return null
  const element = node instanceof Element ? node : node.parentElement
  return element?.closest('.cm-line') ?? null
}

/**
 * 指针在文档里的第几行（1-based），拿不到时 null。
 *
 * 先走 DOM（`event.target` → `.cm-line` → `posAtDOM`），再退到文本坐标：行是块元素，
 * 鼠标停在行内任何位置（包括该行文字右侧的空白）拿到的都是那一行的元素，这比用
 * `posAtCoords` 换算更直接；而在没有布局信息的环境里（自检的 jsdom）坐标换算是不可靠
 * 的那一半，DOM 这一半仍然准确。
 */
function lineUnderPointer(view: EditorView, event: MouseEvent): number | null {
  const element = lineElementAt(view, event)
  if (element !== null) {
    try {
      return view.state.doc.lineAt(view.posAtDOM(element, 0)).number
    } catch {
      // 落到文本坐标那条路上。
    }
  }
  try {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
    return pos === null ? null : view.state.doc.lineAt(pos).number
  } catch {
    return null
  }
}

/** 一件撤销浮层的实例状态：按钮、悬停计时、当前命中的那一处改动。 */
class UndoAffordanceView {
  /**
   * 自检用来认出"这个插件装上了没有"。
   *
   * `ViewPlugin.define` 每次都会生成一个新的插件标识，测试里拿不到它去 `view.plugin()`
   * 查询，只能翻 `view.plugins`（里面装的是 CodeMirror 的 `PluginInstance` 包装，插件值
   * 在 `.value` 上），所以留一个可辨认的字段。
   */
  readonly rvsUndoAffordance = true

  private readonly view: EditorView
  private readonly onUndo: (mark: ChangeMark) => void
  private readonly label: (mark: ChangeMark) => string
  private readonly hoverTime: number
  private button: HTMLButtonElement | undefined
  private timer: number | undefined
  /**
   * 「指针已经离开了」的宽限计时。
   *
   * 按钮挂在行尾右侧、位于编辑器内容之外，鼠标从那一行移到按钮上必然先离开
   * `contentDOM` —— 若 `mouseleave` 立刻收，用户永远点不到。所以离开后等一小会儿，
   * 指针真的进了按钮就撤销这次收起。
   */
  private leaveTimer: number | undefined
  /** 指针当前停在的改动（可能还在等计时）。 */
  private hovered: Hovered | undefined
  /** 正在屏幕上显示的那一处改动。 */
  private shown: Hovered | undefined

  /**
   * 收起用的全局监听：任何时候按下鼠标（按钮自己除外）、按 Escape、页面切到后台、
   * 窗口失焦，都把按钮收掉。一次注册、常在的写法与 `useSelectionPopup` 一致 ——
   * 浮层活不过它所属的编辑器表面，宁可多收一次，也不能留一个指向旧行的按钮。
   */
  private readonly onGlobalMouseDown = (event: MouseEvent): void => {
    if (this.shown === undefined) return
    const button = this.button
    const target = event.target instanceof Node ? event.target : null
    if (button !== undefined && target !== null && button.contains(target)) return
    this.reset()
  }

  private readonly onGlobalKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || this.shown === undefined) return
    this.reset()
  }

  private readonly onWindowBlur = (): void => this.reset()

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.reset()
  }

  constructor(view: EditorView, options: UndoAffordanceOptions) {
    this.view = view
    this.onUndo = options.onUndo ?? (() => {})
    this.label = options.label ?? (() => DEFAULT_UNDO_LABEL)
    this.hoverTime = options.hoverTime ?? DEFAULT_HOVER_MS
    document.addEventListener('mousedown', this.onGlobalMouseDown, true)
    document.addEventListener('keydown', this.onGlobalKeyDown, true)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    window.addEventListener('blur', this.onWindowBlur)
  }

  /** 鼠标在编辑器内容里移动：命中一处改动就（重新）开始悬停计时。 */
  handleMove(event: MouseEvent): void {
    this.cancelLeave()
    // 拖着选区走过改动行不算悬停：那时用户在做选择，不该冒出按钮抢点击。
    if (event.buttons !== 0) {
      this.reset()
      return
    }
    const line = lineUnderPointer(this.view, event)
    const mark = line === null ? undefined : markAtLine(this.view.state, line)
    if (line === null || mark === undefined) {
      this.reset()
      return
    }
    const current = this.hovered
    // 同一个改动点：计时已经开始（或按钮已经弹出），不重来 —— 否则手一抖就得再等一遍。
    if (current !== undefined && current.line === line && current.mark === mark) return
    // 换了一处（或从别处移过来）：旧按钮立刻收，旧计时作废。
    this.reset()
    this.hovered = { mark, line, element: lineElementAt(this.view, event) }
    this.timer = window.setTimeout(() => { this.arm() }, this.hoverTime)
  }

  /** 指针离开编辑器内容（可能正走向按钮，见 `leaveTimer`）。 */
  handleLeave(): void {
    if (this.shown === undefined) {
      // 还没弹出来就走了：计时直接作废，不用等宽限。
      this.reset()
      return
    }
    this.scheduleLeave()
  }

  /**
   * 悬停计时到点：再确认一次命中才真的弹。
   *
   * 这段时间里数据可能被换掉（重新统计）、文档可能被改过（标记整份作废），那时行号
   * 已经不代表原来那一处改动了 —— 弹出来就是骗人。
   */
  private arm(): void {
    this.timer = undefined
    const hover = this.hovered
    if (hover === undefined) return
    if (markAtLine(this.view.state, hover.line) !== hover.mark) {
      this.reset()
      return
    }
    this.shown = hover
    this.show(hover)
  }

  /** 建按钮（一个实例一个，复用）。点下去只做一件事：把命中的 mark 交出去。 */
  private ensureButton(): HTMLButtonElement {
    const existing = this.button
    if (existing !== undefined) return existing
    const button = document.createElement('button')
    button.type = 'button'
    button.className = BUTTON_CLASS
    // 行内再写一遍固定定位：样式表缺席（自检、被别处的样式覆盖）时按钮仍然不会被
    // 任何滚动/裁剪祖先吃掉。
    button.style.position = 'fixed'
    button.style.zIndex = '2100'
    // 按下时不抢焦点、不打断编辑器里的选区：与旁边那个「添加到对话」按钮同一套处理。
    button.addEventListener('mousedown', (event) => { event.preventDefault() })
    // 指针真的进了按钮：撤销上面那次"离开了"的收起。
    button.addEventListener('mouseenter', () => { this.cancelLeave() })
    button.addEventListener('mouseleave', () => { this.scheduleLeave() })
    button.addEventListener('click', () => {
      const shown = this.shown
      // 先收浮层再回调：回调会改远端文件、重读标签页，浮层留着就已经指向旧内容了。
      this.reset()
      if (shown !== undefined) this.onUndo(shown.mark)
    })
    this.button = button
    return button
  }

  /** 取消"指针离开"的宽限收起。 */
  private cancelLeave(): void {
    if (this.leaveTimer === undefined) return
    window.clearTimeout(this.leaveTimer)
    this.leaveTimer = undefined
  }

  /** 等一小会儿再收：指针可能是走向按钮（见 `leaveTimer`）。 */
  private scheduleLeave(): void {
    this.cancelLeave()
    this.leaveTimer = window.setTimeout(() => {
      this.leaveTimer = undefined
      this.reset()
    }, LEAVE_GRACE_MS)
  }

  /** 把按钮放到这一行的右侧（贴行尾，视口内）。 */
  private show(hover: Hovered): void {
    const button = this.ensureButton()
    const text = this.label(hover.mark)
    if (button.textContent !== text) button.textContent = text
    button.title = text
    button.setAttribute('aria-label', text)
    button.dataset.kind = hover.mark.kind
    button.dataset.hunk = String(hover.mark.hunk ?? -1)
    if (button.parentNode === null) document.body.appendChild(button)
    const rect = this.rectFor(hover)
    if (rect === null) {
      // 位置量不出来（既没有文本坐标也没有行元素）：宁可先不显示，也不要把按钮
      // 丢到屏幕左上角去。
      button.remove()
      return
    }
    const gap = 8
    const top = (rect.top + rect.bottom) / 2
    let left = rect.right + gap
    // 按钮宽度只有挂进文档才量得到；量不到（0）时按"不许超出视口右边界"处理。
    const width = button.getBoundingClientRect().width
    const limit = window.innerWidth - gap
    left = width > 0 && left + width > limit ? Math.max(gap, limit - width) : Math.min(left, limit)
    button.style.left = `${Math.round(left)}px`
    button.style.top = `${Math.round(top)}px`
  }

  /**
   * 这一行在视口里的矩形。
   *
   * 首选行尾的文本坐标（`coordsAtPos` 给的是视口坐标，正好配 `position: fixed`），
   * 拿不到时退回悬停的那个 `.cm-line` 元素的盒子。
   */
  private rectFor(hover: Hovered): Rect | null {
    const doc = this.view.state.doc
    const line = doc.line(Math.min(Math.max(1, hover.line), doc.lines))
    try {
      const coords = this.view.coordsAtPos(line.to)
      if (coords !== null && Number.isFinite(coords.top) && Number.isFinite(coords.right)) return coords
    } catch {
      // 没有布局信息（例如 jsdom）：走元素盒子。
    }
    const rect = hover.element?.getBoundingClientRect()
    if (rect === undefined) return null
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
  }

  /** 收起浮层并清掉悬停/计时状态（幂等）。 */
  private reset(): void {
    if (this.timer !== undefined) {
      window.clearTimeout(this.timer)
      this.timer = undefined
    }
    this.cancelLeave()
    this.hovered = undefined
    this.shown = undefined
    const button = this.button
    if (button !== undefined && button.parentNode !== null) button.remove()
  }

  update(update: ViewUpdate): void {
    // 滚动、尺寸变化、文档被改：按钮锚定的那一行已经不是屏幕上那行了 —— 直接收掉，
    // 等用户重新悬停。
    if (update.docChanged || update.viewportChanged || update.geometryChanged) {
      this.reset()
      return
    }
    // 换了一份改动数据（重新统计）：旧的行号与补丁都可能对不上。
    if (changeSetOf(update.startState) !== changeSetOf(update.state)) this.reset()
  }

  destroy(): void {
    this.reset()
    this.button?.remove()
    this.button = undefined
    document.removeEventListener('mousedown', this.onGlobalMouseDown, true)
    document.removeEventListener('keydown', this.onGlobalKeyDown, true)
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    window.removeEventListener('blur', this.onWindowBlur)
  }
}

/**
 * 装上「悬浮撤销」。
 *
 * 没有 `onUndo`（调用方没接这个动作）时返回空扩展：不是"装上了但点了没反应"，而是
 * 压根没有插件 —— 不留 DOM 监听、不留任何行为差异。
 */
export function undoAffordance(options: UndoAffordanceOptions = {}): Extension {
  if (options.onUndo === undefined) return []
  if (typeof document === 'undefined') return []
  return ViewPlugin.define(view => new UndoAffordanceView(view, options), {
    eventHandlers: {
      // 旁听，不消费：返回 false / undefined 让 CodeMirror 继续按它自己的方式处理
      // 鼠标事件（选词、拖拽选择都不能被这个按钮打乱）。
      mousemove(event) {
        this.handleMove(event)
        return false
      },
      mouseleave() {
        this.handleLeave()
        return false
      },
    },
  })
}
