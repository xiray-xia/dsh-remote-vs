/**
 * 「把鼠标停在这一行上，对这里的改动做事」：一枚贴行的 `⋯` 按钮 + 它展开的小菜单。
 *
 * 为什么不直接用 `hoverTooltip`：它把浮层挂进 CodeMirror 自己的 `.cm-tooltip` 层，位置
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
 * 一行都会返回一个区间，那样悬浮在任何地方都会冒出按钮。
 *
 * ## 为什么是"一枚按钮 + 菜单"，而不是并排两枚按钮
 *
 * 动作有两个（撤销这处改动 / 确认保留），一开始做成并排两枚，但行尾放不下时只能把
 * 整组挪走 —— 挪到被悬停行的上方后，指针从那一行移向按钮必然经过上一行；上一行多半
 * 不是改动行，`mousemove` 一落到它就整组收起，按钮因此**永远点不到**（2026-11-26 复
 * 核实测）。现在只在行尾放一枚小的 `⋯`（与行同一垂直中线），点击后展开的菜单挂在它
 * 旁边：指针从行内水平移到按钮、再从按钮移到菜单，全程不进入别的行。
 *
 * 本模块只回答"用户要对哪一处改动做什么"：`onUndo(mark)` / `confirm.onToggle(mark)`
 * 收到的是 `marks` 里的那个对象，其中 `hunk` 是 `ChangeSet.patches` 的下标。真正的
 * 撤销（远端 `git apply -R`）由调用方完成，文案也由调用方的 i18n 决定。
 */
import type { EditorState, Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type Rect, type ViewUpdate } from '@codemirror/view'
import { changeSetOf, type ChangeMark } from '../vsc/change-marks.ts'

/** 贴行那枚 `⋯` 的 class（样式在 `vsc/vsc.css` 的 `session changes` 一节）。 */
const TRIGGER_CLASS = 'rvs-change-actions'

/** 展开菜单的 class（菜单项也在里面：`.rvs-change-actions-menu button`）。 */
const MENU_CLASS = 'rvs-change-actions-menu'

/** 菜单里两个动作的 class（自检按它们定位，不依赖文案）。 */
const UNDO_ITEM_CLASS = 'rvs-change-actions-undo'
const CONFIRM_ITEM_CLASS = 'rvs-change-actions-confirm'

/** 两个浮层元素的 z-index（编辑器宿主有裁剪层，必须高过它）。 */
const LAYER_Z = '2100'

/** 悬停多久后弹出（毫秒）。 */
const DEFAULT_HOVER_MS = 300

/**
 * 指针离开编辑器内容后，浮层还留多久（毫秒）。
 *
 * 只为跨越"行尾 → 按钮"之间那段空隙，以及从按钮进菜单的距离：那段只有几个像素，
 * 150ms 足够，又不至于让一个已经离开的浮层在屏幕上赖着。
 */
const LEAVE_GRACE_MS = 150

/** 默认按钮文案。真实调用方（`CodeEditor`）总会传自己 i18n 的那一条。 */
export const DEFAULT_UNDO_LABEL = '撤销这处改动'

/** 「确认保留」的默认文案（同上是兜底：真实调用方传 i18n）。 */
export const DEFAULT_CONFIRM_LABEL = '确认保留'

/** 已确认态下的默认文案。 */
export const DEFAULT_CONFIRMED_LABEL = '已确认保留'

/** `⋯` 按钮的默认说明（真实调用方传 i18n）。 */
export const DEFAULT_TRIGGER_LABEL = '改动操作'

/**
 * 菜单里的第二个动作：「这处改动我看过，保留」。
 *
 * 它是**纯本地记账**（见 `changes/block-confirm.ts`）：不写远端、不发请求、不动
 * `ChangeSet`。所以这里只把"这一块当前是什么状态"问出来、把点击交回去，存哪里、
 * 怎么持久化都由调用方决定 —— 编辑器组件不持有那份状态。
 */
export interface BlockConfirmOptions {
  /** 这一块现在是否已确认（每次点击后重新读取，状态在 React 之外变化）。 */
  isConfirmed: (mark: ChangeMark) => boolean
  /** 用户点了切换：调用方负责落盘（本地存储），不得发起任何远端写。 */
  onToggle: (mark: ChangeMark) => void
  /** 未确认时的文案。 */
  label: (mark: ChangeMark) => string
  /** 已确认时的文案；省略则沿用 {@link label}。 */
  pressedLabel?: (mark: ChangeMark) => string
}

