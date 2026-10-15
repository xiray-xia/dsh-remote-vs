# dsh-remote-vs · VSCode-style remote development for DSH

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

[中文](./README.md) | English

SSH host management inside the DSH Host process + helper push pipeline + remote files/terminal/Git.
Hosts live in DSH Settings ("Remote hosts"); with `dsh-better-sidebar` installed there is an extra
standalone "Remote" tab (workspaces/files/terminal/Git), otherwise it falls back to a native
right-Sidebar "Remote" page (same content, self-opened from the guide, per-session instances).
Since P2, native tools inside remote workspaces transparently run remotely (see below).

```text
┌─ Local DSH Host ─────────────────────────┐
│  Plugin host half   │  Client half       │
│  hosts/keys/push/   │  settings + native │
│  routing            │  entry takeover    │
│  /api/dsh-remote/*  │  explorer page     │
└─────────────────────┴────────────────────┘
       │ ssh2 (files/proc/terminal) + helper RPC (remote fs)
       ▼
┌─ Remote Linux ─────────────────────────────┐
│  ~/.dsh-helpers/<ver>/<arch>/dsh-ssh-helper│
│  user-chosen remote working directory      │
└────────────────────────────────────────────┘
```

## Capabilities

| Capability | Notes |
| --- | --- |
| Host management | CRUD + connectivity test; key / password auth; config in `$DSH_HOME/dsh-remote.json` (0600), independent from `dsh-ssh.json` |
| Key bootstrap | One click generates a dedicated keypair on password hosts and deploys `authorized_keys`, key auth from then on |
| Push pipeline | Remote arch/OS probe → version compare → skip-if-same / else push; the executable channel pushes a self-built helper |
| Remote files | SFTP browse / read / write / create / delete / rename + CodeMirror multi-open editing + draggable splitter |
| Remote terminal | ssh2 PTY + WebSocket, xterm rendering (copy-paste/theme-follow/reconnect-on-refresh) |
| Git graph | Remote repo status + branches + SVG commit graph + commit details (exec + frontend parsing, zero Host additions) |
| Import | One-click import from `~/.ssh/config` and from an existing `dsh-ssh.json` (read once, no coupling) |
| Agent tools | `remote_hosts` / `remote_exec` / `remote_read` / `remote_write` / `remote_ls` |
| **P2 transparent remote execution** | Native `read/write/edit/bash/glob/grep/jobs` inside remote workspaces run directly on the far end |
| **P3 remote @ references** | `@` in remote sessions completes remote files (fileReferences router: scoped live listings / bare queries via a remote rg index) |

## Project structure

```text
dsh_remote_vs/
├── cordis.patch.yml        # composition: plugin row + private local realm + routers + preset-remote
├── src/
│   ├── index.ts            # plugin entry: store/pool/worlds/routes/tools/preset-switch wiring
│   ├── protocol.ts         # frontend/backend wire contract (route table + pure types, shared)
│   ├── paths.ts            # four-piece addressing under $DSH_HOME (store/keys/build cache/alias dirs)
│   ├── store.ts            # host + binding + tombstone persistence (0600 JSON, atomic writes)
│   ├── pool.ts             # ssh2 long-lived pool (exec/shell/sftp/putFile, TOFU host keys)
│   ├── sftp.ts             # remote file engine (SFTP windowed reads-writes/tree ops)
│   ├── keygen.ts           # password-host key bootstrap (generate→deploy→flip)
│   ├── deploy.ts           # push pipeline (probe/compare/ship/double-verify/manifest)
│   ├── importers.ts        # ssh_config / dsh-ssh.json parsing importers
│   ├── routes.ts           # /api/dsh-remote/* route table + terminal WebSocket upgrade
│   ├── terminal.ts         # PTY session registry (reconnect-on-refresh/disconnect cleanup)
│   ├── tools.ts            # the 5 Agent tool definitions
│   ├── http.ts / loopback.ts # JSON body IO + loopback trust fence
│   ├── git-format.ts       # git command builders + pure frontend parsing (zero Host additions)
│   ├── p2/                 # ── P2 transparent routing ──
│   │   ├── worlds.ts       # world decisions (cwd key/alias/tombstones) + remote RPC/FS/proc contexts
│   │   ├── helper-rpc.ts   # helper wire protocol over an ssh2 exec channel (handshake/heartbeat)
│   │   ├── router-fs.ts    # transparent fs router (target→world map/path translation/policy rewrite)
│   │   ├── router-subprocess.ts # transparent process router (argv0 reduction/pwsh gate)
│   │   ├── ssh-proc.ts     # ssh2 process runtime (setsid group kill/marker/stdin/spill)
│   │   ├── shell-bash.ts   # routed bash executor (local verbatim/remote strips DSH_*)
│   │   ├── router-spill.ts # transparent spill router (session world key/remote dir)
│   │   ├── router-refs.ts  # transparent @ reference router (agent world key, P3)
│   │   ├── file-refs.ts    # remote @ search (live fs-ssh listings/rg index/ported stock scoring)
│   │   ├── bridge.ts       # private-realm local publishes (localFs and other early services)
│   │   └── bridge-refs.ts  # standalone refs bridge (local-refs needs workingDirectory: must split)
│   └── client/             # ── browser half (React, bundled into lib/client.js) ──
│       ├── index.tsx       # surface decision (better-first/settle-boost/native fallback) + settings + directoryFlow takeover
│       ├── RemoteRoot.tsx    # shared root for both surfaces (workspaces/files/terminal/git)
│       ├── NativeExplorer.tsx# native page type definition + seat body (no-sidebar fallback)
│       ├── composer.ts / use-remote-chat-target.ts / selection-popup.ts # remote @refs/selection-to-chat
│       ├── api.ts          # typed fetch wrapper over /api/dsh-remote
│       ├── HostsView / WorkspacesView / WorkspaceWizard / FilesView
│       ├── CodeEditor / TerminalView / XTerm / GitView / Dialog
│       ├── SettingsHosts.tsx        # settings occupants (host mgmt/binding list, self-fetching)
│       ├── DirectoryFlow.tsx        # native entry occupant (local dual-mode/remote wizard)
│       ├── RemoteDirectoryPicker.tsx# remote directory browser dialog
│       └── i18n.ts / theme.ts / ui.tsx # bilingual dictionary/theme signal/shared styles
├── vendor/dsh-remote-helpers/ # helper seeds (shipped, seeded into cache at startup, see below)
├── docs/                   # local-only working docs (never pushed to GitHub)
│   ├── P2-PLAN.md          # P2 architecture/phases/acceptance matrix (with per-item status)
│   └── MAINTENANCE.md      # DSH upgrade impact + helper upgrade procedure (read before upgrading)
├── locale/                 # bilingual plugin metadata
└── lib/                    # build output (gitignored, restart after link install to take effect)
```

