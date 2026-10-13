/**
 * CodeMirror 6 wrapper: one editor per mount (parent remounts via key when the
 * file changes). Content is pulled imperatively (no per-keystroke string
 * copies); dirty state is reported through onDirty. A non-empty selection
 * anchors the floating "add to conversation" button above its head (the
 * local viewer's twin — see selection-popup.ts); the payload is a fenced
 * `rel:lines` block inserted into the on-screen session's composer draft.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { closeBrackets } from '@codemirror/autocomplete'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { yaml } from '@codemirror/lang-yaml'
import { appendToDraft, buildRemoteSelectionInsert } from './composer.ts'
import { useSelectionPopup } from './selection-popup.ts'

export interface CodeEditorHandle {
  getContent: () => string
  isDirty: () => boolean
  markSaved: () => void
}

function langFor(path: string): Extension[] {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return [javascript()]
    case 'ts':
    case 'tsx':
    case 'mts':
      return [javascript({ typescript: true })]
    case 'py':
      return [python()]
    case 'json':
      return [json()]
    case 'md':
    case 'markdown':
      return [markdown()]
    case 'html':
    case 'htm':
    case 'vue':
      return [html()]
    case 'css':
      return [css()]
    case 'yaml':
    case 'yml':
      return [yaml()]
    default:
      return []
  }
}

const theme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'inherit', fontSize: '13px', height: '100%' },
  '.cm-content': { fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)' },
  '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid rgba(127,127,127,.25)', color: 'inherit', opacity: 0.7 },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(127,127,127,.15)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground': { backgroundColor: 'rgba(77,107,254,.3) !important' },
})

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
      ]),
      lineNumbers(),
      highlightActiveLine(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      syntaxHighlighting(defaultHighlightStyle),
      EditorView.lineWrapping,
      EditorState.readOnly.of(propsRef.current.readOnly === true),
      ...langFor(propsRef.current.path),
      theme,
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
    return () => {
      popupRef.current.hide()
      view.destroy()
      viewRef.current = undefined
    }
    // Mount-once: the parent remounts (key) when the file identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const popup = selectionPopup.popup
  return (
    <>
      <div ref={hostRef} style={{ height: '100%', overflow: 'auto' }} />
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
