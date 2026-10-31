/**
 * The coordinates the editor's "revert this change" action uses.
 *
 * This module is the SLOT the store reads (`undoContext()`); it no longer decides
 * anything. The value is written by the change panel from the provenance of the
 * marks on screen — see `undo-target.ts`, which validates that the marks' session,
 * binding and root still describe the tab the user is looking at. When validation
 * fails the slot holds `undefined`, and the store's undo path refuses
 * (`changes.undoNoContext`) instead of guessing a repository.
 *
 * Historically the slot was "the last summary this panel saw", which could point
 * a revert at another conversation's — or a sibling binding's — repository. The
 * revert writes to the remote, so the coordinates now travel with the marks.
 */
import type { ChangeOrigin } from './undo-target.ts'

/** Coordinates one revert needs. Kept as the store's contract name. */
export type UndoContext = ChangeOrigin

let current: UndoContext | undefined

/** Publish the validated provenance for the tab currently on screen (or nothing). */
export function setUndoContext(context: UndoContext | undefined): void {
  current = context
}

/** The coordinates a revert should use right now, if any. */
export function undoContext(): UndoContext | undefined {
  return current
}
