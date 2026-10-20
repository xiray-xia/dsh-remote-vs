/**
 * Where "revert this change" points.
 *
 * The revert itself needs only `(alias, root, patch)`: `git apply -R` runs on the
 * host against the repository that owns the file, and its context check IS the
 * conflict guard — a hunk whose surroundings moved since the snapshot is
 * refused instead of overwriting whatever replaced it. Nothing about the
 * session is needed for that.
 *
 * A small module-level record is the honest shape here: the affordance is
 * rendered by the editor (which knows a buffer, not a workspace), while the
 * coordinates come from the change panel (which knows the session). One value at
 * a time is enough because the panel only ever lists changes of the session on
 * screen.
 */

/** Coordinates one revert needs, plus the session they were read for. */
export interface UndoContext {
  sessionId: string
  alias: string
  root: string
}

let current: UndoContext | undefined

/** Point the affordance at one session's remote workspace. */
export function setUndoContext(context: UndoContext | undefined): void {
  current = context
}

/** The coordinates a revert should use right now, if any. */
export function undoContext(): UndoContext | undefined {
  return current
}
