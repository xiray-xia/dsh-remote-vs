/**
 * Fallback syntax coloring for the editor.
 *
 * The primary highlighter is CodeMirror's: a grammar builds a syntax tree in
 * idle time and `syntaxHighlighting` turns its tags into decorated spans. When
 * that chain does not produce decorations, a file renders MONOCHROME — and the
 * symptom is indistinguishable from a missing grammar, which is exactly the
 * dead end this module removes.
 *
 * The fallback paints the SAME token classes the diff panes already use
 * (`rvs-t-*`, via the line tokenizer in `tokenize.ts`), so it needs nothing from
 * the tree pipeline: no grammar, no idle-time parse, no generated class names.
 * It is engaged only when the primary highlighter produced nothing, and only for
 * the visible lines, so the cost is bounded by the viewport.
 */
import { RangeSetBuilder, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import { LineTokenCache, langFromPath } from './tokenize.ts'

/** Marks are cached per kind: decorations are immutable and reusable. */
const markCache = new Map<string, Decoration>()

function markFor(kind: string): Decoration {
  let mark = markCache.get(kind)
  if (mark === undefined) {
    mark = Decoration.mark({ class: `rvs-t-${kind}` })
    markCache.set(kind, mark)
  }
  return mark
}

/**
 * Minimum interval between two "is the primary highlighter coloring yet?"
 * probes, in ms.
 *
 * The probe (`CodeEditor` passes `host.querySelector('[class*="rvs-ck-"]')`) is
 * a linear walk of the editor's DOM, and the state it is asked about is
 * precisely the state where it MISSES — an attribute substring selector takes
 * no class fast path, so it visits every node to find nothing. It used to run
 * on every view update, i.e. once per scrolled frame. 12 probes a second still
 * notices the primary highlighter taking over within a frame or two of one of
 * them, and scrolling stops paying for it 60 times a second.
 */
const PROBE_INTERVAL_MS = 80

/**
 * Token colors for one editor.
 *
 * @param path - the file path (its extension selects the tokenizer language).
 * @param isPrimaryColoring - reports whether CodeMirror's highlighter has
 *   meanwhile produced spans; while it has, this plugin stays idle.
 */
export function fallbackHighlight(path: string, isPrimaryColoring: () => boolean): Extension {
  const lang = langFromPath(path)

  class FallbackHighlighter {
    decorations = Decoration.none
    /**
     * Incremental line cache (`tokenize.ts`).
     *
     * This used to be `tokenizeDocument(doc.toString())` on every keystroke:
     * a whole-document string plus one array per line, allocated again for
     * every key, on exactly the large files the fallback exists for (it is
     * armed when the grammar failed to paint, which is where files are big
     * and slow). The cache re-tokenizes only the edited region.
     */
    private readonly cache = new LineTokenCache(lang)
    private readonly view: EditorView
    /**
     * Last probe result, and once it is TRUE the probe is never made again.
     *
     * `primary` flipping true is a one-way door: the grammar that has produced
     * spans does not stop producing them, so there is nothing left to watch
     * for. That is what bounds the per-frame `querySelector` to a handful per
     * second and then to zero — while the fallback is engaged, the interesting
     * transitions are "the primary highlighter turned on" (probe) and "the
     * document changed" (rebuild), and only the first one needs the DOM.
     */
    private primary = false
    private probedAt = 0

    constructor(view: EditorView) {
      this.view = view
      this.rebuild()
    }

    update(update: { docChanged: boolean; viewportChanged: boolean }): void {
      if (this.primary) return
      // The probe decides whether ANY work happens, so it is gated first and
      // gated in time: a document change is worth an immediate check (the
      // grammar re-parses on edits), a viewport change is not — the handoff
      // arrives with the idle parse, which no amount of scrolling brings
      // closer.
      const now = Date.now()
      const probe = update.docChanged || now - this.probedAt >= PROBE_INTERVAL_MS
      if (probe) {
        this.probedAt = now
        this.primary = isPrimaryColoring()
        if (this.primary) {
          if (this.decorations !== Decoration.none) this.decorations = Decoration.none
          return
        }
      }
      if (update.docChanged || update.viewportChanged) this.rebuild()
    }

    /** Repaint the visible lines. Callers have already ruled out `primary`. */
    private rebuild(): void {
      const doc = this.view.state.doc
      this.cache.refresh(doc)
      const cache = this.cache.tokens
      if (cache.length === 0) {
        this.decorations = Decoration.none
        return
      }
      const builder = new RangeSetBuilder<Decoration>()
      for (const range of this.view.visibleRanges) {
        const first = doc.lineAt(range.from).number
        const last = doc.lineAt(range.to).number
        for (let number = first; number <= last && number <= cache.length; number += 1) {
          const line = doc.line(number)
          const tokens = cache[number - 1] ?? []
          let offset = line.from
          for (const token of tokens) {
            const length = token.text.length
            if (token.kind !== 'plain' && length > 0 && offset + length <= line.to) {
              builder.add(offset, offset + length, markFor(token.kind))
            }
            offset += length
          }
        }
      }
      this.decorations = builder.finish()
    }
  }

  return ViewPlugin.fromClass(FallbackHighlighter, {
    decorations: value => value.decorations,
  })
}

/** True when the tokenizer has a language for this path at all. */
export function canFallbackHighlight(path: string): boolean {
  return langFromPath(path) !== undefined
}
