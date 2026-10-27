/**
 * CodeMirror 6 wrapper: one editor per mount (parent remounts via key when the
 * file changes). Content is pulled imperatively (no per-keystroke string
 * copies); dirty state is reported through onDirty. A non-empty selection
 * anchors the floating "add to conversation" button above its head (the
 * local viewer's twin — see selection-popup.ts); the payload is a fenced
 * `rel:lines` block inserted into the on-screen session's composer draft.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import { EditorSelection, EditorState, StateEffect, StateField, Compartment, type Extension, type Text } from '@codemirror/state'
import { Decoration, EditorView, highlightActiveLine, keymap, lineNumbers, type DecorationSet } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, ensureSyntaxTree, indentOnInput } from '@codemirror/language'
import { closeBrackets } from '@codemirror/autocomplete'
import { search } from '@codemirror/search'
import { syntaxHighlighting } from '@codemirror/language'
import { vscodeHighlightStyle } from './vsc/editor-palette.ts'
import { FindWidget, clearFindMarks, findMatchHighlight, stepFind } from './vsc/FindWidget.tsx'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { yaml } from '@codemirror/lang-yaml'
import { java } from '@codemirror/lang-java'
import { cpp } from '@codemirror/lang-cpp'
import { go } from '@codemirror/lang-go'
import { rust } from '@codemirror/lang-rust'
import { xml } from '@codemirror/lang-xml'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { diff } from '@codemirror/legacy-modes/mode/diff'
import { appendToDraft, buildRemoteSelectionInsert } from './composer.ts'
import { useSelectionPopup } from './selection-popup.ts'
import { initialEditorTheme, watchEditorScheme } from './vsc/editor-theme.ts'

/**
 * The bits of an editor's view state that must survive an unmount.
 *
 * Switching file tabs remounts `CodeEditor` (its `key` is the tab id, so an
 * identity change gets a fresh buffer rather than inheriting the previous
 * file's undo history). Without carrying this across, every tab switch threw
 * the reader back to line 1 with the caret at the start.
 */
export interface CodeEditorViewState {
  /** Scroll offset of the code scroller, in pixels. */
  scrollTop: number
  /** Scroll offset of the code scroller, in pixels. */
  scrollLeft: number
  /** Caret position as a document offset. */
  cursor: number
  /** All selection ranges (multi-cursor survives a tab switch too). */
  ranges: { anchor: number; head: number }[]
}

export interface CodeEditorHandle {
  getContent: () => string
  isDirty: () => boolean
  /**
   * Advance the dirty baseline to the bytes a save just wrote to the remote
   * file, and re-derive the dirty flag from the LIVE buffer against them.
   *
   * Takes the saved text explicitly because the user may have typed while the
   * remote write was in flight: the buffer is then NEWER than the file, and
   * declaring it saved would be the same silent-loss bug in the other
   * direction. `tabId` guards against the pane having switched to another tab
   * while the save awaited — marking that editor saved would corrupt ITS
   * baseline.
   */
  markSaved: (savedText: string, tabId: string) => void
  /** Snapshot scroll + selection, for restoring after a remount. */
  getViewState: () => CodeEditorViewState | undefined
  /** Scroll back and put the caret where it was. */
  applyViewState: (state: CodeEditorViewState) => void
  /** 选中一个行区间（1-based 行号）并滚到视野中央。 */
  revealRange: (from: number, to: number) => void
  /**
   * 改动标记是否已被编辑作废（true = 屏幕上不再画任何改动点）。
   *
   * 暴露成独立的一个布尔查询、而不是把 `EditorView` 交出去：外部唯一需要知道的
   * 就是"这份数据还准不准"，拿到了整个 view 则能改文档、改配置，是另一回事。
   */
  getChangeStale: () => boolean
}

/** Compartment holding the fallback highlighter (armed only when needed). */
const fallbackCompartment = new Compartment()

/**
 * Compartment holding the session-change marks.
 *
 * 初始为空：只有调用方真的传了 `changeSet` 才把整套扩展（行背景 + gutter）装进
 * 来。这不是洁癖 —— gutter 一旦装上就会给每行行号左边腾出一条栏位，没传改动数据
 * 的编辑器（diff 面板、只读预览）因此不会多出一列空白。
 */
const changeMarksCompartment = new Compartment()

/** True while CodeMirror's own highlighter has produced token spans. */
function primaryColored(host: Element): boolean {
  return host.querySelector('[class*="rvs-ck-"]') !== null
}

// (The reveal state field + helper live in vsc/reveal-line.ts so the
// self-check harness can drive a jump without mounting the React component.)

import { langFor } from './vsc/editor-langs.ts'
import { canFallbackHighlight, fallbackHighlight } from './vsc/fallback-highlight.ts'
import { revealLine, revealLineField, setRevealLine, revealRange } from './vsc/reveal-line.ts'
import {
  changeMarksExtension,
  changeStaleField,
  changeBlockAt,
  setChangeSet,
  type ChangeMark,
  type ChangeSet,
} from './vsc/change-marks.ts'
import { DEFAULT_UNDO_LABEL, undoAffordance } from './changes/undo-affordance.ts'

