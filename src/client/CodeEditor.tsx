/**
 * CodeMirror 6 wrapper: one editor per mount (parent remounts via key when the
 * file changes). Content is pulled imperatively (no per-keystroke string
 * copies); dirty state is reported through onDirty.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from 'react'
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
  onSave: () => void
  onDirty: (dirty: boolean) => void
}>(function CodeEditor(props, ref) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | undefined>(undefined)
  const savedRef = useRef<string>(props.initial)
  const dirtyRef = useRef<boolean>(false)
  const propsRef = useRef(props)
  propsRef.current = props

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
    ]
    const view = new EditorView({
      doc: propsRef.current.initial,
      extensions,
      parent: host,
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = undefined
    }
    // Mount-once: the parent remounts (key) when the file identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div ref={hostRef} style={{ height: '100%', overflow: 'auto' }} />
})
