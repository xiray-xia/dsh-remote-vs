/**
 * "Land here": the jump a search hit (or an `@`-reference) performs.
 *
 * Kept as one module-level helper because it has to work on an editor that is
 * ALREADY mounted — clicking a second hit in the same file must re-jump, not
 * silently do nothing (which is what a mount-only reveal does).
 */
import { StateField } from '@codemirror/state';
import { EditorView, type DecorationSet } from '@codemirror/view';
/** Set (or clear) the landing highlight on one line. */
export declare const setRevealLine: import("@codemirror/state").StateEffectType<number | null>;
/**
 * The landing highlight for a jump (search hit, `@` reference): without it a
 * jump into a long file leaves the caret in a wall of identical lines and the
 * user has to hunt for it.
 */
export declare const revealLineField: StateField<DecorationSet>;
/**
 * Scroll to a 1-based line, put the caret on it and light it up.
 *
 * Centering is done in TWO steps on purpose: CodeMirror scrolls its own
 * scroller, but the editor can also sit inside a taller ancestor scroller (the
 * panel height is not ours to control), and only `scrollIntoView` walks every
 * scrollable ancestor. Without the second step the line can land off-screen.
 */
export declare function revealLine(view: EditorView, target: number, lit: (position: number | null) => void): void;
/**
 * 选中一个行区间并把它带到视野中央（「上一个/下一个改动点」用）。
 *
 * 与 `revealLine` 的差别只有两点：用 `EditorSelection.range` 把整段选起来（一个
 * 改动块常常有好几行，只放一个 caret 看不出这次改动有多大），以及**不**点灯 —
 * 改动块本身已经有自己的绿/红背景，再叠一层 landing 蓝只会糊成第三种颜色。
 *
 * `from` / `to` 都是 **1-based 行号**（与 `revealLine` 同一套语义），越界夹到文件
 * 首尾，`from > to` 时自动对调。`lit` 与 `revealLine` 同义，给那些需要额外提示
 * 的调用方留口子（传 null 收灯，`LIT_MS` 后自动熄灭）。
 */
export declare function revealRange(view: EditorView, from: number, to: number, lit?: (position: number | null) => void): void;
