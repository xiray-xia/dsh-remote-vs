/**
 * Hosts view: list + add/edit form + test + key bootstrap + push + import.
 *
 * The form also owns the host's 「网络出口」 (egress: proxy / jump host) block.
 * It is COLLAPSED by default, because most hosts go out directly and a wall of
 * empty proxy fields reads as "you must fill this in"; the collapsed row still
 * carries a read-only chip with the resulting route, so the answer to "how does
 * this host get out" never needs a click. The profile-wide default that
 * `跟随默认` resolves to lives in Settings (`SettingsHosts.tsx`).
 */
import { type ReactNode } from 'react';
import type { RemoteHostProxySetting, RemoteHostProxyView, RemoteHostSummary, RemoteProxyMode, RemoteProxySetting, RemoteProxySettingsView } from '../protocol.ts';
import { type HostForm } from './api.ts';
/** The translator shape this plugin's views pass around. */
type TFn = (key: string) => string;
/** Everything the egress controls edit, as form strings. */
export interface ProxyFormState {
    mode: RemoteProxyMode;
    kind: 'http' | 'socks5';
    host: string;
    port: string;
    username: string;
    password: string;
    viaAlias: string;
}
/** A blank draft: `跟随默认`, HTTP, no address (i.e. a fresh host). */
export declare function emptyProxyState(): ProxyFormState;
/**
 * Seed the controls from a stored (secret-free) host view.
 *
 * The password box stays EMPTY on purpose: the Host never echoes it back, and
 * `proxySettingOf` expresses "keep the stored one" by omitting the field, so an
 * untouched box cannot overwrite a working credential with an empty string.
 */
export declare function proxyStateOf(view: RemoteHostProxyView | undefined): ProxyFormState;
/** The profile default as a draft (it only knows `direct` / `proxy`). */
export declare function defaultProxyStateOf(view: RemoteProxySettingsView | undefined): ProxyFormState;
/**
 * The endpoint half of a proxy decision.
 *
 * An empty password is OMITTED (not sent as `''`): that is the contract for
 * "keep the stored secret", and it is the only reason the browser never has to
 * see the password at all.
 */
export declare function proxyTargetOf(state: ProxyFormState): RemoteProxySetting;
/**
 * The `proxy` field for one save, or `undefined` when it must be left out.
 *
 * `undefined` is the BACKWARD-COMPATIBLE answer: an old Host ignores the field,
 * and on create an absent value simply inherits the profile default. An UPDATE
 * that switches back to `跟随默认` is the one case an explicit
 * `{ mode: 'inherit' }` has to be sent, or the stored proxy would never clear.
 */
export declare function proxySettingOf(state: ProxyFormState): RemoteHostProxySetting | undefined;
/**
 * What stops a save: an unusable proxy endpoint, or no jump host picked.
 *
 * `jumpChoices` is the list of aliases the save can legally name (every stored
 * host except the one being edited). A stored jump host that has since been
 * deleted is NOT saveable — the Host refuses a `viaAlias` it does not know — so
 * the form has to say that in the user's language instead of forwarding a raw
 * `unknown host alias` rejection for a field nobody touched.
 */
export declare function proxyFormProblem(state: ProxyFormState, jumpChoices?: string[]): 'target' | 'jump' | 'jumpGone' | undefined;
/**
 * One line saying where traffic goes — the collapsed chip's text.
 *
 * `跟随默认` is resolved against the profile default when it is known: the whole
 * point of showing the chip while collapsed is that "follow the default" alone
 * does not tell the user whether that means direct or a proxy. An unknown
 * default (a Host without the route, or a failed read) degrades to the bare
 * phrase rather than guessing "direct".
 */
export declare function proxySummary(t: TFn, state: ProxyFormState, fallback: RemoteProxySettingsView | undefined): string;
/** One rendered chip: its word, its hover text, and whether it is a problem. */
export interface ProxyChipModel {
    mode: RemoteProxyMode;
    label: string;
    title: string;
    problem: boolean;
}
/**
 * The host ROW's chip: which way this host leaves the machine.
 *
 * Deliberately shorter than the form's summary (`代理`, not `经 HTTP 代理 h:p`) —
 * a list row has one line of room and the full route is the `title`. A refused
 * setting keeps its chip text and switches to the error colour, because the row
 * still has to say what was configured; `problem` explains why it cannot work.
 *
 * `fallback` is the profile-wide default, so a `跟随默认` row resolves to what it
 * actually does (the form's chip already does) — without it the row would say
 * "follow default" while the same host's form says "follow default (via …)". An
 * unknown default degrades to the bare phrase rather than guessing "direct".
 */
export declare function proxyChipOf(t: TFn, view: RemoteHostProxyView, fallback?: RemoteProxySettingsView): ProxyChipModel;
/** Read-only route chip (secondary outline, never a status colour). */
export declare function ProxyChip(props: {
    chip: ProxyChipModel;
}): ReactNode;
/**
 * Collapsible section header: a real `<button>` with `aria-expanded`.
 *
 * A `<details>` element was refused on purpose: its summary marker cannot be
 * restyled without vendor pseudo-elements and it gives no place for the chip.
 * A native button keeps Enter/Space, focus and the announced state for free.
 */
export declare function ProxySectionHeader(props: {
    open: boolean;
    label: string;
    expandLabel: string;
    collapseLabel: string;
    chip: ProxyChipModel;
    controls: string;
    onToggle: () => void;
}): ReactNode;
/**
 * The endpoint controls, shared by the per-host form and the profile default.
 *
 * Password semantics are identical in both places: `storedPassword` only
 * switches the placeholder, and an empty box is omitted from the payload.
 */
export declare function ProxyFields(props: {
    t: TFn;
    state: ProxyFormState;
    onChange: (next: ProxyFormState) => void;
    storedPassword: boolean;
    disabled?: boolean;
}): ReactNode;
export declare function HostFormView(props: {
    t: TFn;
    initial?: RemoteHostSummary;
    busy: boolean;
    /** Every stored host: the jump-host list (minus the one being edited). */
    hosts: RemoteHostSummary[];
    /** The profile-wide default, so `跟随默认` can be spelled out while collapsed. */
    proxyDefault?: RemoteProxySettingsView;
    onSave: (form: HostForm) => void;
    onCancel: () => void;
}): ReactNode;
export declare function HostsView(props: {
    t: TFn;
    hosts: RemoteHostSummary[];
    /** Profile-wide egress default, so `跟随默认` chips can be resolved. */
    proxyDefault?: RemoteProxySettingsView;
    onChanged: () => void;
}): ReactNode;
export {};
