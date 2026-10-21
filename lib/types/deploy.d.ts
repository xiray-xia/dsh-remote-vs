import type { RemotePool } from './pool.ts';
import type { RemoteStore } from './store.ts';
import type { HelperAvailability, HelperKind, RemoteDeployState, RemoteManifest, RemoteProbe } from './protocol.ts';
/** Versioned install root on the remote (outside any workspace). */
export declare const REMOTE_ROOT = "~/.dsh-helpers";
/** P0 artifact identity pushed by the pipeline. */
export declare const PROBE_ARTIFACT = "probe-bundle/0.1.0";
/**
 * Local retry ledger carried on the stored deploy record. `RemoteDeployState`
 * (protocol.ts) is the wire type the browser sees, so the ledger rides along
 * as extra optional fields instead of widening that contract. It has to be
 * part of every failure write: `store.setDeploy` replaces the whole record, so
 * a write that only listed status/artifact/detail/at would reset the counter
 * and make the backoff in `worlds.createRpc` unreachable after one retry.
 */
export interface DeployFailureLedger {
    /** When the latest attempt failed (ms). Absent while the last attempt succeeded. */
    failedAt?: number | undefined;
    /** Consecutive failed attempts since the last successful deploy. */
    attempts?: number | undefined;
}
/** A stored deploy record: the wire fields plus the local retry ledger. */
export type StoredDeployState = RemoteDeployState & DeployFailureLedger;
/** The failure ledger of one stored record, with the remaining automatic wait. */
export interface DeployFailure {
    attempts: number;
    /** Milliseconds left before the next automatic attempt (0 = retry now). */
    retryInMs: number;
}
/**
 * Read the retry ledger off a stored record. `undefined` means nothing is
 * known to have failed — a host that was never deployed, or whose last attempt
 * succeeded — so callers can tell that apart from "deployed and failed"; only
 * the latter has to wait. The `status` check keeps a ledger that survived a
 * hand-edited or legacy record from gating a record that no longer says failed.
 */
export declare function deployFailure(state: RemoteDeployState | undefined): DeployFailure | undefined;
/** Map uname output to a helper platform name. */
export declare function mapPlatform(unameS: string, unameM: string): string;
/** One cached helper build (a validated .helper.json sidecar + tarball). */
export interface HelperCacheEntry {
    kind: 'executable';
    version: string;
    platform: string;
    tarball: string;
    tarballSha256: string;
    /** sha256 of the dsh-ssh-helper binary (P2's helperHash). */
    binarySha256: string;
    protocol: number;
    nodeVersion: string;
}
/** Scan the local helper cache; invalid/incomplete entries are skipped. */
export declare function listCachedHelpers(dir?: string): HelperCacheEntry[];
/** Pick a cached build for a platform (exact version pin or newest). */
export declare function pickCached(platform: string, version?: string): HelperCacheEntry | undefined;
/** Honest availability of the helper channels. */
export declare function helperAvailability(): HelperAvailability[];
export declare function isHelperAvailable(kind: HelperKind): boolean;
/** This package's vendored helper seeds (`vendor/dsh-remote-helpers/`). */
export declare function vendorHelperDir(): string | undefined;
export interface SeedReport {
    seeded: string[];
    skipped: string[];
    failed: string[];
    vendorMissing: boolean;
}
/**
 * Seed the local helper cache from the vendored copies shipped with the
 * plugin, so a fresh install can push without manual staging. Copy-if-absent
 * only — never overwrites (a newer/different local build always wins);
 * tarballs are hash-verified after copy. Best-effort: throws nothing.
 */
export declare function seedHelperCache(): SeedReport;
/** Probe one host's OS/arch/node/home. */
export declare function probe(pool: RemotePool, alias: string): Promise<RemoteProbe>;
/** Read the installed remote manifest, or null when absent/invalid. */
export declare function readRemoteManifest(pool: RemotePool, alias: string): Promise<RemoteManifest | null>;
export interface PushReport {
    alias: string;
    probe: RemoteProbe;
    action: 'pushed' | 'skipped-same' | 'failed';
    previous: RemoteManifest | null;
    installed: RemoteManifest | null;
    detail: string;
}
export interface PushOptions {
    /** Pin an exact helper version; default resolves the newest cached build. */
    version?: string;
}
/**
 * Run the version-aware push: probe -> resolve helper (or probe-bundle
 * fallback) -> compare -> skip or push -> write back.
 */
export declare function pushPipeline(pool: RemotePool, store: RemoteStore, alias: string, opts?: PushOptions): Promise<PushReport>;