`vendor/dsh-remote-helpers/` (committed) holds helper seeds: at startup the plugin spreads them into
`$DSH_HOME/dsh-remote-helpers/` (copy-if-absent, never overwrites), so fresh installs can push right away.
When a new helper is built, swap the 4-piece set (tarball + sha256 + helper.json + patch notes)
into vendor and commit — see `docs/MAINTENANCE.md` §4.

`.spike/` (gitignored) holds live-host verification scripts: `p2-router.ts` main regression (real remote +
real Cordis + real router classes) + probes like `grep-probe.mjs`; build with `tsconfig.scratch.json`.

## P2 transparent remote execution (Windows native)

Single-Host mixed routing: native tools dispatch by which world the session cwd lands in — remote aliases go
over helper RPC (fs) / ssh2 (processes), local stays untouched; both share one Host and one GUI.

- Alias dirs: `$DSH_HOME/remote-ssh/aliases/<id>` (empty shells, routing keys only), auto-registered into the native workspace list as `<server> > <base>`
- Routing switch (dropdown at the top of Settings → Remote hosts; underneath it is profile patch `- id: remote-vs`, `config.routingMode`, volatile, no restart):
  `off` (default, local passthrough) / `shadow` (logs, still local) / `enforce` (real routing)
- New workspace: the native "Add workspace…" entry is adopted (local/remote dual tab; remote leg = host→push→bind wizard)
- Presets: a `Remote` preset (bash toolset); under enforce, new remote sessions switch to it automatically (default preset only, never overrides an explicit choice)
- Ground truths (measured, not assumed):
  - Remote `grep/glob` call remote `rg` through routing (both measured hosts ship rg 13; no remote rg means no hits)
  - Whole reads >8MiB report `FS_TOO_LARGE` (official helper ceiling) — use streaming/paged reads; **writes are uncapped** (a 46MiB whole write passed live)
  - Oversized process output lands in a Host temp spill file (`readFrom` returns tail + path, full text lives in the file — same as stock)
  - After unbinding, new calls are explicitly refused (fail-closed tombstones), history stays readable
  - Disconnects: in-flight calls are not replayed; new calls reconnect automatically
- Verify: `npx tsc -p tsconfig.scratch.json && node .spike/build/.spike/p2-router.js`
  (real remote + real Cordis + real router classes, 61/61; P0 routing and GUI need a Host restart + smoke pass)
- Details: `docs/P2-PLAN.md` (§8 acceptance matrix with per-item status)

## Self-built helper (P1)

Upstream never published helper binaries (all Release assets are empty), so this plugin builds its own:

- Build machine: WSL2 Ubuntu-22.04 (glibc 2.35, matching the remote targets), Node v24.21.0 + pnpm 11.28.5
- Sources: the `dsh-v0.2.1-alpha.2` tag (same version as the Host, so the protocol handshake matches)
- Command: stock script `pnpm exec tsx scripts/build-exe-for-ssh-helper.ts --target=node24-linux-x64`
- Only deviation: no docker for the manylinux 2.28 rebuild, so a `DSH_GLIBC_CEILING`
  env override was added (default stays 2.28); this build targets 2.35 (see `glibc-ceiling.patch` in the cache dir)
- Checks: stock `verify-ssh-helper-artifact.ts --sandbox=required`, all 8 green
- Cache: `$DSH_HOME/dsh-remote-helpers/` (`*.tar.gz` + `.sha256` + `.helper.json`
  with binarySha256, feeding P2's helperHash)
- Full rebuild procedure for upgrades: `docs/MAINTENANCE.md` §4

## Security model

- All `/api/dsh-remote/*` routes are loopback + same-origin only.
- Passwords / key passphrases are stored in plaintext in `dsh-remote.json` (0600) — same trust model as the existing SSH plugin.
- Pushed artifacts are sha256-verified both ways (tarball in, binary out); the helper install dir is separate from workspaces.
- Remote sessions may read explicit local absolute paths (the tool spill-file contract requires it); acceptable under the same model trust — see `docs/P2-PLAN.md` §4 note.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run build
dsh plugin --profile web add link:<absolute path of this directory>
```

Hard-refresh the browser after client changes; Host-side changes need a `dsh web` restart.
Before touching anything for a new DSH release, read `docs/MAINTENANCE.md`.

## License

MIT © 2026 xiray-xia — see [LICENSE](./LICENSE).

The `vendor/` helper seed is built from DeepSeek Harness sources (MIT) at tag `dsh-v0.2.1-alpha.2`
with the stock build script; see "Self-built helper" above for the exact procedure and the single
documented deviation (`glibc-ceiling.patch` in the seed set).
