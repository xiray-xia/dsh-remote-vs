/**
 * The "常用指令" panel above the terminal: a personal library of NAME + COMMAND
 * pairs that paste into the active terminal's command line WITHOUT pressing
 * Enter (misclick safety: the user still reviews and runs it).
 *
 * Why it is a popover rather than a dock: the terminal needs the whole column
 * for output; the list is opened deliberately, used once, and dismissed. The
 * panel is portaled with fixed coordinates so the terminal's own scroller and
 * the sidebar's `overflow: hidden` cannot clip it.
 *
 * Snapshot + subscribe come from `terminal-snippets.ts` (one list shared with the
 * Ctrl+B quick-add shortcut, which `XTerm` reports as a counter prop).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  addSnippet,
  moveSnippet,
  removeSnippet,
  snippetsSnapshot,
  subscribeSnippets,
  updateSnippet,
  updateSnippets,
  type TerminalSnippet,
} from './terminal-snippets.ts'
import { confirmDialog, focusables } from './vsc/kit.tsx'

/** Props of the panel (plus the button that opens it). */
export interface TerminalSnippetsProps {
  /** Translator. */
  t: (key: string) => string
  /** Insert one command into the active terminal; false when none is mounted. */
  onInsert: (command: string) => boolean
  /** Bumped by the Ctrl+B shortcut; each change opens the ADD dialog. */
  addRequest: number
  /**
   * Draft the Ctrl+B form starts with (the terminal selection, else the line
   * reconstructed from keystrokes). Empty for the panel's own "+" button.
   */
  addContent: string
}

/** Where the popover is anchored (viewport coordinates of the button). */
interface Anchor {
  left: number
  top: number
  width: number
}

/** What the form dialog is doing. */
type FormState = { mode: 'add'; content: string } | { mode: 'edit'; snippet: TerminalSnippet }

/** One row, identified for drag & drop. */
interface DragState {
  from: number
}

/**
 * The panel.
 *
 * Kept in one component on purpose: the button, the popover, the form and their
 * shared focus/dismissal rules are one interaction, and splitting them would
 * need a context for four pieces of state.
 */
