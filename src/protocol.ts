/**
 * Wire contract between the host half (routes.ts) and the browser half
 * (client/api.ts). Pure types + path constants only — imported by both
 * halves, bundled into each, no runtime identity to share.
 */

/** API route table (all loopback-only). */
export const REMOTE_API = {
  hosts: '/api/dsh-remote/hosts',
  test: '/api/dsh-remote/test',
  keygen: '/api/dsh-remote/keygen',
  exec: '/api/dsh-remote/exec',
  files: '/api/dsh-remote/files',
  workspaces: '/api/dsh-remote/workspaces',
  deploy: '/api/dsh-remote/deploy',
  importSshConfig: '/api/dsh-remote/import-ssh-config',
  importDshSsh: '/api/dsh-remote/import-dsh-ssh',
  terminal: '/api/dsh-remote/terminal',
  terminalClose: '/api/dsh-remote/terminal-close',
  routing: '/api/dsh-remote/routing',
} as const

/** Authentication flavors a host entry may carry (P0: direct only, no jump/agent). */
export type RemoteAuthKind = 'key' | 'password'

/** One stored host entry (the $DSH_HOME/dsh-remote.json store shape). */
export interface RemoteHostEntry {
  /** Stable, user-chosen identifier used by every operation. */
  alias: string
  /** Hostname or IP of the target. */
  host: string
  /** SSH port (default 22). */
  port: number
  /** Login user. */
  user: string
  /** Authentication. */
  auth: {
    kind: RemoteAuthKind
    /** Absolute path to the private key for 'key' auth. */
    keyPath?: string
    /** Passphrase for an encrypted key. */
    passphrase?: string
    /** Password for 'password' auth. */
    password?: string
  }
  /** Free-form note. */
  description?: string
  /** Free-form tags. */
  tags: string[]
  /** Last deploy pipeline outcome for this host. */
  deploy?: RemoteDeployState | undefined
  createdAt: number
  updatedAt: number
}

/** Public (secret-free) projection of an entry, safe for the browser/agent. */
export interface RemoteHostSummary {
  alias: string
  host: string
  port: number
  user: string
  auth: RemoteAuthKind
  /** Whether the key path exists on this machine (key auth only). */
  keyReady: boolean
  /** True when the entry was bootstrapped by this plugin (managed keypair). */
  managedKey: boolean
  description?: string
  tags: string[]
  deploy?: RemoteDeployState | undefined
  createdAt: number
  updatedAt: number
}

/** One remote workspace binding: a host plus a remote directory. */
export interface RemoteWorkspaceBinding {
  /** Stable id ( cuid-ish ). */
  id: string
  /** Display name. */
  name: string
  /** Host alias this workspace lives on. */
  alias: string
  /** Absolute POSIX path on the remote host. */
  remotePath: string
  createdAt: number
}

/** P2 routing status (Phase 4 workspaces GET extension). */
export interface RemoteRoutingStatus {
  /** Live kill-switch position. */
  mode: 'off' | 'shadow' | 'enforce'
  /** Binding id -> materialized local alias dir. */
  aliasPaths: Record<string, string>
  /** Removed alias dirs that fail closed (history kept). */
  tombstones: string[]
}

/** Plugin identity (workspaces GET extension for the Settings display). */
export interface RemotePluginMeta {
  /** Version from the shipped package.json ('unknown' when unreadable). */
  version: string
}

/** Remote OS probe outcome. */
export interface RemoteProbe {
  alias: string
  ok: boolean
  /** Raw `uname -m` (x86_64 / aarch64 / ...). */
  arch: string
  /** Mapped helper platform (linux-x64 / linux-arm64 / macos-x64 / macos-arm64 / unknown). */
  platform: string
  /** `uname -s`. */
  os: string
  /** glibc version when detectable (linux). */
  libc?: string | undefined
  /** Remote node version when installed (`node --version`), else undefined. */
  node?: string | undefined
  /** Remote home directory. */
  home?: string | undefined
  durationMs: number
  error?: string | undefined
}