export interface UndoAffordanceOptions {
  /**
   * 点了撤销：`mark` 就是 `ChangeSet.marks` 里的那个对象（`hunk` = `patches` 下标）。
   * 不给时整块扩展不安装（`[]`），行为与没有这个功能时完全一致。
   */
  onUndo?: (mark: ChangeMark) => void
  /**
   * 撤销项的文案。默认只是兜底：真实调用方按 `kind` 给出自己的（i18n）说法，
   * 例如删除锚点说「撤销这处删除」。
   */
  label?: (mark: ChangeMark) => string
  /** `⋯` 按钮的说明（title / aria-label）。 */
  triggerLabel?: () => string
  /** 悬停延迟，缺省 300ms。 */
  hoverTime?: number
  /** 「确认保留」这一级（省略 = 菜单里只有撤销一项）。 */
  confirm?: BlockConfirmOptions
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

/**
 * 只读编辑器里不提供撤销（断线降级 / 超上限截断）。
 *
 * 撤销按钮点下去是一次远端写（`git apply -R`），所以只读时它必须消失：否则屏幕上
 * 「只读（不能保存）」与「可写的撤销」并存，且请求只会在远端失败。判据读编辑器自己的
 * `readOnly` facet —— 与 `CodeEditor` 的 readOnly Compartment 是同一个事实，不需要再传
 * 一个 prop（第二个真相源迟早会漂）。
 *
 * 导出是为了让门禁能钉住这个判定（渲染 CodeMirror 的 DOM 级证明成本高，而这里的
 * 语义只有"只读 ⇒ 不提供"一句话）。
 */
export function undoBlockedByReadOnly(view: { state: { readOnly: boolean } }): boolean {
  return view.state.readOnly
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

/** 一件改动浮层的实例状态：`⋯` 按钮、它的菜单、悬停计时、当前命中的那一处改动。 */
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
  private readonly triggerLabel: () => string
  private readonly hoverTime: number
  /** 「确认保留」这一级的回调；`undefined` = 菜单里只有撤销一项。 */
  private readonly confirm: BlockConfirmOptions | undefined
  private trigger: HTMLButtonElement | undefined
  private menu: HTMLDivElement | undefined
  private undoItem: HTMLButtonElement | undefined
  private confirmItem: HTMLButtonElement | undefined
  /** 菜单当前是否展开（展开时 `aria-expanded` 为 true）。 */
  private menuOpen = false
  private timer: number | undefined
  /**
   * 「指针已经离开了」的宽限计时。
   *
   * 浮层挂在行尾右侧、位于编辑器内容之外，鼠标从那一行移到按钮上必然先离开
   * `contentDOM` —— 若 `mouseleave` 立刻收，用户永远点不到。所以离开后等一小会儿，
   * 指针真的进了按钮/菜单就撤销这次收起。
   */
  private leaveTimer: number | undefined
  /** 指针当前停在的改动（可能还在等计时）。 */
  private hovered: Hovered | undefined
  /** 正在屏幕上显示的那一处改动。 */
  private shown: Hovered | undefined

  /**
   * 收起用的全局监听：任何时候按下鼠标（触发按钮与菜单自己除外）、按 Escape、页面切到
   * 后台、窗口失焦，都把浮层收掉。一次注册、常在的写法与 `useSelectionPopup` 一致 ——
   * 浮层活不过它所属的编辑器表面，宁可多收一次，也不能留一个指向旧行的按钮。
   */
  private readonly onGlobalMouseDown = (event: MouseEvent): void => {
    if (this.shown === undefined) return
    const target = event.target instanceof Node ? event.target : null
    // 触发按钮与菜单都在 body 上、都不在编辑器 DOM 里：点它们不算"点了别处"。
    for (const element of [this.trigger, this.menu]) {
      if (element !== undefined && target !== null && element.contains(target)) return
    }
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
    this.triggerLabel = options.triggerLabel ?? (() => DEFAULT_TRIGGER_LABEL)
    this.hoverTime = options.hoverTime ?? DEFAULT_HOVER_MS
    this.confirm = options.confirm
    document.addEventListener('mousedown', this.onGlobalMouseDown, true)
    document.addEventListener('keydown', this.onGlobalKeyDown, true)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    window.addEventListener('blur', this.onWindowBlur)
  }

  /** 鼠标在编辑器内容里移动：命中一处改动就（重新）开始悬停计时。 */
  handleMove(event: MouseEvent): void {
    this.cancelLeave()
    /**
     * 键盘用户已经把焦点放进菜单项时，鼠标的偶然移动不该把菜单收掉（否则用键盘
     * 打开菜单后，手一碰鼠标菜单就消失，而焦点已经不在编辑器里、再想用键盘继续
     * 也没有落点）。收起改由 Escape / 点菜单外部决定（`onGlobalKeyDown` /
     * `onGlobalMouseDown`）。
     */
    if (this.menuHasFocus()) return
    /**
     * 只读的编辑器没有可执行的撤销：断线降级（`connection.state === error`）与超上限
     * 截断都通过 CodeMirror 的 `readOnly` 生效，而这条动作是一次**远端写**
     * （`git apply -R`）。判据直接读编辑器自己的 state，与只读 Compartment 是同一个
     * 事实，不需要再传一个 prop（第二个真相源迟早会漂）。顺带覆盖将来任何只读面。
     */
    if (undoBlockedByReadOnly(this.view)) {
      this.reset()
      return
    }
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
    // 同一个改动点：计时已经开始（或浮层已经弹出），不重来 —— 否则手一抖就得再等一遍。
    if (current !== undefined && current.line === line && current.mark === mark) return
    // 换了一处（或从别处移过来）：旧浮层立刻收，旧计时作废。
    this.reset()
    this.hovered = { mark, line, element: lineElementAt(this.view, event) }
    this.timer = window.setTimeout(() => { this.arm() }, this.hoverTime)
  }

  /** 指针离开编辑器内容（可能正走向按钮/菜单，见 `leaveTimer`）。 */
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
    /**
     * 悬停计时这段时间里链路可能已经断了（只读 Compartment 被 reconfigure）：
     * 到点再确认一次，否则按钮会出现在一个已经不能写的编辑器里。
     */
    if (undoBlockedByReadOnly(this.view)) {
      this.reset()
      return
    }
    if (markAtLine(this.view.state, hover.line) !== hover.mark) {
      this.reset()
      return
    }
    this.shown = hover
    this.show(hover)
  }