export function TerminalSnippets(props: TerminalSnippetsProps): ReactNode {
  const t = props.t
  const items = useSyncExternalStore(subscribeSnippets, snippetsSnapshot, snippetsSnapshot)
  const [anchor, setAnchor] = useState<Anchor | undefined>(undefined)
  const [form, setForm] = useState<FormState | undefined>(undefined)
  const [drag, setDrag] = useState<DragState | undefined>(undefined)
  const [dropIndex, setDropIndex] = useState<number | undefined>(undefined)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  /** Latest `addRequest` already handled (the prop is a counter, not an event). */
  const handledAdd = useRef(props.addRequest)

  /** Open the panel under the button. */
  const openPanel = useCallback((): void => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect === undefined || rect === null) return
    setAnchor({ left: Math.max(4, rect.left), top: rect.bottom + 4, width: 300 })
  }, [])

  const closePanel = useCallback((): void => {
    setAnchor(undefined)
    setDrag(undefined)
    setDropIndex(undefined)
  }, [])

  /**
   * The open panel owns the keyboard.
   *
   * It is portaled to the END of `<body>`, so a keyboard user who opened it from
   * the ⚡ button otherwise had to Tab through the whole page to reach the first
   * row. The first command is where the user wants to be; an empty library
   * starts on the add button. Closing hands focus back to the trigger — but only
   * when the user did not already put it somewhere else (closing by clicking the
   * terminal must not steal the caret back).
   */
  useEffect(() => {
    if (anchor === undefined) return
    const panel = panelRef.current
    if (panel === null) return
    const first = panel.querySelector<HTMLElement>('.rvs-snips-insert') ?? focusables(panel)[0]
    first?.focus()
    return () => {
      const active = document.activeElement
      if (active === null || active === document.body || panelRef.current?.contains(active) === true) {
        buttonRef.current?.focus()
      }
    }
  }, [anchor])

  /**
   * List navigation inside the panel (audit I-9): ↑/↓ walk the command rows,
   * Enter is the focused row's native button activation (so it inserts), and Esc
   * is handled HERE, not on `document`: it used to be document-wide, so pressing
   * Esc in the terminal closed the panel while the shell received the same ESC.
   */
  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closePanel()
      return
    }
    // Alt+↑/↓ is the grip's reorder chord; leave it to the row.
    if (event.altKey) return
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const panel = panelRef.current
    if (panel === null) return
    const rows = Array.from(panel.querySelectorAll<HTMLElement>('.rvs-snips-insert'))
    if (rows.length === 0) return
    event.preventDefault()
    const at = rows.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'ArrowDown' ? (at + 1) % rows.length : (at <= 0 ? rows.length - 1 : at - 1)
    rows[next]?.focus()
  }

  // Ctrl+B from the terminal: open the ADD form (and the panel behind it) with
  // the draft the terminal handed over — selection first, else the typed line.
  useEffect(() => {
    if (props.addRequest === handledAdd.current) return
    handledAdd.current = props.addRequest
    openPanel()
    setForm({ mode: 'add', content: props.addContent })
  }, [props.addRequest, props.addContent, openPanel])

  // Close on outside click / window resize (a fixed popover would be left
  // pointing at nothing). Capture phase so xterm's own mousedown cannot refocus
  // the terminal first, which would make the panel look unclosable. Esc lives on
  // the panel itself (see `onPanelKeyDown`): the keystroke must not be taken from
  // the shell.
  useEffect(() => {
    if (anchor === undefined) return
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (panelRef.current?.contains(target) === true) return
      if (buttonRef.current?.contains(target) === true) return
      closePanel()
    }
    const onResize = (): void => closePanel()
    /**
     * Esc while the focus is anywhere EXCEPT the panel.
     *
     * The panel handles its own Esc when it has focus (`onPanelKeyDown`), but it
     * can be visibly open while the focus sits elsewhere (clicking its title or
     * scrolling it leaves the activeElement outside) — the old document-level
     * handler closed it from anywhere. Restore that, but never steal Esc from
     * the shell: a focus inside `.xterm` means the key belongs to the terminal.
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const active = document.activeElement
      if (active instanceof Node && panelRef.current?.contains(active) === true) return
      if (active instanceof Element && active.closest('.xterm') !== null) return
      closePanel()
    }
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onResize)
    }
  }, [anchor, closePanel])

  /** Paste one command and get out of the way. */
  const insert = (snippet: TerminalSnippet): void => {
    if (!props.onInsert(snippet.command)) {
      // No mounted terminal for the active tab: the caller says so; the panel
      // stays open so the click can be retried.
      window.setTimeout(() => { setForm(undefined) }, 0)
      return
    }
    closePanel()
  }

  const requestDelete = (snippet: TerminalSnippet): void => {
    void confirmDialog({
      title: t('term.snippetDeleteTitle'),
      text: snippet.name,
      danger: true,
      okText: t('term.snippetDelete'),
    }).then((ok) => {
      if (ok) updateSnippets(list => removeSnippet(list, snippet.id))
    })
  }

  /** Move one row by keyboard (Alt+Arrow) — the accessible twin of dragging. */
  const moveBy = (index: number, direction: -1 | 1): void => {
    updateSnippets(list => moveSnippet(list, index, index + direction))
  }

  const panel = anchor === undefined
    ? undefined
    : createPortal(
      <div
        ref={panelRef}
        className="rvs-portal rvs-snips-panel"
        role="dialog"
        aria-label={t('term.snippets')}
        onKeyDown={onPanelKeyDown}
        style={{ left: `${anchor.left}px`, top: `${anchor.top}px`, width: `${anchor.width}px` }}
      >
        <div className="rvs-snips-head">
          <span className="rvs-snips-title">⚡ {t('term.snippets')}</span>
          <span className="rvs-snips-spacer" />
          <button
            type="button"
            className="rvs-snips-add"
            title={t('term.snippetAdd')}
            aria-label={t('term.snippetAdd')}
            onClick={() => setForm({ mode: 'add', content: '' })}
          >+</button>
        </div>
        <div className="rvs-snips-list">
          {items.length === 0 && (
            <div className="rvs-snips-empty">{t('term.snippetEmpty')}</div>
          )}
          {items.map((snippet, index) => (
            <div
              key={snippet.id}
              className={`rvs-snips-row${dropIndex === index && drag !== undefined ? ' drop' : ''}`}
              draggable
              onDragStart={(event) => {
                setDrag({ from: index })
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', String(index))
              }}
              onDragOver={(event) => {
                if (drag === undefined) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setDropIndex(index)
              }}
              onDrop={(event) => {
                event.preventDefault()
                const from = Number(event.dataTransfer.getData('text/plain'))
                setDrag(undefined)
                setDropIndex(undefined)
                if (Number.isFinite(from)) updateSnippets(list => moveSnippet(list, from, index))
              }}
              onDragEnd={() => { setDrag(undefined); setDropIndex(undefined) }}
            >
              <span
                className="rvs-snips-grip"
                title={t('term.snippetDragHint')}
                role="button"
                aria-label={t('term.snippetDragHint')}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); moveBy(index, -1) }
                  if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); moveBy(index, 1) }
                }}
              >⠿</span>
              <button
                type="button"
                className="rvs-snips-insert"
                title={`${t('term.snippetInsertHint')}\n${snippet.command}`}
                onClick={() => insert(snippet)}
              >
                <span className="rvs-snips-name">{snippet.name}</span>
                <span className="rvs-snips-arrow" aria-hidden="true">--&gt;</span>
                <span className="rvs-snips-text">{snippet.command}</span>
              </button>
              <button
                type="button"
                className="rvs-snips-icon"
                title={t('term.snippetEdit')}
                aria-label={t('term.snippetEdit')}
                onClick={() => setForm({ mode: 'edit', snippet })}
              >✎</button>
              <button
                type="button"
                className="rvs-snips-icon danger"
                title={t('term.snippetDelete')}
                aria-label={t('term.snippetDelete')}
                onClick={() => requestDelete(snippet)}
              >×</button>
            </div>
          ))}
        </div>
        <div className="rvs-snips-foot">{t('term.snippetFootHint')}</div>
      </div>,
      document.body,
    )

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="rvs-hbtn rvs-snips-btn"
        title={t('term.snippets')}
        aria-label={t('term.snippets')}
        onClick={() => { if (anchor === undefined) openPanel(); else closePanel() }}
      >
        <span aria-hidden="true">⚡</span> {t('term.snippets')}
      </button>
      {panel}
      {form !== undefined && (
        <SnippetForm
          t={t}
          mode={form.mode}
          {...(form.mode === 'edit' ? { snippet: form.snippet } : { initialCommand: form.content })}
          onCancel={() => setForm(undefined)}
          onSubmit={(input) => {
            if (form.mode === 'add') {
              updateSnippets(list => addSnippet(list, input))
            } else {
              updateSnippets(list => updateSnippet(list, form.snippet.id, input))
            }
            setForm(undefined)
            closePanel()
          }}
        />
      )}
    </>
  )
}

