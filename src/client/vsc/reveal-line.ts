/**
 * "Land here": the jump a search hit (or an `@`-reference) performs.
 *
 * Kept as one module-level helper because it has to work on an editor that is
 * ALREADY mounted — clicking a second hit in the same file must re-jump, not
 * silently do nothing (which is what a mount-only reveal does).
 */
import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'

/** Set (or clear) the landing highlight on one line. */
export const setRevealLine = StateEffect.define<number | null>()

/**
 * The landing highlight for a jump (search hit, `@` reference): without it a
 * jump into a long file leaves the caret in a wall of identical lines and the
 * user has to hunt for it.
 */
export const revealLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(setRevealLine)) continue
      next = effect.value === null
        ? Decoration.none
        : Decoration.set([Decoration.line({ class: 'rvs-reveal-line' }).range(effect.value)])
    }
    return next
  },
  provide: field => EditorView.decorations.from(field),
})

/** How long the landing highlight stays lit. */
const LIT_MS = 2600

/**
 * Scroll to a 1-based line, put the caret on it and light it up.
 *
 * Centering is done in TWO steps on purpose: CodeMirror scrolls its own
 * scroller, but the editor can also sit inside a taller ancestor scroller (the
 * panel height is not ours to control), and only `scrollIntoView` walks every
 * scrollable ancestor. Without the second step the line can land off-screen.
 */
export function revealLine(view: EditorView, target: number, lit: (position: number | null) => void): void {
  let line = 0
  try {
    const clamped = Math.min(Math.max(1, Math.round(target)), view.state.doc.lines)
    line = view.state.doc.line(clamped).number
    const from = view.state.doc.line(line).from
    view.dispatch({
      selection: { anchor: from },
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
    })
    lit(from)
  } catch {
    // A stale line number or a disposed view: nothing to reveal.
    return
  }
  view.focus()
  // Second step: centre the line in the *visible* area whatever scrolls.
  window.setTimeout(() => {
    try {
      const element = lineElement(view, line)
      element?.scrollIntoView({ block: 'center', inline: 'nearest' })
    } catch {
      // No layout: the CodeMirror scroll already did its best.
    }
  }, 30)
  window.setTimeout(() => {
    try {
      lit(null)
    } catch {
      // Disposed.
    }
  }, LIT_MS)
}

/** The rendered `.cm-line` element for a 1-based line number, if visible. */
function lineElement(view: EditorView, line: number): HTMLElement | null {
  const position = view.state.doc.line(line).from
  if (position < view.viewport.from || position > view.viewport.to) return null
  const dom = view.domAtPos(position)
  let node: Node | null = dom.node
  while (node !== null && node !== view.dom) {
    if (node instanceof HTMLElement && node.classList.contains('cm-line')) return node
    node = node.parentNode
  }
  return null
}
