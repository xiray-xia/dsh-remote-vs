/**
 * Deploy pipeline: probe the remote (arch/os/libc/node/home), compare the
 * installed ~/.dsh-helpers/manifest.json against the local expectation, skip
 * when identical, otherwise push and write back.
 *
 * P1: the executable channel serves self-built helper tarballs from the local
 * cache ($DSH_HOME/dsh-remote-helpers/*.helper.json + *.tar.gz). With no
 * cached build for the probed platform, the pipeline falls back to the
 * probe-bundle marker (P0 behavior).
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, posix, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RemotePool } from './pool.ts'
import { RemoteFiles } from './sftp.ts'
import type { RemoteStore } from './store.ts'
import { helpersDir } from './paths.ts'
import type {
  HelperAvailability,
  HelperKind,
  RemoteDeployState,
  RemoteManifest,
  RemoteProbe,
} from './protocol.ts'

/** Versioned install root on the remote (outside any workspace). */
export const REMOTE_ROOT = '~/.dsh-helpers'

/** P0 artifact identity pushed by the pipeline. */
export const PROBE_ARTIFACT = 'probe-bundle/0.1.0'

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
  failedAt?: number | undefined
  /** Consecutive failed attempts since the last successful deploy. */
  attempts?: number | undefined
}

/** A stored deploy record: the wire fields plus the local retry ledger. */
export type StoredDeployState = RemoteDeployState & DeployFailureLedger

/** Retry backoff after a failed deploy: doubling from 5s, capped at 5 minutes. */
const DEPLOY_RETRY_BASE_MS = 5_000
const DEPLOY_RETRY_CAP_MS = 300_000

/** The failure ledger of one stored record, with the remaining automatic wait. */
export interface DeployFailure {
  attempts: number
  /** Milliseconds left before the next automatic attempt (0 = retry now). */
  retryInMs: number
}

/**
 * Read the retry ledger off a stored record. `undefined` means nothing is
 * known to have failed — a host that was never deployed, or whose last attempt
 * succeeded — so callers can tell that apart from "deployed and failed"; only
 * the latter has to wait. The `status` check keeps a ledger that survived a
 * hand-edited or legacy record from gating a record that no longer says failed.
 */
export function deployFailure(state: RemoteDeployState | undefined): DeployFailure | undefined {
  const ledger = state as StoredDeployState | undefined
  if (ledger?.status !== 'failed' || ledger.failedAt === undefined) return undefined
  const attempts = ledger.attempts ?? 1
  const retryAt = ledger.failedAt + Math.min(DEPLOY_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 8), DEPLOY_RETRY_CAP_MS)
  return { attempts, retryInMs: Math.max(0, retryAt - Date.now()) }
}

/** The failure record for one alias: wire fields plus the incremented ledger. */
function failedState(store: RemoteStore, alias: string, artifact: string, detail: string): StoredDeployState {
  // The ledger fields are read back through the intersection type: protocol.ts
  // owns the wire shape and deliberately does not carry them.
  const previous = store.require(alias).deploy as StoredDeployState | undefined
  const now = Date.now()
  return { status: 'failed', artifact, detail, at: now, failedAt: now, attempts: (previous?.attempts ?? 0) + 1 }
}

/** Map uname output to a helper platform name. */
export function mapPlatform(unameS: string, unameM: string): string {
  const s = unameS.trim()
  const m = unameM.trim()
  if (s === 'Linux' && m === 'x86_64') return 'linux-x64'
  if (s === 'Linux' && (m === 'aarch64' || m === 'arm64')) return 'linux-arm64'
  if (s === 'Darwin' && m === 'x86_64') return 'macos-x64'
  if (s === 'Darwin' && m === 'arm64') return 'macos-arm64'
  return 'unknown'
}

/** One cached helper build (a validated .helper.json sidecar + tarball). */
export interface HelperCacheEntry {
  kind: 'executable'
  version: string
  platform: string
  tarball: string
  tarballSha256: string
  /** sha256 of the dsh-ssh-helper binary (P2's helperHash). */
  binarySha256: string
  protocol: number
  nodeVersion: string
}

