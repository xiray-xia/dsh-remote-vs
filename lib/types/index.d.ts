/**
 * dsh-remote-vs — host half. Mounts the remote store ($DSH_HOME/dsh-remote.json),
 * the ssh2 connection pool, the /api/dsh-remote route family plus the terminal
 * WebSocket upgrade, the agent tools (remote_hosts, remote_exec, remote_ls,
 * remote_read, remote_write), an optional system-prompt announcement, a
 * per-session remote workspace-mapping context, and the P2
 * transparent-routing world manager (remoteWorlds service + kill-switch).
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type RoutingMode } from './p2/worlds.ts';
/** Stable cordis plugin name. */
export declare const name = "remote-vs";
/**
 * Services required before the remote surfaces can mount. MINIMAL ON PURPOSE
 * (2026-10-13 deadlock lesson): our routers REPLACE fs/subprocess/spillStore
 * at root, so anything downstream of them (workingDirectory, agents, …)
 * transitively waits on us — declaring them here cycles the whole Host
 * (remote-vs → workingDirectory → fs-router → remoteWorlds → remote-vs).
 * Every other service is read SOFT via ctx.get() at call time (the
 * tool-bash pattern: no startup wait, no throw, undefined when absent).
 */
export declare const inject: string[];
declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * Volatile config values were committed into the running instance without a
         * remount (cordis-plugin-loader); dispatched to the owning fiber only.
         */
        'loader/volatile-update'(paths: readonly (readonly string[])[]): void;
    }
}
/** Plugin config as a profile patch declares it, before schema resolution. */
export interface Config {
    /** Announce the remote tools to every agent (default false, keeps prompts clean). */
    announceToAgent?: boolean;
    /** Master switch for the plugin (routes, tools, prompt section). */
    enabled?: boolean;
    /**
     * P2 transparent-routing kill-switch: off = pure local passthrough;
     * shadow = log remote decisions but execute locally; enforce = route.
     */
    routingMode?: RoutingMode;
    /** Per-command timeout for git work on a remote host (ms). */
    gitTimeoutMs?: number;
    /** Per-read timeout for remote file reads (ms). */
    readTimeoutMs?: number;
}
/** The stable reference a `volatile()` config field resolves to. */
interface ConfigRef<T> {
    get(): T;
}
type ConfigField<T> = ConfigRef<T> | T;
/** The config the Host hands to {@link apply}. */
export interface ResolvedConfig {
    announceToAgent?: ConfigField<boolean>;
    enabled?: ConfigField<boolean>;
    routingMode?: ConfigField<RoutingMode>;
    gitTimeoutMs?: ConfigField<number>;
    readTimeoutMs?: ConfigField<number>;
}
/**
 * Plugin config schema. Under the 0.1.7 settings model this schema IS the
 * entry's settings page; every field is `volatile()` so edits reach the
 * running instance without a remount.
 *
 * The two timeout fields exist because "large project" is host-specific: a cold
 * `git status` on a big monorepo outlived the old fixed 45 s client deadline,
 * so the limit is a setting rather than a constant. Both are clamped into
 * [MIN_TIMEOUT_MS, MAX_TIMEOUT_MS] (see `timeouts.ts`) on every read, so a bad
 * value degrades to the default instead of disabling the explorer.
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    announceToAgent: z<boolean, boolean, "volatile-defined">;
    enabled: z<boolean, boolean, "volatile-defined">;
    routingMode: z<"off" | "shadow" | "enforce", "off" | "shadow" | "enforce", "volatile-defined">;
    gitTimeoutMs: z<number, number, "volatile-defined">;
    readTimeoutMs: z<number, number, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    announceToAgent: z<boolean, boolean, "volatile-defined">;
    enabled: z<boolean, boolean, "volatile-defined">;
    routingMode: z<"off" | "shadow" | "enforce", "off" | "shadow" | "enforce", "volatile-defined">;
    gitTimeoutMs: z<number, number, "volatile-defined">;
    readTimeoutMs: z<number, number, "volatile-defined">;
}>>, "plain">;
export declare function apply(ctx: Context, config?: ResolvedConfig): void;
export {};