/**
 * The editor surface is OPAQUE and scrolls in the editor's own palette
 * (`vsc/editor-theme.ts`): a code editor is not a translucent DSH panel, and
 * the VS Code theme is what gives the tokens their readable colors.
 */
export const CodeEditor = forwardRef<CodeEditorHandle, {
  initial: string
  path: string
  readOnly?: boolean
  /** Parent sub-tab visibility (views stay mounted; remeasure on show). */
  visible?: boolean
  /** Chat-insert target: absent/disabled hides the selection popup. */
  ctx?: Context
  sessionId?: string | undefined
  remoteRoot?: string | undefined
  chatEnabled?: boolean
  addLabel?: string
  /** 1-based line to reveal after mount (a content-search hit). */
  revealLine?: number
  /** Bumped per reveal request, so the same line can be jumped to twice. */
  revealNonce?: number
  /**
   * 本会话在这个文件里的改动（行号 1-based）。`undefined` = 不开启改动标记：
   * 不装扩展、不出现 gutter —— 没传这个 prop 的调用方（diff 面板等）行为与
   * 加入本功能之前完全一致。
   */
  changeSet?: ChangeSet | null
  /**
   * 用户在某一处改动上按下「撤销这处改动」时回调。
   *
   * 收到的是 `changeSet.marks` 里的那个对象（`hunk` 是 `changeSet.patches` 的下标）。
   * 不传就不装悬浮撤销那一整套（`undoAffordance`），编辑器行为与没有这个功能时
   * 完全一致 —— 也就不会点出一个没人接的动作。
   */
  onUndoChange?: (mark: ChangeMark) => void
  /** 悬浮按钮的文案（由调用方按 `kind` 给出它的 i18n 说法）。 */
  undoLabel?: (mark: ChangeMark) => string
  /** 改动点跳转的目标行（1-based），配合 `revealHunkNonce` 重跳同一行。 */
  revealHunkLine?: number
  /** 改动点跳转的 nonce（同 `revealNonce` 的道理）。 */
  revealHunkNonce?: number
  /**
   * 用户按下「上一个/下一个改动点」快捷键时回调。
   *
   * 列表算在 store 那边（`gotoChange`），编辑器只转发方向：组件内自己维护一份
   * hunk 列表会与 tab 上的 `activeHunk` 漂成两份。
   */
  onStepHunk?: (dir: 1 | -1) => void
  /**
   * 文档被编辑、改动标记已作废时回调一次（false→true 的跳变）。
   *
   * 用回调而不是让上层轮询 handle：这件事发生在一次按键里，轮询会漏。
   */
  onChangeStale?: () => void
  /** Reports how many token spans the grammar produced (diagnostics). */
  onTokens?: (count: number) => void
  /**
   * Reports this editor's scroll + caret as they change, and once more when it
   * unmounts. The FIRST argument is this editor's own tab id, so the consumer
   * never has to guess which tab a reading belongs to.
   *
   * The editor reports it, rather than the parent asking through the ref,
   * because the parent's ref is already `null` by the time its layout-effect
   * cleanup runs — React clears a child's ref before running the parent's
   * cleanup. Only this component still holds the `EditorView` at that moment.
   */
  onViewState?: (tabId: string, state: CodeEditorViewState) => void
  /**
   * This editor's tab id, echoed back with every report (see `onViewState`).
   * Optional because the diff panes mount `CodeEditor` too and have no tab of
   * their own; they pass no `onViewState`, so nothing is reported for them.
   */
  tabId?: string
  /**
   * Scroll + caret to restore after this instance mounts.
   *
   * Read ONCE on mount (through a ref, so a later change to the prop cannot
   * re-scroll a live editor out from under the reader). Used to come back to
   * where a file was when its tab is re-selected.
   */
  viewState?: CodeEditorViewState
  /**
   * The text as it was last LOADED from / SAVED to the remote file — the dirty
   * baseline.
   *
   * Separate from `initial` because a tab switch or a surface flip remounts the
   * editor with the LIVE buffer as `initial` (that is how unsaved edits survive
   * the remount), while the file on disk is still the older `savedText`. Using
   * `initial` as the baseline would declare the unsaved text clean: the dirty
   * dot and status would lie, the close guard would stop prompting and Save
   * would disable — a silent way to lose the very edits the handoff preserved.
   *
   * Absent (diff panes, older callers): the mount's own document is the
   * baseline, which is the historical behaviour.
   */
  savedText?: string
  onSave: () => void
  onDirty: (dirty: boolean) => void
}>(function CodeEditor(props, ref) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | undefined>(undefined)
  const savedRef = useRef<string>(props.initial)
  const savedDocRef = useRef<Text | undefined>(undefined)
  const dirtyRef = useRef<boolean>(false)
  const propsRef = useRef(props)
  propsRef.current = props
  // The CodeMirror selection listener lives for the mount's lifetime; the
  // chat target may change underneath it (session switches don't remount
  // the editor), so it reads through refs, never captured props.
  const targetRef = useRef({ sessionId: props.sessionId, remoteRoot: props.remoteRoot, chatEnabled: props.chatEnabled, path: props.path })
  targetRef.current = { sessionId: props.sessionId, remoteRoot: props.remoteRoot, chatEnabled: props.chatEnabled, path: props.path }
  const ctxRef = useRef(props.ctx)
  ctxRef.current = props.ctx
  // Captured on the first render only: after that the prop is irrelevant,
  // because the editor is live and the reader may have scrolled elsewhere.
  const pendingViewStateRef = useRef<CodeEditorViewState | undefined>(props.viewState)

  /**
   * The floating "add to conversation" popup (viewport-anchored; null =
   * hidden). The hook owns show/hide/commit plus the global dismissal
   * listeners (outside mousedown, Escape, hidden tab/window, surface
   * leaving the viewport) — see selection-popup.ts.
   */
  const selectionPopup = useSelectionPopup({
    onCommit: (insert) => {
      const ctx = ctxRef.current
      const sessionId = targetRef.current.sessionId
      if (ctx !== undefined && sessionId !== undefined) appendToDraft(ctx, sessionId, insert)
    },
    getSurface: () => hostRef.current,
  })
  const popupRef = useRef(selectionPopup)
  popupRef.current = selectionPopup

  // Find widget (Ctrl/Cmd+F). The view is mirrored into state so the widget
  // can re-render once the editor exists; `findSeed` carries a selection into
  // the query box.
  const [findOpen, setFindOpen] = useState(false)
  const findOpenRef = useRef(false)
  findOpenRef.current = findOpen
  const [findSeed, setFindSeed] = useState({ text: '', id: 0 })
  const [view, setView] = useState<EditorView | undefined>(undefined)
  /** Landing highlight for a jump (null = nothing lit). */
  const [litPosition, setLitPosition] = useState<number | null>(null)

  // Light the landing line whenever the position changes.
  useEffect(() => {
    const current = viewRef.current
    if (current === undefined) return
    try {
      current.dispatch({ effects: setRevealLine.of(litPosition) })
    } catch {
      // Disposed.
    }
  }, [litPosition, view])

  /**
   * Re-jump when the ADDRESSED LINE changes on a mounted editor: opening a
   * second search hit in a file that is already open must move the caret, not
   * silently do nothing (the mount-time reveal only covers the first open).
   */
  useEffect(() => {
    const target = props.revealLine
    if (target === undefined || target <= 0) return
    const current = viewRef.current
    if (current === undefined) return
    // A short delay lets a just-updated document settle before measuring.
    const timer = window.setTimeout(() => revealLine(current, target, setLitPosition), 60)
    return () => window.clearTimeout(timer)
    // `revealNonce` re-runs this for a repeat jump to the same line.
  }, [props.revealLine, props.revealNonce, view])

  /**
   * 把「本会话改了什么」喂进编辑器（行背景 + 左侧 gutter），并按需带上悬浮撤销。
   *
   * 两件事分开做：扩展的装卸（Compartment）只在"能力"翻转时发生 —— 有没有 `changeSet`
   * 决定装不装改动标记，有没有 `onUndoChange` 决定装不装悬浮撤销 —— 数据本身只在
   * **对象身份**变化时下发。身份比较不是省事，是正确性：编辑作废后 store 里的
   * `changeSet` 仍是原来那个对象（`markChangeStale` 不动它），若每次渲染都重新
   * dispatch，屏幕上会把已经作废的行号上的标记又画回来。
   *
   * 撤销按钮的回调与文案都通过 `propsRef` 现读，所以它们换身份不需要重装扩展；
   * 重装会丢掉正在进行的那次悬停，这是唯一要避开的副作用。
   */
  const armedRef = useRef('')
  const pushedSetRef = useRef<ChangeSet | null | undefined>(undefined)
  const undoArmed = props.onUndoChange !== undefined
  useEffect(() => {
    const current = viewRef.current
    if (current === undefined) return
    const set = props.changeSet
    const marks = set !== undefined
    const armed = `${marks ? 'm' : ''}${undoArmed ? 'u' : ''}`
    if (armed !== armedRef.current) {
      armedRef.current = armed
      // 重装扩展会重建字段，之前下发过的数据随之消失，必须再喂一次。
      pushedSetRef.current = undefined
      const extension: Extension = [
        ...(marks ? [changeMarksExtension] : []),
        ...(undoArmed
          ? [undoAffordance({
            onUndo: (mark) => { propsRef.current.onUndoChange?.(mark) },
            label: (mark) => propsRef.current.undoLabel?.(mark) ?? DEFAULT_UNDO_LABEL,
          })]
          : []),
      ]
      try {
        current.dispatch({ effects: changeMarksCompartment.reconfigure(extension) })
      } catch {
        return // Disposed view.
      }
    }
    if (set === undefined) return
    if (set === pushedSetRef.current) return
    pushedSetRef.current = set
    try {
      current.dispatch({ effects: setChangeSet.of(set) })
    } catch {
      // Disposed.
    }
  }, [props.changeSet, undoArmed, view])

  /**
   * 跳到某个改动点。
   *
   * 目标行由 store 写好（`gotoChange` 落 `revealHunkLine` + 递增的
   * `revealHunkNonce`），组件只负责"选中整块 + 居中"：一个改动点常有几十行，
   * 只放个 caret 看不出边界。
   */
  useEffect(() => {
    const target = props.revealHunkLine
    if (target === undefined || target <= 0) return
    const current = viewRef.current
    if (current === undefined) return
    // 与 revealLine 一样等一帧：刚下发的装饰要先落进 state，改动块才量得准。
    const timer = window.setTimeout(() => {
      const block = changeBlockAt(current.state, target)
      // 只放 caret、不选中整块：改动范围已经由行背景 + gutter 画出来了，而选中
      // 非空会顺带弹出编辑器现成的「添加到对话」浮层，正好盖住刚跳过去的那几行。
      revealLine(current, block.from, setLitPosition)
    }, 40)
    return () => window.clearTimeout(timer)
    // `revealHunkNonce` re-runs this for a repeat jump to the same hunk.
  }, [props.revealHunkLine, props.revealHunkNonce, view])

  /**
   * Anchor for the find widget: viewport coordinates of the editor's top-right
   * corner, refreshed while the widget is open. `position: fixed` on these
   * coordinates is what makes the box immune to whatever scrolls — the editor
   * lives in a slot whose height this plugin does not control, so an ancestor
   * scroller may well be the one moving.
   */
  const [anchor, setAnchor] = useState<{ top: number; right: number } | undefined>(undefined)
  useEffect(() => {
    if (!findOpen) {
      setAnchor(undefined)
      // Closing the widget drops its match marks too: leaving the highlights
      // behind would show a search result the user can no longer see the
      // controls for.
      const view = viewRef.current
      if (view !== undefined) clearFindMarks(view)
      return
    }
    const update = (): void => {
      const host = hostRef.current
      if (host === null) return
      const rect = host.getBoundingClientRect()
      const next = {
        top: Math.max(4, rect.top + 6),
        right: Math.max(8, window.innerWidth - rect.right + 18),
      }
      // Skip the state write when nothing moved: the 350 ms poll below
      // otherwise allocates a fresh anchor object every tick, and a new object
      // identity means React cannot bail out of re-rendering the editor while
      // the widget is open.
      setAnchor(prev => (prev !== undefined && prev.top === next.top && prev.right === next.right ? prev : next))
    }
    update()
    window.addEventListener('resize', update)
    // Capture phase: catches scrolling of ANY ancestor, not just the document.
    window.addEventListener('scroll', update, true)
    // Layout can also change without a scroll event (panel resize, split drag),
    // so keep polling cheaply while the widget is open.
    const timer = window.setInterval(update, 350)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      window.clearInterval(timer)
    }
  }, [findOpen])

  /**
   * Note on the SCROLL report: it is wired up INSIDE the mount effect below,
   * where the view is created — not in an effect of its own. An earlier version
   * used a separate `useEffect` declared ABOVE the mount effect, and that
   * silently did nothing: React runs same-kind effects in declaration order, so
   * it executed while `viewRef.current` was still `undefined`,
   * `addEventListener` was skipped through the optional chain, and its deps
   * never changed afterwards so it never retried. The result was an empty
   * position map and a tab switch that always snapped back to the top.
   *
   * The SELECTION half is reported by an update listener in the mount
   * extensions, since CodeMirror is the only thing that sees a caret move.
   */

  useImperativeHandle(ref, () => ({
    getContent: () => viewRef.current?.state.doc.toString() ?? savedRef.current,
    isDirty: () => dirtyRef.current,
    markSaved: (savedText, tabId) => {
      const view = viewRef.current
      if (view === undefined) return
      // The pane may have switched tabs while the save was in flight; this
      // editor is then a different file and must not adopt the other tab's
      // baseline.
      if (propsRef.current.tabId !== tabId) return
      // The written bytes themselves: no document copy needed (this string came
      // from the caller's own `getContent`, or from the tab's baseline).
      savedRef.current = savedText
      const saved = EditorState.create({ doc: savedText }).doc
      savedDocRef.current = saved
      const dirty = view.state.doc !== saved && !view.state.doc.eq(saved)
      if (dirty !== dirtyRef.current) {
        dirtyRef.current = dirty
        propsRef.current.onDirty(dirty)
      }
    },
    getViewState: () => {
      const view = viewRef.current
      if (view === undefined) return undefined
      const scroller = view.scrollDOM
      return {
        scrollTop: scroller.scrollTop,
        scrollLeft: scroller.scrollLeft,
        cursor: view.state.selection.main.head,
        ranges: view.state.selection.ranges.map(range => ({ anchor: range.anchor, head: range.head })),
      }
    },
    applyViewState: (state) => {
      const view = viewRef.current
      if (view === undefined) return
      // Clamp to the current document: the file may be shorter than it was
      // when the state was captured (a reload, or an edit made elsewhere).
      const max = view.state.doc.length
      const clamp = (value: number): number => Math.max(0, Math.min(value, max))
      const ranges = state.ranges
        .map(range => ({ anchor: clamp(range.anchor), head: clamp(range.head) }))
        .filter(range => range.anchor >= 0)
      if (ranges.length > 0) {
        try {
          view.dispatch({ selection: EditorSelection.create(ranges.map(range => EditorSelection.range(range.anchor, range.head))) })
        } catch {
          // A malformed capture must never break the editor: fall through to a
          // plain caret placement.
          view.dispatch({ selection: { anchor: clamp(state.cursor) } })
        }
      }
      const scroller = view.scrollDOM
      scroller.scrollTop = state.scrollTop
      scroller.scrollLeft = state.scrollLeft
    },
    revealRange: (from, to) => {
      const current = viewRef.current
      if (current === undefined) return
      revealRange(current, from, to)
    },
    getChangeStale: () => viewRef.current?.state.field(changeStaleField, false) === true,
  }), [])

  // Shown again after being hidden: remeasure layout.
  useEffect(() => {
    if (props.visible === false) return
    viewRef.current?.requestMeasure()
  }, [props.visible])

  /**
   * A save that landed AFTER this editor mounted.
   *
   * The save path moves the tab's `baseline` (the bytes now on disk) and asks
   * the live editor to re-derive its dirty flag. That works while the same
   * instance is mounted, but the pane can be remounted while the remote write
   * is in flight (a surface flip, a dock, a tab switch): the replacement
   * derives against the baseline it saw at MOUNT, and the corrected value only
   * arrives later as a prop. Without this effect the tab keeps the `dirty:false`
   * the save optimistically wrote, while the buffer holds newer text — dot off,
   * Save disabled, close guard silent. Re-derive, never touch the document.
   */
  useEffect(() => {
    const view = viewRef.current
    const savedText = props.savedText
    if (view === undefined || savedText === undefined) return
    const baseline = EditorState.create({ doc: savedText }).doc
    const previous = savedDocRef.current
    if (previous !== undefined && previous.eq(baseline)) return
    savedDocRef.current = baseline
    savedRef.current = savedText
    const dirty = view.state.doc !== baseline && !view.state.doc.eq(baseline)
    if (dirty !== dirtyRef.current) {
      dirtyRef.current = dirty
      propsRef.current.onDirty(dirty)
    }
  }, [props.savedText])

  // The chat gate may flip while a popup is open (session switched away):
  // never commit into a session the file no longer belongs to.
  const chatGate = props.chatEnabled === true && props.sessionId !== undefined && props.remoteRoot !== undefined
  useEffect(() => {
    if (!chatGate) popupRef.current.hide()
    // popupRef is a live mirror; only the gate flip must re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatGate])

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const extensions: Extension[] = [
      history(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        { key: 'Mod-s', run: () => { propsRef.current.onSave(); return true }, preventDefault: true },
        // Ctrl/Cmd+F opens OUR widget (the built-in search panel is never
        // mounted, so `searchKeymap` is deliberately absent). A selection seeds
        // the query, the way it does in VS Code, so find-on-selection is one
        // keystroke instead of a copy-paste.
        {
          key: 'Mod-f',
          run: (view) => {
            const sel = view.state.selection.main
            if (!sel.empty) {
              const text = view.state.sliceDoc(sel.from, sel.to)
              if (text !== '' && text.length <= 200) {
                setFindSeed(prev => ({ text, id: prev.id + 1 }))
              }
            }
            setFindOpen(true)
            return true
          },
          preventDefault: true,
        },
        { key: 'F3', run: (view) => { stepFind(view, true); return true }, preventDefault: true },
        { key: 'Shift-F3', run: (view) => { stepFind(view, false); return true }, preventDefault: true },
        /**
         * 上一个 / 下一个改动点。
         *
         * `Mod-Shift-Alt-ArrowUp/Down` 是挑出来的空位：`@codemirror/commands` 的
         * defaultKeymap 里 `Mod-Alt-ArrowUp/Down`（多光标）、`Alt-ArrowUp/Down`
         * （移动行）、`Shift-Alt-ArrowUp/Down`（复制行）都被占了，三者之上再加
         * Shift 的这两个组合它没有用；浏览器侧 Ctrl+Shift+Alt+方向键也没有默认
         * 行为（选中/滚动都落在更低的组合上）。
         *
         * 没有 `onStepHunk`（面板没开）时返回 false，按键照旧落回 CodeMirror 的
         * 默认处理，不会平白吞掉一个组合键。
         */
        {
          key: 'Mod-Shift-Alt-ArrowDown',
          run: () => {
            const step = propsRef.current.onStepHunk
            if (step === undefined) return false
            step(1)
            return true
          },
          preventDefault: true,
        },
        {
          key: 'Mod-Shift-Alt-ArrowUp',
          run: () => {
            const step = propsRef.current.onStepHunk
            if (step === undefined) return false
            step(-1)
            return true
          },
          preventDefault: true,
        },
        {
          key: 'Escape',
          run: () => {
            if (!findOpenRef.current) return false
            setFindOpen(false)
            return true
          },
        },
      ]),
      lineNumbers(),
      highlightActiveLine(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      // Search STATE only (the widget drives stepping); `createPanel: () =>
      // null` keeps CodeMirror's own panel from ever rendering. Note that
      // `@codemirror/search`'s own match highlighting stays off unless ITS
      // panel is mounted, which is why findMatchHighlight below paints the
      // matches instead — without it the widget counted "3/17" while nothing
      // on screen was highlighted.
      search({ top: true }),
      findMatchHighlight,
      initialEditorTheme(),
      // Syntax highlighting, OUTSIDE the theme compartment: colors come from
      // fixed `rvs-ck-*` classes in vsc.css, so this never needs reconfiguring
      // and cannot be lost by a scheme flip.
      syntaxHighlighting(vscodeHighlightStyle()),
      // Fallback coloring, off until it is needed (see `armFallback`).
      fallbackCompartment.of([]),
      revealLineField,
      // Session-change marks, off until a `changeSet` prop arrives (see
      // `changeMarksCompartment`).
      changeMarksCompartment.of([]),
      EditorView.lineWrapping,
      EditorState.readOnly.of(propsRef.current.readOnly === true),
      ...langFor(propsRef.current.path),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return
        // Compare by `Text.eq`, not by materializing the document: the string
        // form of a large file was copied on EVERY keystroke just to answer
        // "is this dirty", which the file header explicitly says the editor
        // avoids. `eq` is still O(n) but allocates nothing, and the identity
        // short-circuit handles the common untouched case.
        const saved = savedDocRef.current
        const dirty = saved !== undefined && update.state.doc !== saved && !update.state.doc.eq(saved)
        if (dirty !== dirtyRef.current) {
          dirtyRef.current = dirty
          propsRef.current.onDirty(dirty)
        }
      }),
      // Selection popup: a non-empty selection anchors the floating "add to
      // conversation" button above its head. Scrolling (geometry/viewport
      // change) or losing focus hides it; typing collapses the selection
      // and hides it too. Reads the chat target through targetRef (the
      // session may switch without remounting the editor).
      EditorView.updateListener.of((update) => {
        const popup = popupRef.current
        const target = targetRef.current
        if (target.chatEnabled !== true || target.sessionId === undefined || target.remoteRoot === undefined) {
          popup.hide()
          return
        }
        if (update.geometryChanged || update.viewportChanged) {
          popup.hide()
          return
        }
        if (!update.view.hasFocus) {
          popup.hide()
          return
        }
        if (!(update.selectionSet || update.docChanged || update.focusChanged)) return
        const sel = update.state.selection.main
        if (sel.empty) {
          popup.hide()
          return
        }
        const text = update.state.sliceDoc(sel.from, sel.to)
        if (text.trim() === '') {
          popup.hide()
          return
        }
        // Page coordinates (the document root may scroll); the popup is
        // position:fixed, so convert to viewport coordinates.
        const rect = update.view.coordsAtPos(sel.head)
        if (rect === null) {
          popup.hide()
          return
        }
        const doc = update.state.doc
        popup.show(
          buildRemoteSelectionInsert(target.path, target.remoteRoot, {
            start: doc.lineAt(sel.from).number,
            end: doc.lineAt(sel.to).number,
          }, text),
          rect.left - window.scrollX + (rect.right - rect.left) / 2,
          rect.top - window.scrollY,
        )
      }),
      /**
       * 改动标记作废的报告。
       *
       * 用 state field 的 false→true 跳变判定，而不是自己记一个 ref：装饰的清空
       * 就发生在 field 里（见 `change-marks.ts`），顺着同一个事实报告出去，绝不
       * 会出现"屏幕上已经没标记了、上层却还认为它有效"的分叉。字段不在时
       * （没传 `changeSet`）`field(..., false)` 给 undefined，这里自然什么都不做。
       */
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return
        const before = update.startState.field(changeStaleField, false)
        const after = update.state.field(changeStaleField, false)
        if (before === false && after === true) propsRef.current.onChangeStale?.()
      }),
      /**
       * Report selection changes upward (scroll is reported by a DOM listener,
       * which this complements): the caret is half of what a tab switch has to
       * restore, and CodeMirror exposes selection changes only through here.
       */
      EditorView.updateListener.of((update) => {
        if (!update.selectionSet) return
        const handler = propsRef.current.onViewState
        const tabId = propsRef.current.tabId
        if (handler === undefined || tabId === undefined) return
        const state = viewRef.current
        if (state === undefined) return
        handler(tabId, {
          scrollTop: state.scrollDOM.scrollTop,
          scrollLeft: state.scrollDOM.scrollLeft,
          cursor: state.state.selection.main.head,
          ranges: state.state.selection.ranges.map(range => ({ anchor: range.anchor, head: range.head })),
        })
      }),
    ]
    const view = new EditorView({
      doc: propsRef.current.initial,
      extensions,
      parent: host,
    })
    viewRef.current = view
    // Baseline for the dirty check, kept as a `Text` so comparing on a
    // keystroke does not have to materialize the document as a string.
    //
    // `savedText` (the last loaded/saved bytes) wins over the mounted document:
    // a remount can carry the UNSAVED buffer as `initial` (see the prop's doc),
    // and that text must never become the "clean" reference.
    const savedText = propsRef.current.savedText
    const baseline = savedText !== undefined
      ? EditorState.create({ doc: savedText }).doc
      : view.state.doc
    savedDocRef.current = baseline
    if (savedText !== undefined) {
      savedRef.current = savedText
      // Report the dirty state AT MOUNT: the buffer can already be newer than
      // the disk bytes (a handoff remount). Waiting for the first keystroke
      // left exactly such a file shown as clean — dot off, Save disabled,
      // close guard silent — which is the failure this baseline exists to
      // prevent.
      const dirty = view.state.doc !== baseline && !view.state.doc.eq(baseline)
      // Only a CHANGE is worth a store write: this runs on every mount, and a
      // clean tab reporting `false` would cost every subscriber a re-render for
      // nothing.
      if (dirty !== dirtyRef.current) {
        dirtyRef.current = dirty
        propsRef.current.onDirty(dirty)
      }
    }
    setView(view)
    /**
     * Come back to where this file was left.
     *
     * Restoring in an animation frame, not synchronously: the scroller's
     * scrollable height is only known once CodeMirror has measured the
     * viewport (it runs that on a frame/measure cycle), and a `scrollTop`
     * write before then is clamped away to 0. The selection half is applied
     * immediately so the caret is already right when the first paint lands.
     */
    const restore = pendingViewStateRef.current
    let restoreFrame: number | undefined
    if (restore !== undefined) {
      pendingViewStateRef.current = undefined
      const max = view.state.doc.length
      const clamp = (value: number): number => Math.max(0, Math.min(value, max))
      const ranges = restore.ranges
        .map(range => EditorSelection.range(clamp(range.anchor), clamp(range.head)))
        .filter(range => range.anchor <= max)
      try {
        const selection = ranges.length > 0
          ? EditorSelection.create(ranges, Math.min(ranges.length - 1, 0))
          : EditorSelection.single(clamp(restore.cursor))
        view.dispatch({ selection })
      } catch {
        // A malformed capture must never break the editor.
      }
      /**
       * Re-apply across frames until it sticks.
       *
       * A single `scrollTop` write is not enough: CodeMirror measures lazily and
       * its scroll handler scrolls the caret back into view, so a write made
       * before (or between) those passes is silently replaced with 0 and the
       * tab appears to have lost its position. Repeating for a few frames costs
       * nothing when the first write already won, and is what makes the restore
       * actually hold. Measured: without the retry the value came back as 0.
       */
      let attempts = 0
      const applyScroll = (): void => {
        const scroller = viewRef.current?.scrollDOM
        if (scroller === undefined) return
        if (scroller.scrollTop !== restore.scrollTop) scroller.scrollTop = restore.scrollTop
        if (scroller.scrollLeft !== restore.scrollLeft) scroller.scrollLeft = restore.scrollLeft
        attempts += 1
        if (attempts < 8 && scroller.scrollTop !== restore.scrollTop) {
          restoreFrame = window.requestAnimationFrame(applyScroll)
        }
      }
      restoreFrame = window.requestAnimationFrame(applyScroll)
    }

    /**
     * Publish scroll + caret upward, now that the view exists.
     *
     * Deliberately wired HERE and not in an effect of its own: the view is
     * created in this effect, so anything declared before it would run while
     * `viewRef.current` is still undefined and would never retry. (That was the
     * bug — a position map that stayed empty, and a tab switch that always
     * snapped back to the top.)
     */
    /**
     * Last position read WHILE THE VIEW WAS LIVE.
     *
     * The unmount report must not re-read `.scrollTop`: by then React has
     * detached the subtree and the scroller reports 0, which overwrote the real
     * position on the way out.
     */
    const lastLive = { scrollTop: 0, scrollLeft: 0, cursor: 0, ranges: [] as { anchor: number; head: number }[] }
    const capture = (): void => {
      lastLive.scrollTop = view.scrollDOM.scrollTop
      lastLive.scrollLeft = view.scrollDOM.scrollLeft
      lastLive.cursor = view.state.selection.main.head
      lastLive.ranges = view.state.selection.ranges.map(range => ({ anchor: range.anchor, head: range.head }))
    }

    /**
     * Publish scroll + caret upward, now that the view exists.
     *
     * The tab id travels WITH the reading. It cannot be inferred by the parent
     * from "which tab is active right now": React unmounts the outgoing editor
     * and mounts the incoming one in the same commit, so the incoming editor's
     * first report (scrollTop 0) arrives while the parent still sees the
     * OUTGOING tab as active — and overwrote the position just saved for it.
     * Measured: the map held `App.tsx: 1656`, then flipped back to 0, and every
     * switch landed at the top.
     *
     * Wired HERE and not in an effect of its own: the view is created in this
     * effect, so anything declared before it would run while `viewRef.current`
     * is still undefined and would never retry.
     */
    const report = (source: string): void => {
      const handler = propsRef.current.onViewState
      const tabId = propsRef.current.tabId
      if (handler === undefined || tabId === undefined) return
      if (source === 'unmount') {
        // Publish the last live reading, not a fresh one (see `lastLive`).
        handler(tabId, { ...lastLive, ranges: lastLive.ranges.map(range => ({ ...range })) })
        return
      }
      capture()
      handler(tabId, { ...lastLive, ranges: lastLive.ranges.map(range => ({ ...range })) })
    }
    let reportFrame: number | undefined
    const scheduleReport = (): void => {
      // Record the scroll offset synchronously: the throttled report may not
      // have run yet when the tab is switched away in the same frame, and
      // "last live reading" has to mean the latest, not the latest reported.
      lastLive.scrollTop = view.scrollDOM.scrollTop
      lastLive.scrollLeft = view.scrollDOM.scrollLeft
      if (reportFrame !== undefined) return
      reportFrame = window.requestAnimationFrame(() => {
        reportFrame = undefined
        report('scroll-rAF')
      })
    }
    view.scrollDOM.addEventListener('scroll', scheduleReport)
    // One report right after mount, so a never-scrolled tab has an entry too.
    report('mount')
    const disposeViewReport = (): void => {
      view.scrollDOM.removeEventListener('scroll', scheduleReport)
      if (reportFrame !== undefined) window.cancelAnimationFrame(reportFrame)
      // One last report while the view is still alive.
      report('unmount')
    }
    /**
     * Self-verifying coloring.
     *
     * The primary highlighter needs a grammar, an idle-time parse and a
     * decoration rebuild; when any link fails the file renders monochrome, and
     * that failure is silent. So after mounting we LOOK at the result: if no
     * token span appeared (and the tokenizer knows the extension), the fallback
     * highlighter is switched on and the file gets colored from the same
     * tokenizer the diff panes use. The console line names which path colored
     * the file, so a screenshot or a pasted line is enough to diagnose.
     */
    const stamp = (source: string): void => {
      const primary = host.querySelectorAll('[class*="rvs-ck-"]').length
      const fallback = host.querySelectorAll('span[class^="rvs-t-"]').length
      const count = primary > 0 ? primary : fallback
      console.info(`[dsh-remote-vs] build ${__RVS_BUILD__} · ${source} · colored tokens: ${count} (${propsRef.current.path})`)
      propsRef.current.onTokens?.(count)
    }
    const armFallback = (): void => {
      const needsFallback = !primaryColored(host) && canFallbackHighlight(propsRef.current.path)
      if (needsFallback) {
        try {
          view.dispatch({
            effects: fallbackCompartment.reconfigure(
              fallbackHighlight(propsRef.current.path, () => primaryColored(host)),
            ),
          })
        } catch {
          // A disposed view: nothing to color.
        }
      }
      window.setTimeout(() => stamp(needsFallback ? 'fallback' : 'grammar'), 120)
    }
    // Two passes: the first lets CodeMirror's own highlighter settle, the
    // second reports what actually ended up on screen. Both handles are kept
    // so unmounting cancels them — they used to fire against a destroyed view
    // when a tab was closed quickly.
    const armTimer = window.setTimeout(armFallback, 250)
    // Warm the parser once so the file is never left MONOCHROME: Lezer
    // languages are highlighted from a syntax tree built by an idle-time
    // worker, and a busy main thread (the chat stream, say) can starve it
    // indefinitely. Forcing a bounded synchronous parse here costs a few
    // milliseconds and removes that whole failure mode. (The jump itself is
    // handled by the reveal effect below, which also covers re-jumps.)
    const warmTimer = window.setTimeout(() => {
      try {
        ensureSyntaxTree(view.state, view.viewport.to, 300)
        view.dispatch({})
      } catch {
        // A disposed view: nothing to warm.
      }
    }, 120)
    // Recolor live when the app scheme flips (compartment reconfigure, so the
    // undo history and the cursor survive the swap).
    const unwatchTheme = watchEditorScheme(view)
    return () => {
      if (restoreFrame !== undefined) window.cancelAnimationFrame(restoreFrame)
      window.clearTimeout(armTimer)
      window.clearTimeout(warmTimer)
      popupRef.current.hide()
      unwatchTheme()
      /**
       * Last report BEFORE the view goes away, which is the only reliable place
       * to capture the position: the parent's ref is already null by the time
       * its own cleanup runs (React clears a child's ref first), so the parent
       * cannot ask for it. Also covers a tab closed while it was the active one.
       */
      disposeViewReport()
      view.destroy()
      viewRef.current = undefined
    }
    // Mount-once: the parent remounts (key) when the file identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const popup = selectionPopup.popup
  return (
    <>
      <div style={{ position: 'relative', height: '100%', minHeight: 0, overflow: 'hidden' }}>
        <div ref={hostRef} className="rvs-edge" style={{ height: '100%' }} />
      </div>
      {/* Portalled to <body> with fixed coordinates: the widget is then outside
          every scroller and every clipping ancestor in the editor subtree. */}
      {findOpen && typeof document !== 'undefined' && createPortal(
        <FindWidget
          view={view}
          open={findOpen}
          seed={findSeed}
          anchor={anchor}
          onClose={() => {
            setFindOpen(false)
            view?.focus()
          }}
        />,
        document.body,
      )}
      {popup !== null && typeof document !== 'undefined' && createPortal(
        <button
          ref={selectionPopup.buttonRef}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => selectionPopup.commit()}
          style={{
            position: 'fixed',
            left: popup.left,
            top: popup.top,
            transform: 'translate(-50%, calc(-100% - 8px))',
            zIndex: 1000,
            background: 'rgba(30,32,44,.95)',
            color: '#fff',
            border: '1px solid rgba(77,107,254,.6)',
            borderRadius: 6,
            fontSize: 12,
            padding: '4px 10px',
            cursor: 'pointer',
            boxShadow: '0 4px 14px rgba(0,0,0,.35)',
            whiteSpace: 'nowrap',
          }}
        >
          {props.addLabel ?? '添加到对话'}
        </button>,
        document.body,
      )}
    </>
  )
})