const HEX64 = /^[0-9a-f]{64}$/

/**
 * Charset for a cached helper version.
 *
 * The version reaches a REMOTE shell line and remote directory names, so it is
 * not "just metadata": the sidecar in the cache directory (or a vendored copy
 * seeded into it) could otherwise smuggle `'`/`;` into the install script.
 * `-` is allowed only after the first character so the value cannot look like a
 * command-line option.
 */
const HELPER_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/

/** Platforms `mapPlatform()` can produce; a cache entry must name one of them. */
const HELPER_PLATFORMS = new Set(['linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64'])

/** Wire protocol this plugin's `dsh-ssh` generation speaks (see MAINTENANCE §2.7). */
export const EXPECTED_HELPER_PROTOCOL = 2

/** Resolve one cached tarball, or `undefined` when the name escapes the cache dir. */
function safeHelperTarball(dir: string, tarball: unknown): string | undefined {
  if (typeof tarball !== 'string' || tarball === '' || tarball === '.' || tarball === '..') return undefined
  // Same-directory plain file name only: both separators are rejected (on
  // Windows `a\b` is a path separator too, not part of the name).
  if (tarball.includes('/') || tarball.includes('\\')) return undefined
  if (posix.basename(tarball) !== tarball) return undefined
  const root = resolve(dir)
  const full = resolve(root, tarball)
  if (full !== join(root, tarball) || !full.startsWith(root + sep)) return undefined
  try {
    // lstat, not stat: a symlink in the cache dir must not turn the upload into
    // "copy any file on this machine to the remote host".
    return lstatSync(full).isFile() ? full : undefined
  } catch {
    return undefined
  }
}

/** Absolute path of one cached helper tarball; throws when it is not inside the cache. */
export function helperTarballPath(helper: HelperCacheEntry, dir: string = helpersDir()): string {
  const path = safeHelperTarball(dir, helper.tarball)
  if (path === undefined) throw new Error(`invalid helper tarball path: ${helper.tarball}`)
  return path
}

/** Scan the local helper cache; invalid/incomplete entries are skipped. */
export function listCachedHelpers(dir: string = helpersDir()): HelperCacheEntry[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const entries: HelperCacheEntry[] = []
  for (const name of names) {
    if (!name.endsWith('.helper.json')) continue
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>
      if (raw.kind !== 'executable') continue
      const version = raw.version
      const platform = raw.platform
      const tarball = raw.tarball
      const tarballSha256 = raw.tarballSha256
      const binarySha256 = raw.binarySha256
      const protocol = raw.protocol
      if (typeof version !== 'string' || !HELPER_VERSION_RE.test(version)) continue
      if (typeof platform !== 'string' || !HELPER_PLATFORMS.has(platform)) continue
      if (safeHelperTarball(dir, tarball) === undefined) continue
      if (typeof tarballSha256 !== 'string' || !HEX64.test(tarballSha256)) continue
      if (typeof binarySha256 !== 'string' || !HEX64.test(binarySha256)) continue
      if (typeof protocol !== 'number' || !Number.isInteger(protocol) || protocol <= 0) continue
      entries.push({
        kind: 'executable',
        version,
        platform,
        tarball: tarball as string,
        tarballSha256,
        binarySha256,
        protocol,
        nodeVersion: typeof raw.nodeVersion === 'string' ? raw.nodeVersion : '',
      })
    } catch {
      // Corrupt sidecar: skip.
    }
  }
  entries.sort(compareHelperVersionsDesc)
  return entries
}

/**
 * SemVer-ish comparison for cached helper versions.
 *
 * A plain string compare picked `0.9.0` over `0.10.0` (multi-digit segments sort
 * wrong: `9` > `10`) and the pipeline then pushed an OLD helper as "ok". Numeric
 * segments compare as numbers, everything else lexicographically; a shorter
 * version loses to its own extension (`0.2` < `0.2.1`) and a numeric segment wins
 * over a pre-release one (`0.2.1` > `0.2.1-alpha.2`).
 */