/** Helper provider kinds the deploy pipeline knows. */
export type HelperKind = 'executable' | 'node-script'

/** Availability of one helper provider. */
export interface HelperAvailability {
  kind: HelperKind
  available: boolean
  reason: string
  /** Locally cached builds (executable only). */
  cached?: { version: string; platform: string }[]
}

/** Last deploy pipeline outcome stored per host. */
export interface RemoteDeployState {
  status: 'ok' | 'skipped-same' | 'failed' | 'not-deployed'
  /** What was pushed (P0: probe-bundle marker; P1: helper kind+version). */
  artifact: string
  /** sha256 of the installed artifact manifest. */
  manifestHash?: string | undefined
  detail?: string | undefined
  /** Remote $HOME observed at push time (locates the install without re-probing). */
  home?: string | undefined
  /** Installed helper identity (P1+ artifacts). */
  helper?: { kind: HelperKind; version: string; sha256: string; platform?: string } | undefined
  at: number
}

/** Remote manifest installed at ~/.dsh-helpers/manifest.json. */
export interface RemoteManifest {
  version: 1
  artifact: string
  manifestHash: string
  helper?: { kind: HelperKind; version: string; sha256: string; platform?: string } | undefined
  installedAt: number
}

/** One remote directory row (SFTP). */
export interface RemoteFileEntry {
  name: string
  /** Absolute POSIX path. */
  path: string
  isDir: boolean
  size: number
  /** mtime in ms. */
  mtime: number
  /** POSIX mode bits. */
  mode: number
  isSymlink: boolean
}

/** Result of one remote file read (SFTP window). */
export interface RemoteRead {
  /** File size in bytes. */
  size: number
  /** True when the content is not UTF-8 text (base64 holds the bytes). */
  binary: boolean
  text?: string | undefined
  base64?: string | undefined
  /** True when size exceeded READ_CAP (content holds the first window). */
  truncated: boolean
}

/** Result of one non-interactive command execution. */
export interface RemoteExecResult {
  success: boolean
  /** Remote exit code, or null when the channel died without one. */
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  /** Wall-clock duration of the round trip in ms. */
  durationMs: number
  /** Connection error message when the command never ran. */
  error?: string | undefined
}

/** Client -> server terminal frames (JSON text). */
export type TerminalClientFrame =
  | { t: 'in'; d: string }
  | { t: 'resize'; cols: number; rows: number }

/** Server -> client terminal frames (JSON text). */
export type TerminalServerFrame =
  | { t: 'ready'; id: string }
  | { t: 'out'; d: string }
  | { t: 'exit'; code: number | null }
  | { t: 'error'; message: string }

/** Import outcome (ssh_config / dsh-ssh.json). */
export interface ImportReport {
  imported: string[]
  skipped: { alias: string; reason: string }[]
}

/** One parsed commit for the git graph. */
export interface GitCommit {
  hash: string
  parents: string[]
  author: string
  email: string
  /** Author date, unix seconds. */
  date: number
  /** Raw ref list, e.g. ["HEAD -> main", "origin/main", "tag: v1.2"]. */
  refs: string[]
  subject: string
}

/** One changed file in git status. */
export interface GitStatusFile {
  path: string
  /** Staged (index) status char. */
  staged: string
  /** Unstaged (worktree) status char. */
  unstaged: string
}

/** Parsed git status. */
export interface GitStatus {
  branch: string
  detached: boolean
  ahead: number
  behind: number
  staged: GitStatusFile[]
  unstaged: GitStatusFile[]
  untracked: string[]
  truncated: boolean
}

/** One local branch. */
export interface GitBranch {
  name: string
  short: string
  upstream: string
  /** True when this is the current HEAD. */
  head: boolean
}

/** Commit detail. */
export interface GitShow {
  hash: string
  subject: string
  body: string
  stat: string
}