  /**
   * 建那枚 `⋯`（一个实例一个，复用）。
   *
   * 点它只做一件事：展开/收起菜单。按钮本身永远是**固定定位挂在 body 上**的，
   * 位置由 `show()` 按行尾算。
   */
  private ensureTrigger(): HTMLButtonElement {
    const existing = this.trigger
    if (existing !== undefined) return existing
    const button = document.createElement('button')
    button.type = 'button'
    button.className = TRIGGER_CLASS
    button.textContent = '⋯'
    button.setAttribute('aria-haspopup', 'menu')
    button.setAttribute('aria-expanded', 'false')
    // 行内再写一遍固定定位：样式表缺席（自检、被别处的样式覆盖）时按钮仍然不会被
    // 任何滚动/裁剪祖先吃掉。
    button.style.position = 'fixed'
    button.style.zIndex = LAYER_Z
    // 按下时不抢焦点、不打断编辑器里的选区：与旁边那个「添加到对话」按钮同一套处理。
    button.addEventListener('mousedown', (event) => { event.preventDefault() })
    // 指针真的进了按钮：撤销上面那次"离开了"的收起。
    button.addEventListener('mouseenter', () => { this.cancelLeave() })
    button.addEventListener('mouseleave', () => { this.scheduleLeave() })
    button.addEventListener('click', () => {
      if (this.shown === undefined) return
      if (this.menuOpen) this.closeMenu()
      else this.openMenu()
    })
    this.trigger = button
    return button
  }