export function compareHelperVersions(left: string, right: string): number {
  const split = (value: string): string[] => value.split(/[.+-]/)
  const a = split(left)
  const b = split(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index]
    const y = b[index]
    // One side ran out of segments: its extra segments decide whether the other
    // side is a release (`1.2.3` > `1.2.3-rc.1`) or a deeper version (`1.2` < `1.2.1`).
    if (x === undefined) return y !== undefined && /^\d+$/.test(y) ? -1 : 1
    if (y === undefined) return x !== undefined && /^\d+$/.test(x) ? 1 : -1
    const nx = /^\d+$/.test(x) ? Number(x) : undefined
    const ny = /^\d+$/.test(y) ? Number(y) : undefined
    if (nx !== undefined && ny !== undefined) {
      if (nx !== ny) return nx < ny ? -1 : 1
      continue
    }
    if (nx !== undefined) return -1
    if (ny !== undefined) return 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** Newest first (Array.prototype.sort comparator). */
function compareHelperVersionsDesc(a: HelperCacheEntry, b: HelperCacheEntry): number {
  return compareHelperVersions(b.version, a.version)
}

/**
 * Pick a cached build for a platform (exact version pin or newest).
 *
 * `expectedProtocol` (default: this plugin's wire protocol) is part of the
 * choice: a cached build whose protocol does not match would install fine and
 * then fail the runtime handshake, so it is not a candidate at all.
 */
export function pickCached(platform: string, version?: string, expectedProtocol: number = EXPECTED_HELPER_PROTOCOL): HelperCacheEntry | undefined {
  const matches = listCachedHelpers().filter(h => h.platform === platform && h.protocol === expectedProtocol)
  if (version !== undefined && version !== '') return matches.find(h => h.version === version)
  return matches[0]
}

/** Honest availability of the helper channels. */
export function helperAvailability(): HelperAvailability[] {
  const cached = listCachedHelpers()
  return [
    cached.length > 0
      ? {
          kind: 'executable',
          available: true,
          reason: `self-built cache: ${cached.map(h => `${h.version}/${h.platform}`).join(', ')}`,
          cached: cached.map(h => ({ version: h.version, platform: h.platform })),
        }
      : {
          kind: 'executable',
          available: false,
          reason: 'no cached binary: no dsh Release ships helper executables (verified); build one (see P1 notes) into $DSH_HOME/dsh-remote-helpers/',
        },
    {
      kind: 'node-script',
      available: false,
      reason: 'not-implemented: executable channel covers P1; node-script stays reserved',
    },
  ]
}

export function isHelperAvailable(kind: HelperKind): boolean {
  return helperAvailability().some(h => h.kind === kind && h.available)
}

/** This package's vendored helper seeds (`vendor/dsh-remote-helpers/`). */
export function vendorHelperDir(): string | undefined {
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let depth = 0; depth < 4; depth += 1) {
      if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'vendor', 'dsh-remote-helpers'))) {
        return join(dir, 'vendor', 'dsh-remote-helpers')
      }
      dir = dirname(dir)
    }
  } catch {
    // Fall through to undefined.
  }
  return undefined
}

export interface SeedReport {
  seeded: string[]
  skipped: string[]
  failed: string[]
  vendorMissing: boolean
}

/**
 * Seed the local helper cache from the vendored copies shipped with the
 * plugin, so a fresh install can push without manual staging. Copy-if-absent
 * only — never overwrites (a newer/different local build always wins);
 * tarballs are hash-verified after copy. Best-effort: throws nothing.
 */
