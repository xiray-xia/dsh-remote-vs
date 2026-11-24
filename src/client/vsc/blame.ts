/**
 * Inline blame gutter for the CodeMirror editor.
 *
 * The data is fetched by the editor pane (one `-L` window at a time) and handed
 * in as a line→commit map; this module only paints it. Keeping the fetch out of
 * here is deliberate: the same model is used by the gate without CodeMirror,
 * and a scroll must not be able to start a request from inside a gutter
 * callback.
 */
import {
  RangeSetBuilder,
  type Extension,
  type RangeSet,
} from '@codemirror/state'
import {
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutter,
  type ViewUpdate,
} from '@codemirror/view'
import { blameLabel, blameRuns, blameTitle, isCommittedBlame, type BlameLine } from '../blame-model.ts'

/** One gutter cell's label; `null` text means "same commit as the line above". */
class BlameMarker extends GutterMarker {
  constructor(
    private readonly text: string,
    private readonly title: string,
    private readonly committed: boolean,
  ) {
    super()
  }

  override toDOM(): HTMLElement {
    const node = document.createElement('span')
    node.className = this.text === ''
      ? 'rvs-blame-cont'
      : `rvs-blame-chip${this.committed ? '' : ' rvs-blame-uncommitted'}`
    node.textContent = this.text
    if (this.title !== '') node.title = this.title
    return node
  }

  override eq(other: GutterMarker): boolean {
    return other instanceof BlameMarker && other.text === this.text && other.title === this.title
  }
}

const EMPTY = new RangeSetBuilder<GutterMarker>().finish()

/** Fixed spacer: keeps the gutter from jumping between files. */
class SpacerMarker extends GutterMarker {
  override toDOM(): HTMLElement {
    const node = document.createElement('span')
    node.className = 'rvs-blame-spacer'
    node.textContent = 'author · 00y'
    return node
  }
}

const SPACER = new SpacerMarker()

/** Viewport-only markers; the gutter itself only renders visible lines. */
function viewportMarkers(
  view: EditorView,
  entries: ReadonlyMap<number, BlameLine>,
  nowSeconds: number,
): RangeSet<GutterMarker> {
  const doc = view.state.doc
  const first = Math.max(1, doc.lineAt(view.viewport.from).number)
  const last = Math.min(doc.lines, doc.lineAt(view.viewport.to).number)
  if (entries.size === 0 || last < first) return EMPTY
  const runStarts = new Set(
    blameRuns([...entries.values()].sort((left, right) => left.line - right.line)).map(run => run.from),
  )
  const builder = new RangeSetBuilder<GutterMarker>()
  for (let number = first; number <= last; number += 1) {
    const entry = entries.get(number)
    if (entry === undefined) continue
    const sameAsAbove = !runStarts.has(number)
    const marker = sameAsAbove
      ? new BlameMarker('', '', true)
      : new BlameMarker(blameLabel(entry, nowSeconds), blameTitle(entry), isCommittedBlame(entry.hash))
    const line = doc.line(number)
    builder.add(line.from, line.to, marker)
  }
  return builder.finish()
}

/** Fire `report` when the viewport (or the document) changes. */
function viewportReporter(report: (first: number, last: number) => void): Extension {
  const emit = (view: EditorView): void => {
    const doc = view.state.doc
    report(doc.lineAt(view.viewport.from).number, doc.lineAt(view.viewport.to).number)
  }
  return ViewPlugin.fromClass(class {
    constructor(view: EditorView) {
      // A freshly mounted editor gets no update event: report the first
      // viewport here, or the pane would never fetch any blame until scroll.
      emit(view)
    }

    update(update: ViewUpdate): void {
      if (!update.viewportChanged && !update.docChanged) return
      emit(update.view)
    }
  })
}

/**
 * Build the gutter extension. Rebuilt by the editor's compartment whenever a
 * blame window lands; `nowSeconds` is pinned so every cell in one render has
 * the same clock.
 */
export function blameExtension(
  entries: ReadonlyMap<number, BlameLine>,
  onOpen?: (entry: BlameLine) => void,
): Extension {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const activate = (view: EditorView, line: { from: number }, event: Event): boolean => {
    const number = view.state.doc.lineAt(line.from).number
    const entry = entries.get(number)
    if (entry === undefined || !isCommittedBlame(entry.hash)) return false
    event.preventDefault()
    onOpen?.(entry)
    return true
  }
  return [
    gutter({
      class: 'rvs-blame-gutter',
      markers: view => viewportMarkers(view, entries, nowSeconds),
      initialSpacer: () => SPACER,
      domEventHandlers: onOpen === undefined
        ? {}
        : {
            mousedown(view, line, event) {
              return activate(view, line, event)
            },
          },
    }),
  ]
}

/** Internal export for the editor to forward viewport changes. */
export function blameViewportReporter(report: (first: number, last: number) => void): Extension {
  return viewportReporter(report)
}
