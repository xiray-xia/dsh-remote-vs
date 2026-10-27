/**
 * The title one remote binding gets in DSH's own workspace sidebar.
 *
 * The sidebar (and the session grouping under it) is rendered by the shell from
 * the workspace REGISTRY, so this string is the only label the user ever sees
 * there. It used to be built from the remote PATH's last segment, which threw
 * away the one name the user had chosen: a workspace created as
 * "build_variant_a" showed up as `… > build`, and two bindings that differ only
 * deeper down (`…/userdebug/build_a` and `…/userdebug/build_a_fac`) became
 * indistinguishable.
 *
 * The alias stays in front: it is what tells two hosts apart, and the part after
 * it is what takes the workspace name.
 *
 * DISPLAY ONLY. The registry resolves a workspace by its canonical PATH
 * (`resolveByPath`) and its own documentation says the title is "used only when
 * a new record is created" and that different paths may share one — so a title
 * never decides routing, and none of the plugin's routing reads it.
 *
 * Pure and dependency-free, so `scripts/check-diff-ui.mjs` can pin it without a
 * host (the host half imports cordis and cannot load outside DSH).
 */

/** Last path segment of an absolute remote path ('' when the path is `/`). */
function pathBase(remotePath: string): string {
  const parts = remotePath.split('/').filter(part => part !== '')
  return parts.pop() ?? remotePath
}

/** The alias part of a title, with a readable fallback. */
function aliasOf(alias: string): string {
  return alias.trim() === '' ? 'remote' : alias.trim()
}

/**
 * The title this binding SHOULD have: `alias > workspace name`.
 *
 * @param binding - alias, the name the user typed, and the remote path.
 * @returns `alias > name`, falling back to the path's last segment when no name
 *   was given (bindings created before names existed, or an empty field).
 */
export function workspaceTitle(binding: { alias: string; name?: string; remotePath: string }): string {
  const named = (binding.name ?? '').trim()
  return `${aliasOf(binding.alias)} > ${named !== '' ? named : pathBase(binding.remotePath)}`
}

/**
 * The title the OLD code produced: `alias > <last path segment>`, name ignored.
 *
 * Kept so an existing registration can be retitled ONLY when its current title
 * is still exactly this. That is what keeps the upgrade from ever touching a
 * title the user renamed by hand in the shell's workspace settings.
 *
 * @param binding - alias and remote path; the name is deliberately unused.
 */
export function legacyWorkspaceTitle(binding: { alias: string; remotePath: string }): string {
  return `${aliasOf(binding.alias)} > ${pathBase(binding.remotePath)}`
}