export function seedHelperCache(): SeedReport {
  const report: SeedReport = { seeded: [], skipped: [], failed: [], vendorMissing: true }
  try {
    const vendor = vendorHelperDir()
    if (vendor === undefined) return report
    report.vendorMissing = false
    const cache = helpersDir()
    mkdirSync(cache, { recursive: true })
    for (const name of readdirSync(vendor)) {
      const dest = join(cache, name)
      if (existsSync(dest)) {
        report.skipped.push(name)
        continue
      }
      copyFileSync(join(vendor, name), dest)
      if (name.endsWith('.tar.gz')) {
        const sidecar = `${dest}.sha256`
        const expected = existsSync(sidecar)
          ? readFileSync(sidecar, 'utf8').split(/\s+/)[0]?.trim()
          : readFileSync(join(vendor, `${name}.sha256`), 'utf8').split(/\s+/)[0]?.trim()
        const actual = createHash('sha256').update(readFileSync(dest)).digest('hex')
        if (expected === undefined || expected === '' || actual !== expected) {
          try {
            rmSync(dest, { force: true })
          } catch {
            // Ignore.
          }
          report.failed.push(name)
          continue
        }
      }
      report.seeded.push(name)
    }
  } catch {
    // Best-effort: callers log the report, never throw.
  }
  return report
}

const PROBE_SCRIPT = [
  'echo "RV_UNAME_S=$(uname -s 2>/dev/null)"',
  'echo "RV_UNAME_M=$(uname -m 2>/dev/null)"',
  'echo "RV_HOME=$HOME"',
  'if command -v node >/dev/null 2>&1; then echo "RV_NODE=$(node --version 2>/dev/null)"; else echo "RV_NODE="; fi',
  'RV_LIBC=$(getconf GNU_LIBC_VERSION 2>/dev/null || (ldd --version 2>/dev/null | head -1) || echo "")',
  'echo "RV_LIBC=$RV_LIBC"',
].join('\n')

/** Probe one host's OS/arch/node/home. */
export async function probe(pool: RemotePool, alias: string): Promise<RemoteProbe> {
  const result = await pool.exec(alias, PROBE_SCRIPT, { timeoutMs: 30_000 })
  if (!result.success) {
    return {
      alias, ok: false, arch: '', platform: 'unknown', os: '',
      durationMs: result.durationMs,
      error: result.error ?? result.stderr ?? `exit code ${result.exitCode}`,
    }
  }
  const values = new Map<string, string>()
  for (const line of result.stdout.split('\n')) {
    const match = /^(RV_[A-Z_]+)=(.*)$/.exec(line.trim())
    if (match !== null) values.set(match[1] as string, (match[2] as string).trim())
  }
  const os = values.get('RV_UNAME_S') ?? ''
  const arch = values.get('RV_UNAME_M') ?? ''
  const node = values.get('RV_NODE') ?? ''
  const libc = values.get('RV_LIBC') ?? ''
  const home = values.get('RV_HOME') ?? ''
  return {
    alias,
    ok: os !== '' && arch !== '',
    arch,
    platform: mapPlatform(os, arch),
    os,
    ...(libc !== '' ? { libc } : {}),
    ...(node !== '' ? { node } : {}),
    ...(home !== '' ? { home } : {}),
    durationMs: result.durationMs,
    ...(os === '' || arch === '' ? { error: 'probe output missing uname fields' } : {}),
  }
}

/** Read the installed remote manifest, or null when absent/invalid. */
export async function readRemoteManifest(pool: RemotePool, alias: string): Promise<RemoteManifest | null> {
  const result = await pool.exec(alias, `cat ${REMOTE_ROOT}/manifest.json 2>/dev/null`, { timeoutMs: 15_000 })
  if (!result.success || result.stdout.trim() === '') return null
  try {
    const parsed = JSON.parse(result.stdout) as Partial<RemoteManifest>
    if (parsed.version !== 1 || typeof parsed.manifestHash !== 'string' || typeof parsed.artifact !== 'string') return null
    return parsed as RemoteManifest
  } catch {
    return null
  }
}

