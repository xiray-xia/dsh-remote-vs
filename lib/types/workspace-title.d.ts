/**
 * The title one remote binding gets in DSH's own workspace sidebar.
 *
 * The sidebar (and the session grouping under it) is rendered by the shell from
 * the workspace REGISTRY, so this string is the only label the user ever sees
 * there. It used to be built from the remote PATH's last segment, which threw
 * away the one name the user had chosen: a workspace created as
 * "P710_userdebug" showed up as `… > P710`, and two bindings that differ only
 * deeper down (`…/userdebug/P710` and `…/userdebug/P710_fac`) became
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
/**
 * The title this binding SHOULD have: `alias > workspace name`.
 *
 * @param binding - alias, the name the user typed, and the remote path.
 * @returns `alias > name`, falling back to the path's last segment when no name
 *   was given (bindings created before names existed, or an empty field).
 */
export declare function workspaceTitle(binding: {
    alias: string;
    name?: string;
    remotePath: string;
}): string;
/**
 * The title the OLD code produced: `alias > <last path segment>`, name ignored.
 *
 * Kept so an existing registration can be retitled ONLY when its current title
 * is still exactly this. That is what keeps the upgrade from ever touching a
 * title the user renamed by hand in the shell's workspace settings.
 *
 * @param binding - alias and remote path; the name is deliberately unused.
 */
export declare function legacyWorkspaceTitle(binding: {
    alias: string;
    remotePath: string;
}): string;
