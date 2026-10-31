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
/** Wire protocol this plugin's `dsh-ssh` generation speaks (see MAINTENANCE §2.7). */
export declare const EXPECTED_HELPER_PROTOCOL = 2;
/** Absolute path of one cached helper tarball; throws when it is not inside the cache. */
export declare function helperTarballPath(helper: HelperCacheEntry, dir?: string): string;
/** Scan the local helper cache; invalid/incomplete entries are skipped. */
export declare function listCachedHelpers(dir?: string): HelperCacheEntry[];
/**
 * SemVer-ish comparison for cached helper versions.
 *
 * A plain string compare picked `0.9.0` over `0.10.0` (multi-digit segments sort
 * wrong: `9` > `10`) and the pipeline then pushed an OLD helper as "ok". Numeric
 * segments compare as numbers, everything else lexicographically; a shorter
 * version loses to its own extension (`0.2` < `0.2.1`) and a numeric segment wins
 * over a pre-release one (`0.2.1` > `0.2.1-alpha.2`).
 */
export declare function compareHelperVersions(left: string, right: string): number;
/**
 * Pick a cached build for a platform (exact version pin or newest).
 *
 * `expectedProtocol` (default: this plugin's wire protocol) is part of the
 * choice: a cached build whose protocol does not match would install fine and
 * then fail the runtime handshake, so it is not a candidate at all.
 */
export declare function pickCached(platform: string, version?: string, expectedProtocol?: number): HelperCacheEntry | undefined;
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
/** Paths of one helper install attempt (absolute, probe-derived + whitelisted version). */
export interface HelperInstallPaths {
    root: string;
    verDir: string;
    tmpFile: string;
}
/**
 * Remote shell steps installing one cached helper.
 *
 * Invariant: the currently installed version is never deleted before the new one
 * is fully extracted — the old dir is renamed to `.old` and removed only after
 * the swap, and a crash between "old moved away" and "new moved in" is repaired
 * by the recovery step (restore `.old` when the live dir is missing). Every path
 * goes through `shRoot`; the tarball name embedded in the sha256 line is quoted
 * too (the caller's version already passed `HELPER_VERSION_RE`, so it cannot
 * break out of the shell any more).
 *
 * Pure string work (no fs/pool) so a gate can pin the ORDER without a remote.
 */
export declare function helperInstallSteps(helper: HelperCacheEntry, paths: HelperInstallPaths): string[];
/** One POSIX shell line: steps joined so any failure stops the sequence. */
export declare function helperInstallScript(helper: HelperCacheEntry, paths: HelperInstallPaths): string;
