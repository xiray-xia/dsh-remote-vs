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
import { EditorState, StateEffect, StateField, Compartment, type Extension } from '@codemirror/state'
import { Decoration, EditorView, highlightActiveLine, keymap, lineNumbers, type DecorationSet } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, ensureSyntaxTree, indentOnInput } from '@codemirror/language'
import { closeBrackets } from '@codemirror/autocomplete'
import { search } from '@codemirror/search'
import { syntaxHighlighting } from '@codemirror/language'
import { vscodeHighlightStyle } from './vsc/editor-palette.ts'
import { FindWidget, stepFind } from './vsc/FindWidget.tsx'
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

export interface CodeEditorHandle {
  getContent: () => string
  isDirty: () => boolean
  markSaved: () => void
}

/** Compartment holding the fallback highlighter (armed only when needed). */
const fallbackCompartment = new Compartment()

/** True while CodeMirror's own highlighter has produced token spans. */
function primaryColored(host: Element): boolean {
  return host.querySelector('[class*="rvs-ck-"]') !== null
}

// (The reveal state field + helper live in vsc/reveal-line.ts so the
// self-check harness can drive a jump without mounting the React component.)

import { langFor } from './vsc/editor-langs.ts'
import { canFallbackHighlight, fallbackHighlight } from './vsc/fallback-highlight.ts'
import { revealLine, revealLineField, setRevealLine } from './vsc/reveal-line.ts'

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
  /** Reports how many token spans the grammar produced (diagnostics). */
  onTokens?: (count: number) => void
  /**
   * Element the find widget is portalled into (the code-area box). Portalling
   * puts the widget OUTSIDE every scroller in the editor subtree, so no scroll
   * position can carry it off-screen.
   */
  overlayHost?: HTMLElement | null
  onSave: () => void
  onDirty: (dirty: boolean) => void
}>(function CodeEditor(props, ref) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | undefined>(undefined)
  const savedRef = useRef<string>(props.initial)
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
      return
    }
    const update = (): void => {
      const host = hostRef.current
      if (host === null) return
      const rect = host.getBoundingClientRect()
      setAnchor({
        top: Math.max(4, rect.top + 6),
        right: Math.max(8, window.innerWidth - rect.right + 18),
      })
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

  useImperativeHandle(ref, () => ({
    getContent: () => viewRef.current?.state.doc.toString() ?? savedRef.current,
    isDirty: () => dirtyRef.current,
    markSaved: () => {
      savedRef.current = viewRef.current?.state.doc.toString() ?? savedRef.current
      dirtyRef.current = false
      propsRef.current.onDirty(false)
    },
  }), [])

  // Shown again after being hidden: remeasure layout.
  useEffect(() => {
    if (props.visible === false) return
    viewRef.current?.requestMeasure()
  }, [props.visible])

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
      // Match highlighting only; the widget drives it.
      search({ top: true }),
      initialEditorTheme(),
      // Syntax highlighting, OUTSIDE the theme compartment: colors come from
      // fixed `rvs-ck-*` classes in vsc.css, so this never needs reconfiguring
      // and cannot be lost by a scheme flip.
      syntaxHighlighting(vscodeHighlightStyle()),
      // Fallback coloring, off until it is needed (see `armFallback`).
      fallbackCompartment.of([]),
      revealLineField,
      EditorView.lineWrapping,
      EditorState.readOnly.of(propsRef.current.readOnly === true),
      ...langFor(propsRef.current.path),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return
        const dirty = update.state.doc.toString() !== savedRef.current
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
    ]
    const view = new EditorView({
      doc: propsRef.current.initial,
      extensions,
      parent: host,
    })
    viewRef.current = view
    setView(view)
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
    // second reports what actually ended up on screen.
    window.setTimeout(armFallback, 250)
    // Warm the parser once so the file is never left MONOCHROME: Lezer
    // languages are highlighted from a syntax tree built by an idle-time
    // worker, and a busy main thread (the chat stream, say) can starve it
    // indefinitely. Forcing a bounded synchronous parse here costs a few
    // milliseconds and removes that whole failure mode. (The jump itself is
    // handled by the reveal effect below, which also covers re-jumps.)
    window.setTimeout(() => {
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
      popupRef.current.hide()
      unwatchTheme()
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