/** Stable hash over the manifest identity (installedAt excluded).
 * NOTE: platform is deliberately excluded — it was added to the helper ref in
 * P2, and including it would invalidate every P1-installed manifest (forcing a
 * needless 46MB re-push). Identity = artifact + kind/version/sha256. */
function manifestHashOf(artifact: string, helper: RemoteManifest['helper']): string {
  const slim = helper === undefined || helper === null
    ? null
    : { kind: helper.kind, version: helper.version, sha256: helper.sha256 };
  return createHash('sha256').update(JSON.stringify({ version: 1, artifact, helper: slim })).digest('hex')
}

export interface PushReport {
  alias: string
  probe: RemoteProbe
  action: 'pushed' | 'skipped-same' | 'failed'
  previous: RemoteManifest | null
  installed: RemoteManifest | null
  detail: string
}

export interface PushOptions {
  /** Pin an exact helper version; default resolves the newest cached build. */
  version?: string
}

/**
 * Run the version-aware push: probe -> resolve helper (or probe-bundle
 * fallback) -> compare -> skip or push -> write back.
 */
export async function pushPipeline(
  pool: RemotePool,
  store: RemoteStore,
  alias: string,
  opts: PushOptions = {},
): Promise<PushReport> {
  const started = Date.now()
  const probed = await probe(pool, alias)
  if (!probed.ok) {
    const detail = `probe failed: ${probed.error ?? 'unknown'}`
    store.setDeploy(alias, failedState(store, alias, PROBE_ARTIFACT, detail))
    return { alias, probe: probed, action: 'failed', previous: null, installed: null, detail }
  }
  const home = (probed.home ?? '').trim()
  if (home === '') {
    const detail = 'probe did not report $HOME'
    store.setDeploy(alias, failedState(store, alias, PROBE_ARTIFACT, detail))
    return { alias, probe: probed, action: 'failed', previous: null, installed: null, detail }
  }
  const helper = pickCached(probed.platform, opts.version)
  if (helper === undefined) {
    if (opts.version !== undefined && opts.version !== '') {
      const detail = `no cached helper ${opts.version}/${probed.platform} in $DSH_HOME/dsh-remote-helpers/`
      store.setDeploy(alias, failedState(store, alias, PROBE_ARTIFACT, detail))
      return { alias, probe: probed, action: 'failed', previous: null, installed: null, detail }
    }
    return pushProbeBundle(pool, store, alias, probed, home, started)
  }
  return pushHelper(pool, store, alias, probed, home, helper, started)
}