/** The add / edit form (name + command), portaled like the shared dialogs. */
function SnippetForm(props: {
  t: (key: string) => string
  mode: 'add' | 'edit'
  snippet?: TerminalSnippet
  /** Draft for a NEW snippet (Ctrl+B hands over the selection / typed line). */
  initialCommand?: string
  onCancel: () => void
  onSubmit: (input: { name: string; command: string }) => void
}): ReactNode {
  const t = props.t
  const [name, setName] = useState(props.snippet?.name ?? '')
  const [command, setCommand] = useState(props.snippet?.command ?? props.initialCommand ?? '')
  const [error, setError] = useState<string | undefined>(undefined)
  const nameRef = useRef<HTMLInputElement>(null)
  const openerRef = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null)

  useEffect(() => {
    nameRef.current?.focus()
    nameRef.current?.select()
    return () => {
      const opener = openerRef.current
      if (opener !== null && document.body.contains(opener)) opener.focus()
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      if (event.key === 'Escape') {
        event.preventDefault()
        props.onCancel()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [props])

  const submit = (): void => {
    if (name.trim() === '') { setError(t('term.snippetNameRequired')); return }
    if (command.trim() === '') { setError(t('term.snippetCommandRequired')); return }
    props.onSubmit({ name, command })
  }

  return createPortal(
    <div className="rvs-portal rvs-modal-mask" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onCancel() }}>
      <div className="rvs-modal-box" role="dialog" aria-modal="true" aria-label={props.mode === 'add' ? t('term.snippetAdd') : t('term.snippetEdit')}>
        <div className="rvs-modal-title">{props.mode === 'add' ? t('term.snippetAdd') : t('term.snippetEdit')}</div>
        <label className="rvs-snips-field">
          <span>{t('term.snippetName')}</span>
          <input
            ref={nameRef}
            value={name}
            placeholder={t('term.snippetNamePlaceholder')}
            onChange={(event) => { setName(event.target.value); setError(undefined) }}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); submit() } }}
          />
        </label>
        <label className="rvs-snips-field">
          <span>{t('term.snippetCommand')}</span>
          <textarea
            className="rvs-snips-command"
            value={command}
            placeholder={t('term.snippetCommandPlaceholder')}
            rows={4}
            onChange={(event) => { setCommand(event.target.value); setError(undefined) }}
          />
        </label>
        {error !== undefined && <div className="rvs-snips-error" role="alert">{error}</div>}
        <div className="rvs-modal-row">
          <button type="button" className="rvs-modal-btn" onClick={props.onCancel}>{t('common.cancel')}</button>
          <button type="button" className="rvs-modal-btn primary" onClick={submit}>{t('common.save')}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