  /** 建菜单（一个实例一个，复用）：撤销 +（可选）确认保留。 */
  private ensureMenu(): HTMLDivElement {
    const existing = this.menu
    if (existing !== undefined) return existing
    const menu = document.createElement('div')
    menu.className = MENU_CLASS
    menu.setAttribute('role', 'menu')
    menu.style.position = 'fixed'
    menu.style.zIndex = LAYER_Z
    menu.hidden = true
    menu.addEventListener('mouseenter', () => { this.cancelLeave() })
    menu.addEventListener('mouseleave', () => { this.scheduleLeave() })
    menu.addEventListener('mousedown', (event) => {
      // 点菜单项不抢焦点（编辑器里的选区不该因为一次操作丢掉）。
      event.preventDefault()
    })

    const undo = document.createElement('button')
    undo.type = 'button'
    undo.className = UNDO_ITEM_CLASS
    undo.setAttribute('role', 'menuitem')
    undo.addEventListener('click', () => {
      const shown = this.shown
      // 先收浮层再回调：回调会改远端文件、重读标签页，浮层留着就已经指向旧内容了。
      this.reset()
      if (shown !== undefined) this.onUndo(shown.mark)
    })
    menu.appendChild(undo)

    const confirm = this.confirm
    if (confirm !== undefined) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = CONFIRM_ITEM_CLASS
      item.setAttribute('role', 'menuitem')
      item.addEventListener('click', () => {
        const shown = this.shown
        if (shown === undefined) return
        // 不收起：切换的是一个位（已确认 ↔ 未确认），收起用户就看不见这次点击的结果。
        confirm.onToggle(shown.mark)
        this.syncConfirm(shown.mark)
        this.placeMenu()
      })
      menu.appendChild(item)
      this.confirmItem = item
    }
    this.undoItem = undo
    this.menu = menu
    return menu
  }

  /** 把菜单里的两项刷成这一处改动的当前状态。 */
  private syncItems(mark: ChangeMark): void {
    const undo = this.undoItem
    if (undo !== undefined) {
      const text = this.label(mark)
      if (undo.textContent !== text) undo.textContent = text
      undo.title = text
      undo.setAttribute('aria-label', text)
      undo.dataset.kind = mark.kind
      undo.dataset.hunk = String(mark.hunk ?? -1)
    }
    this.syncConfirm(mark)
  }

  /** 把「确认保留」项刷成这一块当前的状态（文案 + aria-pressed + data 属性）。 */
  private syncConfirm(mark: ChangeMark): void {
    const confirm = this.confirm
    const item = this.confirmItem
    if (confirm === undefined || item === undefined) return
    const on = confirm.isConfirmed(mark)
    const text = on ? (confirm.pressedLabel?.(mark) ?? confirm.label(mark)) : confirm.label(mark)
    if (item.textContent !== text) item.textContent = text
    item.title = text
    item.setAttribute('aria-label', text)
    item.setAttribute('aria-pressed', on ? 'true' : 'false')
    item.dataset.confirmed = on ? '1' : '0'
    item.classList.toggle('is-on', on)
  }

  /** 取消"指针离开"的宽限收起。 */
  private cancelLeave(): void {
    if (this.leaveTimer === undefined) return
    window.clearTimeout(this.leaveTimer)
    this.leaveTimer = undefined
  }

  /** 等一小会儿再收：指针可能是走向按钮/菜单（见 `leaveTimer`）。 */
  private scheduleLeave(): void {
    this.cancelLeave()
    this.leaveTimer = window.setTimeout(() => {
      this.leaveTimer = undefined
      // 焦点在菜单里（键盘路径）：指针离开不该把菜单收掉。
      if (this.menuHasFocus()) return
      this.reset()
    }, LEAVE_GRACE_MS)
  }

  /** 焦点是否在展开的菜单里（键盘用户正在菜单项之间移动）。 */
  private menuHasFocus(): boolean {
    const menu = this.menu
    if (menu === undefined || !this.menuOpen) return false
    return menu.contains(document.activeElement)
  }

  /**
   * 把 `⋯` 放到这一行的右侧（贴行尾，视口内）。
   *
   * 关键约束：**垂直中线锁在这一行上**。按钮只有一行高，指针从行内水平移到它、
   * 再从它移到菜单，全程不进入别的 `.cm-line` —— 上一版把整组按钮挪到行的上方，
   * 指针必然先经过上一行，而上一行不是改动行会立刻触发 `reset()`，按钮永远点不到
   * （2026-11-26 复核实测）。行尾贴到视口边缘时只做横向夹取，绝不上下移动。
   */
  private show(hover: Hovered): void {
    const trigger = this.ensureTrigger()
    const label = this.triggerLabel()
    trigger.title = label
    trigger.setAttribute('aria-label', label)
    if (trigger.parentNode === null) document.body.appendChild(trigger)
    const menu = this.ensureMenu()
    if (menu.parentNode === null) document.body.appendChild(menu)
    this.syncItems(hover.mark)
    if (!this.placeTrigger(hover)) {
      // 位置量不出来（既没有文本坐标也没有行元素）：宁可先不显示，也不要把按钮
      // 丢到屏幕左上角去。
      trigger.remove()
      menu.remove()
    }
  }

  /** 按行尾计算 `⋯` 的位置；量不到位置时返回 false。 */
  private placeTrigger(hover: Hovered): boolean {
    const trigger = this.trigger
    if (trigger === undefined) return false
    const rect = this.rectFor(hover)
    if (rect === null) return false
    const gap = 8
    const width = trigger.getBoundingClientRect().width
    const limit = window.innerWidth - gap
    let left = rect.right + gap
    // 只夹横向：垂直中线必须留在这一行上（见 `show` 的说明）。
    left = width > 0 && left + width > limit ? Math.max(gap, limit - width) : Math.min(left, limit)
    trigger.style.left = `${Math.round(left)}px`
    trigger.style.top = `${Math.round((rect.top + rect.bottom) / 2)}px`
    if (this.menuOpen) this.placeMenu()
    return true
  }

  /**
   * 菜单贴着按钮：默认在下方，放不下就翻到上方，横向与按钮右对齐。
   *
   * **垂直方向零缝**，这是可达性的关键（复核 MUST）：菜单与按钮之间若留出 4px 空隙，
   * 那条带正好落在下一行 `.cm-line` 的箱体上；指针从按钮下移到菜单必然经过它，
   * `mousemove` 一落到那一行（不是改动行）就 `handleMove` → `reset()`，菜单和按钮
   * 一起消失，鼠标主路径因此完全点不到菜单项（复核者用真插件 + jsdom 复现）。
   * 现在菜单顶边（下方模式）就是按钮底边、翻转模式菜单底边就是按钮顶边，再配合样式表
   * 里那条 8px 透明桥（`::before`，只覆盖按钮自身的区域），接缝处不留给编辑器内容。
   */
  private placeMenu(): void {
    const menu = this.menu
    const trigger = this.trigger
    if (menu === undefined || trigger === undefined) return
    const anchor = trigger.getBoundingClientRect()
    const box = menu.getBoundingClientRect()
    /** 只用于视口边缘的留白；垂直方向不使用任何间隙（见方法说明）。 */
    const edge = 4
    const limitX = window.innerWidth - edge
    const limitY = window.innerHeight - edge
    const width = box.width
    let left = anchor.right - width
    left = Math.max(edge, Math.min(left, limitX - width))
    let top = anchor.bottom
    let side: 'below' | 'above' = 'below'
    if (box.height > 0 && top + box.height > limitY) {
      top = anchor.top - box.height
      side = 'above'
    }
    menu.dataset.side = side
    menu.style.left = `${Math.round(left)}px`
    menu.style.top = `${Math.round(top)}px`
  }

  /** 展开菜单（`aria-expanded` 同步，位置先算再显示）。 */
  private openMenu(): void {
    const menu = this.ensureMenu()
    if (menu.parentNode === null) document.body.appendChild(menu)
    this.menuOpen = true
    this.trigger?.setAttribute('aria-expanded', 'true')
    menu.hidden = false
    this.placeMenu()
  }

  /** 收起菜单（`⋯` 留在原地，用户可以直接再点开）。 */
  private closeMenu(): void {
    this.menuOpen = false
    this.trigger?.setAttribute('aria-expanded', 'false')
    const menu = this.menu
    if (menu !== undefined) menu.hidden = true
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
    this.closeMenu()
    const trigger = this.trigger
    if (trigger !== undefined && trigger.parentNode !== null) trigger.remove()
    const menu = this.menu
    if (menu !== undefined && menu.parentNode !== null) menu.remove()
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
    this.trigger?.remove()
    this.trigger = undefined
    this.menu?.remove()
    this.menu = undefined
    this.undoItem = undefined
    this.confirmItem = undefined
    document.removeEventListener('mousedown', this.onGlobalMouseDown, true)
    document.removeEventListener('keydown', this.onGlobalKeyDown, true)
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    window.removeEventListener('blur', this.onWindowBlur)
  }
}

/**
 * 装上「改动操作」浮层（`⋯` + 菜单）。
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
