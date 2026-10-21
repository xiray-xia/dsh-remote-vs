/**
 * Reveal the plugin's conversation view tab (对话 / 轨迹 / …).
 *
 * The editor lives in a `conversation.view` slot, and the shell renders ONLY
 * the selected view — there is no public service to select one (the shell's
 * own header owns `selectView`). So when a file or diff is opened from the
 * sidebar while that editor tab is not the active view, the plugin asks the
 * shell's tab by clicking it, exactly as a user would.
 *
 * This is intentionally defensive: the lookup is label-based, skips our own
 * surfaces, and a miss is reported to the caller (which then tells the user
 * where the file opened) rather than throwing.
 */
/** Click the conversation-view tab whose label matches, if it is on screen. */
export declare function revealViewTab(label: string): boolean;
