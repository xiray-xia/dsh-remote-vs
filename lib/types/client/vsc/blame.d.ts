/**
 * Inline blame gutter for the CodeMirror editor.
 *
 * The data is fetched by the editor pane (one `-L` window at a time) and handed
 * in as a line→commit map; this module only paints it. Keeping the fetch out of
 * here is deliberate: the same model is used by the gate without CodeMirror,
 * and a scroll must not be able to start a request from inside a gutter
 * callback.
 */
import { type Extension } from '@codemirror/state';
import { type BlameLine } from '../blame-model.ts';
/**
 * Build the gutter extension. Rebuilt by the editor's compartment whenever a
 * blame window lands; `nowSeconds` is pinned so every cell in one render has
 * the same clock.
 */
export declare function blameExtension(entries: ReadonlyMap<number, BlameLine>, onOpen?: (entry: BlameLine) => void): Extension;
/** Internal export for the editor to forward viewport changes. */
export declare function blameViewportReporter(report: (first: number, last: number) => void): Extension;