/** Legacy path: probe-bundle marker only (no cached helper for the platform). */
async function pushProbeBundle(
  pool: RemotePool,
  store: RemoteStore,
  alias: string,
  probed: RemoteProbe,
  home: string,
  started: number,
): Promise<PushReport> {
  const previous = await readRemoteManifest(pool, alias)
  const hash = manifestHashOf(PROBE_ARTIFACT, undefined)
  if (previous !== null && previous.artifact === PROBE_ARTIFACT && previous.manifestHash === hash) {
    const detail = `remote manifest identical (${hash.slice(0, 12)}…); skipped after ${Date.now() - started} ms`
    store.setDeploy(alias, { status: 'skipped-same', artifact: PROBE_ARTIFACT, manifestHash: hash, detail, at: Date.now() })
    return { alias, probe: probed, action: 'skipped-same', previous, installed: previous, detail }
  }
  const manifest: RemoteManifest = { version: 1, artifact: PROBE_ARTIFACT, manifestHash: hash, installedAt: Date.now() }
  try {
    const files = new RemoteFiles(pool)
    const root = `${home}/.dsh-helpers`
    await files.mkdir(alias, root)
    await files.write(alias, `${root}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n')
    const detail = `pushed ${PROBE_ARTIFACT} (${hash.slice(0, 12)}…) in ${Date.now() - started} ms (no cached helper for ${probed.platform}; probe marker only)`
    store.setDeploy(alias, { status: 'ok', artifact: PROBE_ARTIFACT, manifestHash: hash, detail, at: Date.now() })
    return { alias, probe: probed, action: 'pushed', previous, installed: manifest, detail }
  } catch (error) {
    const detail = `push failed: ${error instanceof Error ? error.message : String(error)}`
    store.setDeploy(alias, failedState(store, alias, PROBE_ARTIFACT, detail))
    return { alias, probe: probed, action: 'failed', previous, installed: null, detail }
  }
}

/** Paths of one helper install attempt (absolute, probe-derived + whitelisted version). */
export interface HelperInstallPaths {
  root: string
  verDir: string
  tmpFile: string
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
export function helperInstallSteps(helper: HelperCacheEntry, paths: HelperInstallPaths): string[] {
  const { root, verDir, tmpFile } = paths
  return [
    `cd ${shRoot(root)}`,
    `echo ${shRoot(`${helper.tarballSha256}  ${posix.basename(tmpFile)}`)} | sha256sum -c --status -`,
    // A previous attempt may have died between "old moved away" and "new moved in".
    `if [ ! -d ${shRoot(verDir)} ] && [ -d ${shRoot(verDir + '.old')} ]; then mv ${shRoot(verDir + '.old')} ${shRoot(verDir)}; fi`,
    `rm -rf ${shRoot(verDir + '.next')}`,
    `mkdir -p ${shRoot(verDir + '.next')}`,
    `tar -xzf ${shRoot(tmpFile)} -C ${shRoot(verDir + '.next')} --strip-components=1`,
    `rm -f ${shRoot(tmpFile)}`,
    // Swap: old version survives as `.old` until the new one is in place.
    `rm -rf ${shRoot(verDir + '.old')}`,
    `if [ -d ${shRoot(verDir)} ]; then mv ${shRoot(verDir)} ${shRoot(verDir + '.old')}; fi`,
    `mv ${shRoot(verDir + '.next')} ${shRoot(verDir)}`,
    `rm -rf ${shRoot(verDir + '.old')}`,
    `echo "RV_DIGEST=$(sha256sum ${shRoot(verDir + '/dsh-ssh-helper')} | cut -d' ' -f1)"`,
  ]
}

/** One POSIX shell line: steps joined so any failure stops the sequence. */
export function helperInstallScript(helper: HelperCacheEntry, paths: HelperInstallPaths): string {
  return helperInstallSteps(helper, paths).join(' && ')
}

/** P1 path: push a cached helper tarball, verify, extract, manifest. */
async function pushHelper(
  pool: RemotePool,
  store: RemoteStore,
  alias: string,
  probed: RemoteProbe,
  home: string,
  helper: HelperCacheEntry,
  started: number,
): Promise<PushReport> {
  const artifact = `dsh-ssh-helper/${helper.version}`
  const helperRef = { kind: 'executable' as const, version: helper.version, sha256: helper.binarySha256, platform: helper.platform }
  const hash = manifestHashOf(artifact, helperRef)
  const previous = await readRemoteManifest(pool, alias)
  if (
    previous !== null
    && previous.artifact === artifact
    && previous.manifestHash === hash
    && previous.helper?.sha256 === helper.binarySha256
  ) {
    const detail = `remote helper identical (${helper.version}/${helper.binarySha256.slice(0, 12)}…); skipped after ${Date.now() - started} ms`
    store.setDeploy(alias, { status: 'skipped-same', artifact, manifestHash: hash, home, helper: helperRef, detail, at: Date.now() })
    return { alias, probe: probed, action: 'skipped-same', previous, installed: previous, detail }
  }
  const root = `${home}/.dsh-helpers`
  const manifestPath = `${root}/manifest.json`
  const manifestNext = `${root}/manifest.json.next`
  const paths: HelperInstallPaths = {
    root,
    verDir: `${root}/dsh-ssh-helper-${helper.version}-${helper.platform}`,
    tmpFile: `${root}/.tmp-${helper.version}-${Date.now()}.tar.gz`,
  }
  try {
    const files = new RemoteFiles(pool)
    await files.mkdir(alias, root)
    // 1. Upload (host streams the local tarball over SFTP; the browser never touches bytes).
    await pool.putFile(alias, helperTarballPath(helper), paths.tmpFile)
    // 2. Verify + extract + swap with the old version kept until the new one is in.
    const installedRun = await pool.exec(alias, helperInstallScript(helper, paths), { timeoutMs: 180_000 })
    if (!installedRun.success) {
      throw new Error(`remote install failed [exit code: ${installedRun.exitCode}]: ${installedRun.stderr || installedRun.stdout || installedRun.error || 'unknown'}`)
    }
    const digestMatch = /^RV_DIGEST=([0-9a-fA-F]{64})$/m.exec(installedRun.stdout)
    const digest = digestMatch !== null ? (digestMatch[1] as string).toLowerCase() : ''
    if (digest === '' || digest !== helper.binarySha256) {
      throw new Error(`binary digest mismatch after extract: got ${digest || '(unparsed)'} want ${helper.binarySha256}`)
    }
    // 3. Write our manifest next to the live one, then rename it into place, so a
    //    crashed push cannot leave a half-written manifest.json (official
    //    manifest.json ships inside verDir).
    const manifest: RemoteManifest = {
      version: 1,
      artifact,
      manifestHash: hash,
      helper: helperRef,
      installedAt: Date.now(),
    }
    await files.write(alias, manifestNext, JSON.stringify(manifest, null, 2) + '\n')
    const renamed = await pool.exec(alias, `mv ${shRoot(manifestNext)} ${shRoot(manifestPath)}`, { timeoutMs: 15_000 })
    if (!renamed.success) {
      throw new Error(`manifest rename failed [exit code: ${renamed.exitCode}]: ${renamed.stderr || renamed.error || 'unknown'}`)
    }
    const detail = `pushed ${artifact} (${helper.platform}, bin ${helper.binarySha256.slice(0, 12)}…) in ${Date.now() - started} ms`
    store.setDeploy(alias, { status: 'ok', artifact, manifestHash: hash, home, helper: helperRef, detail, at: Date.now() })
    return { alias, probe: probed, action: 'pushed', previous, installed: manifest, detail }
  } catch (error) {
    const detail = `push failed: ${error instanceof Error ? error.message : String(error)}`
    store.setDeploy(alias, failedState(store, alias, artifact, detail))
    // Keep the live helper dir and any `.old` backup: a failed push must not
    // leave the host without the version it already had. If the swap died
    // between `mv live .old` and `mv next live`, the backup is moved back here
    // (P2-N4: the install script's own recovery line only runs on the NEXT push,
    // which can be minutes away under the retry backoff).
    const cleanup = [
      `rm -f ${shRoot(paths.tmpFile)}`,
      `rm -rf ${shRoot(paths.verDir + '.next')}`,
      `rm -f ${shRoot(manifestNext)}`,
      `if [ ! -d ${shRoot(paths.verDir)} ] && [ -d ${shRoot(paths.verDir + '.old')} ]; then mv ${shRoot(paths.verDir + '.old')} ${shRoot(paths.verDir)}; fi`,
    ].join('; ')
    await pool.exec(alias, cleanup, { timeoutMs: 15_000 }).catch(() => undefined)
    return { alias, probe: probed, action: 'failed', previous, installed: null, detail }
  }
}

/**
 * Single-quote a remote path for sh.
 *
 * Paths are probe-derived, but the version/platform segments come from a cache
 * sidecar: they pass `HELPER_VERSION_RE`/`HELPER_PLATFORMS` before ever reaching
 * this function, so the quoting here is the second layer, not the only one.
 */
function shRoot(path: string): string {
  if (path.includes('\0')) throw new Error('invalid path')
  return `'${path.replace(/'/g, `'\\''`)}'`
}
