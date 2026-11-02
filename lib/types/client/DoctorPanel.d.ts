/**
 * Remote environment doctor panel: one screen of evidence about the host the
 * workspace lives on, plus "copy all" as plain text.
 *
 * Rendered as a fixed overlay (like the input dialog) instead of joining the
 * host list: the list lives in the DSH Settings dialog, and pushing it around
 * while the first paint of a probe is still in flight would be worse than a
 * layer on top of it.
 *
 * The run lives here, not in `HostsView`: the panel is mounted for exactly the
 * lifetime of one report (the host row supplies `key={alias}`), so an unmount
 * closes the door on a late answer instead of writing into the list. A second
 * mount for the same alias joins the in-flight probe rather than spending
 * another channel slot.
 *
 * Three states, one of which is `unknown` — see `doctor.ts`: an unanswered
 * probe is never rendered as "not installed"; the hint line under the table
 * says what "unknown" means so nobody reads a blank as a pass.
 */
import { type ReactNode } from 'react';
export declare function DoctorPanel(props: {
    t: (key: string) => string;
    alias: string;
    onClose: () => void;
}): ReactNode;
