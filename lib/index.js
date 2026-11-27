import { C as dshHome, D as viewSettingsPath, E as storePath, S as aliasRoot, T as keysDir, _ as MAX_TIMEOUT_MS, a as takeHostNotices, b as resolveTimeouts, c as pushPipeline, d as WriteConflictError, f as attachmentHeader, g as DeadlineError, h as DEFAULT_TIMEOUTS, i as drainHostNotices, l as seedHelperCache, m as DEFAULT_READ_TIMEOUT_MS, n as TombstonedError, o as helperAvailability, p as DEFAULT_GIT_TIMEOUT_MS, s as probe, t as RemoteWorlds, u as RemoteFiles, v as MIN_TIMEOUT_MS, w as ensurePrivateDir, x as require_lib, y as clampExecTimeout } from "./worlds-RG8K5eom.js";
import z from "@deepseek-ai/schemastery";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, posix } from "node:path";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { WebSocketServer } from "ws";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/store.ts
/**
* Durable store for dsh-remote-vs: hosts + workspace bindings in
* $DSH_HOME/dsh-remote.json (0600, atomic tmp+rename writes).
*/
/** Empty document. */
function emptyDoc() {
	return {
		version: 1,
		hosts: [],
		workspaces: [],
		tombstones: []
	};
}
/** Same file identity (both absent counts as same). */
function sameStamp$1(left, right) {
	if (left === null || right === null) return left === right;
	return left.mtimeMs === right.mtimeMs && left.size === right.size;
}
/** Alias grammar: 1-64 chars of letters/digits/._- */
const ALIAS_RE$1 = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function assertAlias(alias) {
	if (typeof alias !== "string" || !ALIAS_RE$1.test(alias)) throw new Error("alias must match [A-Za-z0-9._-]{1,64} and start with an alphanumeric");
}
/**
* Replays one read-modify-write before giving up. Two processes sharing
* `$DSH_HOME` (desktop + `dsh web`) can each land an edit between the other's
* read and write; a single retry almost always settles it, and the third attempt
* fails loud instead of silently dropping someone's change.
*/
const MUTATION_ATTEMPTS = 3;
/**
* Validate the SHAPE of an `auth` patch before it is merged.
*
* `update()` used to treat anything whose `kind` was not `'key'` as a password
* patch: `{kind:'garbage'}` silently kept the stored password (HTTP 200), and
* `auth: null` threw an engine TypeError. The merge below (and `normalize()`)
* must only ever see the two declared kinds, with a real object to read from.
*/
function assertAuthPatch(auth) {
	if (typeof auth !== "object" || auth === null) throw new Error("auth must be an object");
	const kind = auth.kind;
	if (kind !== "key" && kind !== "password") throw new Error("auth.kind must be key or password");
}
var RemoteStore = class {
	file;
	doc;
	/** File identity when `doc` was read from disk (undefined = `doc` is not known fresh). */
	stamp;
	constructor(file) {
		this.file = file ?? storePath();
		this.doc = emptyDoc();
		this.reload();
	}
	/**
	* Absolute path of the JSON document.
	*
	* Diagnostics only: a corrupt file must name itself in the error a surface
	* shows, otherwise the user only sees "the request failed".
	*/
	get filePath() {
		return this.file;
	}
	/**
	* Reload from disk (picks up external edits).
	*
	* Re-reading on every access is deliberate: the root fs router asks this store
	* 2-4 times per routed file operation, and an edit made by another process
	* must be visible without a restart. A stat is orders of magnitude cheaper
	* than read + parse, so the file's identity (mtime + size) decides instead —
	* unchanged means the cached doc is already the file's content. The stamp is
	* taken BEFORE the read: a write landing in between leaves the older stamp
	* behind, so the next access re-reads rather than trusting a stale doc. The
	* one edit this cannot see is a same-length rewrite inside the filesystem's
	* mtime granularity (sub-ms on NTFS/ext4).
	*/
	reload() {
		const stamp = this.stampOf();
		if (stamp !== void 0 && this.stamp !== void 0 && sameStamp$1(stamp, this.stamp)) return;
		this.doc = this.loadDoc();
		this.stamp = stamp;
	}
	/**
	* File identity right now: `null` when the file is absent, `undefined` when it
	* cannot be statted at all. Both cases fall through to a full load, so the
	* missing-file and unreadable-file paths behave exactly as they did before.
	*/
	stampOf() {
		try {
			const stat = statSync(this.file, { throwIfNoEntry: false });
			return stat === void 0 ? null : {
				mtimeMs: stat.mtimeMs,
				size: stat.size
			};
		} catch {
			return;
		}
	}
	loadDoc() {
		if (!existsSync(this.file)) return emptyDoc();
		let parsed;
		try {
			parsed = JSON.parse(readFileSync(this.file, "utf8"));
		} catch (error) {
			throw new Error(`cannot parse ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (typeof parsed !== "object" || parsed === null) throw new Error(`${this.file}: root must be an object`);
		const doc = parsed;
		if (doc.version !== 1) throw new Error(`${this.file}: unsupported version ${doc.version}`);
		if (!Array.isArray(doc.hosts) || !Array.isArray(doc.workspaces)) throw new Error(`${this.file}: hosts/workspaces must be arrays`);
		return {
			version: 1,
			hosts: doc.hosts,
			workspaces: doc.workspaces,
			tombstones: Array.isArray(doc.tombstones) ? doc.tombstones.filter((t) => typeof t === "string") : []
		};
	}
	save() {
		this.stamp = void 0;
		const payload = JSON.stringify(this.doc, null, 2);
		const dir = dirname(this.file);
		mkdirSync(dir, { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		const fd = openSync(tmp, "w", 384);
		try {
			writeSync(fd, payload);
			try {
				fsyncSync(fd);
			} catch {}
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, this.file);
		if (process.platform !== "win32") {
			let dirFd;
			try {
				dirFd = openSync(dir, "r");
				fsyncSync(dirFd);
			} catch {} finally {
				if (dirFd !== void 0) try {
					closeSync(dirFd);
				} catch {}
			}
		}
	}
	/**
	* Re-read, mutate, then write only while the file has not changed underneath.
	*
	* Every mutation here rewrites the WHOLE document, so a plain
	* read-modify-write let the last writer win: desktop and `dsh web` share
	* `$DSH_HOME/dsh-remote.json` by design, and one side's host edit could
	* disappear without any error. Re-reading at the start plus a stamp re-check
	* right before the write turns that into a replay on fresh content.
	*
	* `apply` must only touch `this.doc` and return a value (no I/O, no logging):
	* a conflicting attempt is executed again against the reloaded document.
	* The final rename window is still unguarded (a real lock needs blocking I/O);
	* this narrows the lost-update window from a whole user edit to microseconds.
	*/
	mutate(apply) {
		for (let attempt = 0; attempt < MUTATION_ATTEMPTS; attempt += 1) {
			this.reload();
			const base = this.stamp ?? null;
			const before = JSON.stringify(this.doc);
			const result = apply(this.doc);
			if (JSON.stringify(this.doc) === before) return result;
			if (!sameStamp$1(base, this.stampOf() ?? null)) continue;
			this.save();
			return result;
		}
		throw new Error(`${this.file}: another process keeps editing the store; retry the operation`);
	}
	list() {
		this.reload();
		return [...this.doc.hosts];
	}
	get(alias) {
		this.reload();
		return this.doc.hosts.find((h) => h.alias === alias);
	}
	require(alias) {
		const entry = this.get(alias);
		if (entry === void 0) throw new Error(`unknown host alias: ${alias}`);
		return entry;
	}
	create(payload) {
		assertAlias(payload.alias);
		return this.mutate(() => {
			if (this.doc.hosts.some((host) => host.alias === payload.alias)) throw new Error(`alias already exists: ${payload.alias}`);
			const entry = this.normalize(payload, void 0);
			this.doc.hosts.push(entry);
			return entry;
		});
	}
	update(alias, patch) {
		if (patch.auth !== void 0) assertAuthPatch(patch.auth);
		return this.mutate(() => {
			const index = this.doc.hosts.findIndex((h) => h.alias === alias);
			if (index < 0) throw new Error(`unknown host alias: ${alias}`);
			const current = this.doc.hosts[index];
			let auth = patch.auth ?? current.auth;
			if (patch.auth !== void 0) if (patch.auth.kind === "key") {
				const keyPath = (patch.auth.keyPath ?? "").trim();
				auth = {
					kind: "key",
					keyPath: keyPath !== "" ? keyPath : current.auth.kind === "key" ? current.auth.keyPath : "",
					...patch.auth.passphrase !== void 0 ? { passphrase: patch.auth.passphrase } : current.auth.kind === "key" && current.auth.passphrase !== void 0 ? { passphrase: current.auth.passphrase } : {}
				};
			} else {
				const password = patch.auth.password ?? "";
				auth = {
					kind: "password",
					password: password !== "" ? password : current.auth.kind === "password" ? current.auth.password : ""
				};
			}
			const merged = {
				alias,
				host: patch.host ?? current.host,
				port: patch.port ?? current.port,
				user: patch.user ?? current.user,
				auth,
				description: patch.description ?? current.description,
				tags: patch.tags ?? current.tags
			};
			const next = this.normalize(merged, current);
			this.doc.hosts[index] = next;
			return next;
		});
	}
	/**
	* Delete one host AND its workspace bindings.
	*
	* The cascade has to keep the tombstone contract (see `removeWorkspace`): a
	* binding that disappears while its alias dir stays on disk is no longer
	* routed, but DSH's workspace registry still lists that dir, so a session
	* rooted there would quietly execute LOCALLY against an empty folder instead
	* of failing closed. Every cascaded binding is therefore tombstoned in the
	* SAME atomic write as the removal — there is no on-disk state where the
	* binding is gone but its tombstone is missing.
	*/
	remove(alias) {
		return this.mutate(() => {
			const hosts = this.doc.hosts.filter((h) => h.alias !== alias);
			if (hosts.length === this.doc.hosts.length) return false;
			this.doc.hosts = hosts;
			for (const binding of this.doc.workspaces) if (binding.alias === alias) this.recordTombstone(join(aliasRoot(), binding.id));
			this.doc.workspaces = this.doc.workspaces.filter((w) => w.alias !== alias);
			return true;
		});
	}
	normalize(payload, current) {
		if (typeof payload.host !== "string" || payload.host.trim() === "") throw new Error("host must be a non-empty string");
		const port = payload.port ?? 22;
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be an integer 1-65535");
		if (typeof payload.user !== "string" || payload.user.trim() === "") throw new Error("user must be a non-empty string");
		const auth = payload.auth;
		if (auth === void 0 || auth.kind !== "key" && auth.kind !== "password") throw new Error("auth.kind must be key or password");
		if (auth.kind === "key") {
			if (typeof auth.keyPath !== "string" || auth.keyPath.trim() === "") throw new Error("auth.keyPath is required for key auth");
			if (auth.passphrase !== void 0 && typeof auth.passphrase !== "string") throw new Error("auth.passphrase must be a string when provided");
		} else if (typeof auth.password !== "string" || auth.password === "") throw new Error("auth.password must be a non-empty string for password auth");
		if (payload.description !== void 0 && typeof payload.description !== "string") throw new Error("description must be a string when provided");
		if (payload.tags !== void 0 && (!Array.isArray(payload.tags) || payload.tags.some((t) => typeof t !== "string"))) throw new Error("tags must be string[] when provided");
		const now = Date.now();
		return {
			alias: payload.alias,
			host: payload.host.trim(),
			port,
			user: payload.user.trim(),
			auth: {
				kind: auth.kind,
				...auth.keyPath !== void 0 ? { keyPath: auth.keyPath } : {},
				...auth.passphrase !== void 0 ? { passphrase: auth.passphrase } : {},
				...auth.password !== void 0 ? { password: auth.password } : {}
			},
			...payload.description !== void 0 ? { description: payload.description } : {},
			tags: payload.tags ?? [],
			...current?.deploy !== void 0 ? { deploy: current.deploy } : {},
			createdAt: current?.createdAt ?? now,
			updatedAt: now
		};
	}
	/** Secret-free projection for browser/agent surfaces. */
	summarize(entry) {
		let keyReady = false;
		if (entry.auth.kind === "key" && entry.auth.keyPath !== void 0) try {
			keyReady = existsSync(entry.auth.keyPath);
		} catch {
			keyReady = false;
		}
		return {
			alias: entry.alias,
			host: entry.host,
			port: entry.port,
			user: entry.user,
			auth: entry.auth.kind,
			keyReady,
			managedKey: entry.auth.kind === "key" && entry.auth.keyPath !== void 0 && entry.auth.keyPath.startsWith(keysDir() + (process.platform === "win32" ? "\\" : "/")),
			...entry.description !== void 0 ? { description: entry.description } : {},
			tags: [...entry.tags],
			...entry.deploy !== void 0 ? { deploy: entry.deploy } : {},
			createdAt: entry.createdAt,
			updatedAt: entry.updatedAt
		};
	}
	setDeploy(alias, state) {
		this.mutate(() => {
			const entry = this.doc.hosts.find((h) => h.alias === alias);
			if (entry === void 0) throw new Error(`unknown host alias: ${alias}`);
			entry.deploy = state;
			entry.updatedAt = Date.now();
		});
	}
	listWorkspaces() {
		this.reload();
		return [...this.doc.workspaces];
	}
	createWorkspace(payload) {
		if (typeof payload.name !== "string" || payload.name.trim() === "") throw new Error("name must be a non-empty string");
		if (typeof payload.remotePath !== "string" || !payload.remotePath.startsWith("/")) throw new Error("remotePath must be an absolute POSIX path");
		return this.mutate(() => {
			if (!this.doc.hosts.some((host) => host.alias === payload.alias)) throw new Error(`unknown host alias: ${payload.alias}`);
			const binding = {
				id: randomUUID().slice(0, 8),
				name: payload.name.trim(),
				alias: payload.alias,
				remotePath: payload.remotePath,
				createdAt: Date.now()
			};
			this.doc.workspaces.push(binding);
			return binding;
		});
	}
	removeWorkspace(id) {
		return this.mutate(() => {
			if (this.doc.workspaces.find((w) => w.id === id) === void 0) return false;
			this.recordTombstone(join(aliasRoot(), id));
			this.doc.workspaces = this.doc.workspaces.filter((w) => w.id !== id);
			return true;
		});
	}
	/**
	* Record one tombstone without writing (idempotent).
	*
	* The caller owns `save()` so a change covering several bindings lands in ONE
	* atomic write: a crash between two writes must never leave a binding removed
	* while its tombstone is still missing.
	*/
	recordTombstone(aliasPath) {
		if (!this.doc.tombstones.includes(aliasPath)) this.doc.tombstones.push(aliasPath);
	}
	/** Record a removed alias path (idempotent). */
	addTombstone(aliasPath) {
		this.mutate(() => {
			this.recordTombstone(aliasPath);
		});
	}
	listTombstones() {
		this.reload();
		return [...this.doc.tombstones];
	}
};
//#endregion
//#region src/protocol.ts
/**
* Wire contract between the host half (routes.ts) and the browser half
* (client/api.ts). Pure types + path constants only — imported by both
* halves, bundled into each, no runtime identity to share.
*/
/** API route table (all loopback-only). */
const REMOTE_API = {
	hosts: "/api/dsh-remote/hosts",
	test: "/api/dsh-remote/test",
	/** Per-alias SSH connection health for the client's status indicator. */
	status: "/api/dsh-remote/status",
	keygen: "/api/dsh-remote/keygen",
	exec: "/api/dsh-remote/exec",
	/** Streaming exec (server-sent events) for the long network verbs. */
	execStream: "/api/dsh-remote/exec-stream",
	files: "/api/dsh-remote/files",
	/** Streaming binary upload: raw request body, host and path in the query. */
	upload: "/api/dsh-remote/upload",
	/** Streaming binary download: raw response body, host and path in the query. */
	download: "/api/dsh-remote/download",
	/** Streaming directory download: a remote `tar -czf -` of the directory. */
	downloadDir: "/api/dsh-remote/download-dir",
	/** Streaming multi-selection download: one remote tar of repeated `path` params. */
	downloadMany: "/api/dsh-remote/download-many",
	workspaces: "/api/dsh-remote/workspaces",
	deploy: "/api/dsh-remote/deploy",
	importSshConfig: "/api/dsh-remote/import-ssh-config",
	importDshSsh: "/api/dsh-remote/import-dsh-ssh",
	terminal: "/api/dsh-remote/terminal",
	terminalClose: "/api/dsh-remote/terminal-close",
	routing: "/api/dsh-remote/routing",
	/** Client view preferences (auto-open the remote page + its width share). */
	viewSettings: "/api/dsh-remote/view-settings",
	/** Current working directory of one live session (click resolution helper). */
	sessionCwd: "/api/dsh-remote/session-cwd",
	/** What one live session changed on its remote host (the review panel). */
	changes: "/api/dsh-remote/changes",
	/** Local TCP forwards (`ssh -L` semantics) for the port panel. */
	forwards: "/api/dsh-remote/forwards",
	/** Remote listening TCP sockets for the port panel (one bounded probe). */
	listenPorts: "/api/dsh-remote/listen-ports",
	/** Live system metrics for the monitor panel (one bounded probe per host). */
	metrics: "/api/dsh-remote/metrics",
	/** One bounded process table for the monitor page, plus TERM/KILL actions. */
	processes: "/api/dsh-remote/processes"
};
/** Suggested/attachment file name for one multi-selection archive. */
function selectionDownloadName(count) {
	return `selection-${count}.tar.gz`;
}
/** The answers a fresh profile gets before anything is saved. */
const REMOTE_VIEW_SETTINGS_DEFAULTS = {
	autoOpenRemoteWorkspace: false,
	remoteWorkspaceWidthRatio: .45
};
/** Narrowest useful share of the frame width (a smaller panel hides its tools). */
const REMOTE_VIEW_WIDTH_MIN = .2;
/** Widest share the column itself allows (DSH caps the column at 70 %). */
const REMOTE_VIEW_WIDTH_MAX = .7;
/**
* Clamp one width share into the allowed band.
*
* Pure and shared by both halves: the Host validates what it stores, and the
* browser clamps what it applies (an older Host may omit or round the field).
*/
function clampViewWidthRatio(value) {
	return Math.min(REMOTE_VIEW_WIDTH_MAX, Math.max(REMOTE_VIEW_WIDTH_MIN, value));
}
//#endregion
//#region src/view-settings.ts
/**
* Durable store for the two client view preferences: `$DSH_HOME/dsh-remote-view.json`.
*
* Why a file of its own (and not the routing store, nor a browser-local key):
*  - the settings describe how the PLUGIN behaves in the right panel, and they
*    must apply to every Web/Desktop window of this profile — the browser's
*    localStorage is per origin/per machine and would drift;
*  - they are GUI behaviour, not routing facts: keeping them out of
*    `dsh-remote.json` means a hand-edited preference can never break the store
*    the routers read on every remote operation.
*
* Shape of the file (`version: 1`), written atomically (tmp + rename, 0600):
*
*   { "version": 1, "autoOpenRemoteWorkspace": false, "remoteWorkspaceWidthRatio": 0.45 }
*
* Field-by-field validation with defaults on READ (so a missing, older or
* half-edited field costs only that field), and a flat PATCH on write (unknown
* keys are ignored — the browser is the only writer, and a stale tab must not be
* able to corrupt the file with an extra key).
*/
/** Defaults as a fresh copy (callers may own the object). */
function defaults() {
	return { ...REMOTE_VIEW_SETTINGS_DEFAULTS };
}
/** Same file identity (both absent counts as same). */
function sameStamp(left, right) {
	if (left === null || right === null) return left === right;
	return left.mtimeMs === right.mtimeMs && left.size === right.size;
}
/**
* Replays one read-modify-write before giving up.
*
* Desktop and `dsh web` share `$DSH_HOME/dsh-remote-view.json` by design, and
* every patch rewrites the WHOLE document: a plain read-merge-write let the last
* window win and silently dropped the other one's preference. A stamp re-check
* right before the write turns that into a replay on fresh content; a third
* failed attempt fails loud instead of losing a setting.
*/
const PATCH_ATTEMPTS = 3;
/** A finite width share, clamped into the allowed band; anything else is a miss. */
function readWidthRatio(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return void 0;
	return clampViewWidthRatio(value);
}
var RemoteViewSettingsStore = class {
	file;
	constructor(file = viewSettingsPath()) {
		this.file = file;
	}
	/**
	* The current preferences (a missing file answers the defaults).
	*
	* Read from disk on every call: the file is tiny, GET hands it to a page load,
	* and two processes sharing `$DSH_HOME` (desktop + `dsh web`) must see each
	* other's edit without a restart.
	*/
	get() {
		if (!existsSync(this.file)) return defaults();
		let parsed;
		try {
			parsed = JSON.parse(readFileSync(this.file, "utf8"));
		} catch (error) {
			throw new Error(`cannot parse ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${this.file}: root must be an object`);
		const doc = parsed;
		if (doc.version !== void 0 && doc.version !== 1) throw new Error(`${this.file}: unsupported version ${String(doc.version)}`);
		return {
			autoOpenRemoteWorkspace: typeof doc.autoOpenRemoteWorkspace === "boolean" ? doc.autoOpenRemoteWorkspace : REMOTE_VIEW_SETTINGS_DEFAULTS.autoOpenRemoteWorkspace,
			remoteWorkspaceWidthRatio: readWidthRatio(doc.remoteWorkspaceWidthRatio) ?? REMOTE_VIEW_SETTINGS_DEFAULTS.remoteWorkspaceWidthRatio
		};
	}
	/**
	* Merge one flat patch into the stored preferences and persist the result.
	*
	* Unknown keys are ignored and an unusable value of a known field keeps the
	* stored one: the browser's controls only ever send valid values, so a bad
	* field means a stale client, not something the user should be told about.
	*
	* @param patch - a partial document straight from the POST body.
	* @returns the settings as stored.
	*/
	patch(patch) {
		for (let attempt = 0; attempt < PATCH_ATTEMPTS; attempt += 1) {
			const before = this.stampOf();
			const current = this.get();
			const next = {
				autoOpenRemoteWorkspace: typeof patch.autoOpenRemoteWorkspace === "boolean" ? patch.autoOpenRemoteWorkspace : current.autoOpenRemoteWorkspace,
				remoteWorkspaceWidthRatio: readWidthRatio(patch.remoteWorkspaceWidthRatio) ?? current.remoteWorkspaceWidthRatio
			};
			if (!sameStamp(before, this.stampOf())) continue;
			this.save(next);
			return next;
		}
		throw new Error(`${this.file}: another process keeps editing the view settings; retry the operation`);
	}
	/**
	* File identity right now; `null` when the file is absent (or cannot be
	* statted — `get()` fails loud on that case anyway).
	*/
	stampOf() {
		try {
			const stat = statSync(this.file, { throwIfNoEntry: false });
			return stat === void 0 ? null : {
				mtimeMs: stat.mtimeMs,
				size: stat.size
			};
		} catch {
			return null;
		}
	}
	/** Write one document atomically: a crash never leaves a half-written file. */
	save(settings) {
		const doc = {
			version: 1,
			...settings
		};
		const payload = `${JSON.stringify(doc, null, 2)}\n`;
		mkdirSync(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		const fd = openSync(tmp, "w", 384);
		try {
			writeSync(fd, payload);
			try {
				fsyncSync(fd);
			} catch {}
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, this.file);
	}
};
//#endregion
//#region src/pool.ts
/**
* Persistent ssh2 connection pool: one long-lived connection per host alias,
* dropped after 30 idle minutes. All remote ops (exec / shell / sftp) ride it.
*
* Trust model (P0): host keys are accepted on first use (TOFU); a changed key
* for a known host is logged loudly but the connection still proceeds. Strict
* known-hosts enforcement is P1 work.
*/
var import_lib = require_lib();
/** Idle time after which a pooled connection is closed. */
const IDLE_MS = 1800 * 1e3;
/**
* Connection establishment timeout, including authentication.
*
* This was 15s, which is not a handshake budget so much as a CPU budget: on a
* two-core host running a build, sshd could not complete a PASSWORD exchange
* inside it, and every call failed with "Timed out while waiting for handshake"
* while the banner was arriving in 15ms. Key auth fixed the common case (~1s),
* but a loaded host is still slow enough to be worth headroom.
*
* Override with DSH_REMOTE_VS_CONNECT_TIMEOUT_MS (milliseconds, >= 1000).
*/
const READY_TIMEOUT_MS = (() => {
	const raw = Number(process.env.DSH_REMOTE_VS_CONNECT_TIMEOUT_MS);
	return Number.isFinite(raw) && raw >= 1e3 ? raw : 45e3;
})();
/**
* Extra wall clock on top of `READY_TIMEOUT_MS` for the dial's own watchdog.
*
* `readyTimeout` only covers "the socket stays open and the handshake stalls":
* ssh2 clears it as soon as the socket closes, and it only re-reports a close as
* an `error` when the SSH banner never arrived (client.js `onDone`). The shape
* left over is "no event at all", which used to leave the dial promise pending
* forever and the caller holding a channel slot. Override with
* DSH_REMOTE_VS_DIAL_GUARD_MS (milliseconds, >= 0); the dial gate keeps its case
* fast that way.
*/
const DIAL_GUARD_MARGIN_MS = (() => {
	const raw = Number(process.env.DSH_REMOTE_VS_DIAL_GUARD_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : 5e3;
})();
/** Per-stream output cap (stdout/stderr each); overflow truncates with a marker. */
const OUTPUT_CAP = 2 * 1024 * 1024;
/**
* Wall-clock cap for one SFTP callback body (and for opening the session). SSH
* gives no request timeout of its own, so a server that never answers would hold
* the session (and the pooled connection's hold count) open forever — the leak
* that eventually exhausts the server's channel budget. The timeout rejects so
* the caller's `finally` still ends the session and releases the connection.
*
* Override with DSH_REMOTE_VS_SFTP_TIMEOUT_MS (milliseconds, >= 100) so the
* session-lifecycle gate can exercise the deadline without waiting a minute.
*/
const SFTP_OP_TIMEOUT_MS = (() => {
	const raw = Number(process.env.DSH_REMOTE_VS_SFTP_TIMEOUT_MS);
	return Number.isFinite(raw) && raw >= 100 ? raw : 6e4;
})();
/**
* No-progress budget for a bulk upload. Deliberately an *idle* timeout rather
* than a wall clock: the point is to catch a stream that stopped moving, not
* to give up on a large file that is transferring fine on a slow link.
* `fastPut` resets it on every chunk via its `step` callback.
*/
const UPLOAD_IDLE_MS = 6e4;
const TRUNCATED_MARKER = "\n[... truncated: output exceeded 2 MiB ...]\n";
/** Leading line the session wrapper prints so the timeout can kill its group. */
const PGID_MARKER = "RV_PID=";
/** One-shot `setsid --wait` capability probe (see RemotePool.supportsSetsid). */
const SETSID_PROBE = "setsid --wait sh -c 'exit 7' 2>/dev/null; test $? -eq 7 && echo RV_SETSID=1";
const SETSID_PROBE_MARK = "RV_SETSID=1";
/** Deadline for the probe and for a group kill; both are one tiny command. */
const CONTROL_TIMEOUT_MS = 15e3;
/**
* How long a killed group gets to report its exit before TERM escalates to
* KILL. Without the escalation a command that ignores TERM would survive the
* timeout, which is the leak this kill exists to close (p2/ssh-proc.ts uses
* the same grace before its own escalation).
*/
const GROUP_KILL_GRACE_MS = 3e3;
/**
* Concurrent channels the pool opens per alias. The server's own `MaxSessions`
* (10 on the hosts this was measured against) is the real ceiling, and running
* past it fails the extra channels hard — "open failed / administratively
* prohibited" — with nobody retrying. Six is chosen to leave room for what is
* deliberately NOT counted here: PTY terminals, the processes the subprocess
* runtime owns, and the helper's channel.
*/
const CHANNEL_LIMIT = 6;
/**
* How long an operation waits for a channel slot before failing. Bounded on
* purpose: queueing forever behind a peer that never finishes is worse than a
* readable error that tells the user to retry.
*/
const CHANNEL_WAIT_MS = 3e4;
/**
* Idle time after which the shared BROWSE SFTP session is closed.
*
* Browsing is bursty (open a folder, look around, edit for a while, browse
* again), so a channel that survives only the burst costs one channel-open
* round trip per burst and saves one per request inside it. Two minutes covers
* the burst without keeping a channel slot parked for a five-minute pause. The
* slot it holds is the one a per-request session took, so peak channel usage
* against the server's MaxSessions does not change; the parked-slot trade-off
* is spelled out in withBrowseSftp's docstring.
*/
const BROWSE_IDLE_MS = 120 * 1e3;
/**
* Connection-level failures the status indicator must show.
*
* Deliberately about the TRANSPORT, not about the remote's answer: a missing
* file, a rejected password prompt or a non-zero git exit are all business
* outcomes and must not paint the host as disconnected. `timed out` is in here
* because a handshake/channel deadline means the link (or the server behind it)
* is not answering, which is exactly what the indicator is for.
*/
const CONNECTION_ERROR_RE = /not connected|no response from server|connection lost|connection closed|connection refused|socket hang up|channel open fail(?:ed|ure)|stalled|host .* was disconnected|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|EPIPE/i;
/** Whether `error` is a transport-level failure worth showing as a link problem. */
function isConnectionFailure(error) {
	const message = error instanceof Error ? error.message : String(error ?? "");
	return message !== "" && CONNECTION_ERROR_RE.test(message);
}
var RemotePool = class {
	store;
	conns = /* @__PURE__ */ new Map();
	/**
	* Dedicated connections for PTY shells (one per alias).
	*
	* Why a SECOND connection instead of a channel on the shared one: ssh2
	* multiplexes channels over ONE TCP connection, and SSH has no per-channel
	* priority or flow control. A large SFTP transfer / git output on that
	* connection therefore delays everything else on it — including the echo of a
	* keystroke — which is exactly the "typing stutters when something else is
	* moving data" report. A terminal gets its own connection, so its bytes never
	* queue behind browse/exec traffic, and shells stop consuming the shared
	* connection's channel budget as well.
	*
	* Cost: one extra SSH handshake per alias the first time a terminal opens,
	* plus one held TCP connection per host with a terminal. `shell()` falls back
	* to the shared connection if this one cannot be established at all, so a host
	* that refuses extra connections still gets a working terminal.
	*/
	shellConns = /* @__PURE__ */ new Map();
	/** TOFU fingerprints observed this process (alias -> sha256). */
	hostKeys = /* @__PURE__ */ new Map();
	/** Per-alias `setsid --wait` capability, probed once (see supportsSetsid). */
	setsidProbes = /* @__PURE__ */ new Map();
	/** Per-alias channel slots and the queue waiting for one (see acquireSlot). */
	slots = /* @__PURE__ */ new Map();
	/** Per-alias BROWSE SFTP session (see withBrowseSftp). */
	browsed = /* @__PURE__ */ new Map();
	/** Per-alias connection health for the browser's status chip (see status). */
	health = /* @__PURE__ */ new Map();
	constructor(store) {
		this.store = store;
	}
	/** Drop one pooled connection (call after host update/delete). */
	drop(alias) {
		this.evictBrowse(alias);
		this.setsidProbes.delete(alias);
		this.evictFrom(this.conns, alias);
		this.evictFrom(this.shellConns, alias);
	}
	/** Close every pooled connection. */
	dispose() {
		for (const alias of /* @__PURE__ */ new Set([...this.conns.keys(), ...this.shellConns.keys()])) this.drop(alias);
	}
	/**
	* Forget one alias's connection HEALTH (host edited/removed), not just its
	* connection.
	*
	* `drop` is also the idle eviction path, so it must keep the health record
	* (idle-closed is not an error). Only a host mutation discards what the pool
	* learned about that alias.
	*/
	forget(alias) {
		this.drop(alias);
		this.health.delete(alias);
	}
	/**
	* Per-alias connection health for the browser's status indicator.
	*
	* Read-only and dial-free: it reports what the pool already knows, so the
	* indicator's poll never creates a connection as a side effect.
	*/
	status() {
		const aliases = /* @__PURE__ */ new Set([...this.conns.keys(), ...this.health.keys()]);
		try {
			for (const host of this.store.list()) aliases.add(host.alias);
		} catch {}
		return [...aliases].sort().map((alias) => {
			const entry = this.health.get(alias);
			const pooled = this.conns.get(alias);
			return {
				alias,
				state: entry?.state ?? "idle",
				open: pooled !== void 0 && pooled.connecting === void 0 || this.shellConns.get(alias)?.connecting === void 0 && this.shellConns.has(alias),
				...entry?.okAt === void 0 ? {} : { okAt: entry.okAt },
				...entry?.errorAt === void 0 ? {} : { errorAt: entry.errorAt },
				...entry?.error === void 0 ? {} : { error: entry.error }
			};
		});
	}
	/** Record a successful dial or transport-level operation. */
	markOk(alias) {
		this.health.set(alias, {
			state: "ok",
			okAt: Date.now()
		});
	}
	/** Record a connection-level failure the status chip should show. */
	markError(alias, error) {
		const message = error instanceof Error ? error.message : String(error ?? "");
		this.health.set(alias, {
			state: "error",
			errorAt: Date.now(),
			error: message
		});
	}
	/**
	* Record one operation's failure, EXCEPT when the budget simply ran out.
	*
	* A deadline means "this request did not answer in time", not "the link is
	* down": the connection can be perfectly healthy and merely slow (a huge
	* directory, an 8 MiB read on a thin link, a cold filesystem). Painting the
	* chip red used to flip the editor to read-only and block saving — a false
	* alarm with a real cost. Real transport failures still arrive as transport
	* errors (`close`, `No response from server`, a channel open failure), and
	* those keep marking; the operation itself still fails either way.
	*/
	noteOpFailure(alias, error) {
		if (error instanceof DeadlineError) return;
		if (isConnectionFailure(error)) this.markError(alias, error);
	}
	/**
	* Probe one connection and record the outcome for the status indicator.
	*
	* "Test" must PROVE the link, not report that a pooled Client object exists:
	* the old version answered ok without any traffic, so a retry against a
	* half-open link painted the host green until the next real request failed.
	*
	* It must also NOT disturb the pool: this is what host settings' "test" and
	* the chip's retry run, and the host being tested is often the one the user is
	* working on (a terminal open, a transfer running). So a live connection gets
	* a real round trip on itself (a trivial bare command under the control
	* deadline), and only a COLD alias dials. Tearing the connection down instead
	* would end every channel on it, including the terminal that the user opened
	* to debug the flaky host.
	*/
	async test(alias) {
		const started = Date.now();
		const finish = (ok, error) => ({
			ok,
			...error === void 0 ? {} : { error },
			durationMs: Date.now() - started
		});
		if (this.conns.has(alias)) try {
			const probe = await this.exec(alias, "true", {
				timeoutMs: CONTROL_TIMEOUT_MS,
				bare: true
			});
			if (probe.success || probe.exitCode !== null) {
				this.markOk(alias);
				return finish(true);
			}
			if (probe.error !== void 0 && isConnectionFailure(probe.error)) this.markError(alias, probe.error);
			return finish(false, probe.error ?? "the probe command did not complete");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (isConnectionFailure(error)) this.markError(alias, error);
			return finish(false, message);
		}
		try {
			await this.acquire(alias);
			this.markOk(alias);
			return finish(true);
		} catch (error) {
			if (isConnectionFailure(error)) this.markError(alias, error);
			return finish(false, error instanceof Error ? error.message : String(error));
		}
	}
	/**
	* Run one non-interactive command.
	*
	* The command needs a channel slot: a burst of SCM or search calls is exactly
	* how a host runs past `MaxSessions`, where the surplus channels fail instead
	* of queueing. The pool's own housekeeping (`bare`: the setsid probe and the
	* group kill) is exempt — a kill that waits behind user traffic would be a
	* worse bug than the one it fixes.
	*/
	async exec(alias, command, opts = {}) {
		if (opts.bare === true) return this.runExec(alias, command, opts);
		const started = Date.now();
		try {
			await this.acquireSlot(alias);
		} catch (error) {
			return {
				success: false,
				exitCode: null,
				timedOut: false,
				stdout: "",
				stderr: "",
				durationMs: Date.now() - started,
				error: error instanceof Error ? error.message : String(error)
			};
		}
		try {
			const result = await this.runExec(alias, command, opts);
			if (result.error !== void 0 && isConnectionFailure(result.error)) this.markError(alias, result.error);
			else if (result.success || result.exitCode !== null) this.markOk(alias);
			return result;
		} finally {
			this.releaseSlot(alias);
		}
	}
	/** The exec body, run while the caller already holds a channel slot. */
	async runExec(alias, command, opts = {}) {
		const started = Date.now();
		const timeoutMs = opts.timeoutMs ?? 6e4;
		const session = opts.bare === true ? false : await this.supportsSetsid(alias);
		let conn;
		try {
			conn = await this.acquire(alias);
			this.hold(alias);
		} catch (error) {
			return {
				success: false,
				exitCode: null,
				timedOut: false,
				stdout: "",
				stderr: "",
				durationMs: Date.now() - started,
				error: error instanceof Error ? error.message : String(error)
			};
		}
		try {
			return await new Promise((resolve) => {
				let settled = false;
				let timedOut = false;
				/** Server-confirmed child exit; a bare channel close is not proof. */
				let exited = false;
				/** Session/process-group id, from the wrapper's leading marker line. */
				let pgid;
				let markerPending = session;
				let warned = false;
				/** Say once, and only once, that the timeout could not reach the command. */
				const warnOnce = () => {
					if (warned) return;
					warned = true;
					warnDetached(alias);
				};
				const finish = (result) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					this.release(alias);
					resolve({
						...result,
						durationMs: Date.now() - started
					});
				};
				/**
				* Signal the command's process group over a fresh channel: the timed-out
				* channel is closing, and `channel.signal()` would only reach the outer
				* shell anyway. `bare` keeps the kill out of the wrapper — a kill that
				* hung would otherwise try to kill its own group.
				*/
				const killGroup = (signal) => {
					if (pgid === void 0) return;
					this.exec(alias, `kill -${signal} -- -${pgid}`, {
						timeoutMs: CONTROL_TIMEOUT_MS,
						bare: true
					}).catch(() => void 0);
				};
				const terminateGroup = () => {
					killGroup("TERM");
					setTimeout(() => {
						if (!exited) killGroup("KILL");
					}, GROUP_KILL_GRACE_MS).unref?.();
				};
				const timer = setTimeout(() => {
					timedOut = true;
					try {
						stream?.close();
					} catch {}
					if (pgid !== void 0) terminateGroup();
					else if (!session) warnOnce();
					finish({
						success: false,
						exitCode: null,
						timedOut: true,
						stdout: out,
						stderr: err
					});
				}, timeoutMs);
				let stream;
				let out = "";
				let err = "";
				/** Set by the cancel handle: closed + group-killed, reported as error. */
				let cancelled = false;
				const outDecoder = new StringDecoder("utf8");
				const errDecoder = new StringDecoder("utf8");
				/** Wrapper marker never reaches the live log (see the data handler). */
				let pendingForward = "";
				const forward = (kind, text) => {
					if (text !== "" && opts.onData !== void 0) opts.onData(kind, text);
				};
				/**
				* Cancel the run: close our channel and kill the remote process group.
				*
				* `finish` reports it as an error rather than a timeout — "the user
				* stopped it" and "the budget ran out" are different stories, and the
				* UI must not blame the host for the former.
				*/
				const cancel = () => {
					if (settled) return;
					cancelled = true;
					try {
						stream?.close();
					} catch {}
					if (pgid !== void 0) terminateGroup();
					else if (!session) warnOnce();
					finish({
						success: false,
						exitCode: null,
						timedOut: false,
						stdout: out,
						stderr: err,
						error: "cancelled by user"
					});
				};
				opts.onCancel?.(cancel);
				conn.exec(session ? sessionLine(command) : command, (execError, channel) => {
					if (execError !== void 0 && execError !== null) {
						finish({
							success: false,
							exitCode: null,
							timedOut: false,
							stdout: "",
							stderr: "",
							error: execError.message
						});
						return;
					}
					if (settled) setTimeout(() => {
						if (pgid === void 0) warnOnce();
						try {
							channel.close();
						} catch {}
					}, GROUP_KILL_GRACE_MS).unref?.();
					else stream = channel;
					channel.on("close", (code, signalName) => {
						if (code !== null && code !== void 0 || signalName !== null && signalName !== void 0) exited = true;
						if (timedOut && session && pgid === void 0) warnOnce();
						if (pendingForward !== "") {
							const newline = pendingForward.indexOf("\n");
							const visible = markerPending ? pendingForward.startsWith(PGID_MARKER) ? newline < 0 ? "" : pendingForward.slice(newline + 1) : pendingForward : pendingForward;
							pendingForward = "";
							forward("out", visible);
						}
						const tailOut = outDecoder.end();
						const tailErr = errDecoder.end();
						if (tailOut !== "") {
							out = appendCapped(out, tailOut);
							forward("out", tailOut);
						}
						if (tailErr !== "") {
							err = appendCapped(err, tailErr);
							forward("err", tailErr);
						}
						finish({
							success: code === 0,
							exitCode: code,
							timedOut: false,
							stdout: out,
							stderr: err
						});
					});
					channel.on("data", (chunk) => {
						const text = outDecoder.write(chunk);
						out = appendCapped(out, text);
						if (pgid !== void 0 || !markerPending) {
							forward("out", text);
							return;
						}
						pendingForward += text;
						const marker = takePgid(out);
						if (marker.pgid !== void 0) {
							pgid = marker.pgid;
							out = marker.out;
							markerPending = false;
							if (timedOut) terminateGroup();
							if (cancelled) terminateGroup();
							const newline = pendingForward.indexOf("\n");
							const visible = newline < 0 ? "" : pendingForward.slice(newline + 1);
							pendingForward = "";
							forward("out", visible);
							return;
						}
						if (out.includes("\n") || pendingForward.length > 8192) {
							markerPending = false;
							const visible = pendingForward;
							pendingForward = "";
							forward("out", visible);
						}
					});
					channel.stderr.on("data", (chunk) => {
						const text = errDecoder.write(chunk);
						err = appendCapped(err, text);
						forward("err", text);
					});
				});
			});
		} catch (error) {
			this.release(alias);
			return {
				success: false,
				exitCode: null,
				timedOut: false,
				stdout: "",
				stderr: "",
				durationMs: Date.now() - started,
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}
	/** Open an interactive PTY shell. The caller owns the channel lifecycle. */
	async shell(alias, opts = {}) {
		/**
		* Prefer the DEDICATED PTY connection so terminal bytes never queue behind
		* SFTP/git/exec traffic on the shared one (SSH has no channel priority).
		* A host that refuses the extra connection still gets a terminal: the fallback
		* is the shared connection, exactly the old behaviour.
		*/
		let conn;
		let dedicated = true;
		try {
			conn = await this.acquireShell(alias);
			this.holdIn(this.shellConns, alias);
		} catch (error) {
			dedicated = false;
			conn = await this.acquire(alias);
			this.hold(alias);
			if (!(error instanceof Error) || !isConnectionFailure(error)) console.warn("[dsh-remote-vs] dedicated PTY connection failed; using the shared one:", error);
		}
		try {
			const channel = await new Promise((resolve, reject) => {
				conn.shell({
					cols: opts.cols ?? 80,
					rows: opts.rows ?? 24,
					term: "xterm-256color"
				}, (error, stream) => {
					if (error !== void 0 && error !== null) reject(error);
					else resolve(stream);
				});
			});
			channel.once("close", () => {
				if (dedicated) this.releaseIn(this.shellConns, alias);
				else this.release(alias);
			});
			this.markOk(alias);
			return channel;
		} catch (error) {
			if (dedicated) this.releaseIn(this.shellConns, alias);
			else this.release(alias);
			if (isConnectionFailure(error)) this.markError(alias, error);
			throw error;
		}
	}
	/** Open one exec channel. The caller owns the channel lifecycle. */
	async execChannel(alias, command) {
		const conn = await this.acquire(alias);
		this.hold(alias);
		try {
			const channel = await new Promise((resolve, reject) => {
				conn.exec(command, (error, stream) => {
					if (error !== void 0 && error !== null) reject(error);
					else resolve(stream);
				});
			});
			channel.once("close", () => this.release(alias));
			this.markOk(alias);
			return channel;
		} catch (error) {
			this.release(alias);
			if (isConnectionFailure(error)) this.markError(alias, error);
			throw error;
		}
	}
	/**
	* Open one direct-tcpip channel to a TCP target reachable FROM the remote
	* host (`ssh -L` semantics). The caller owns the channel lifecycle.
	*
	* Deliberately NOT routed through `acquireSlot`: that table bounds the pool's
	* own request channels (exec / SFTP) and its ceiling leaves room for the
	* long-lived channels the pool does not count (PTY terminals, the subprocess
	* runtime, the helper). A local forward is the same kind of long-lived
	* channel, so the port panel keeps its own per-alias budget instead.
	*
	* A channel-open failure is NOT a connection failure: sshd answers
	* "administratively prohibited" when forwarding is forbidden and "connect
	* failed" when the remote port is closed — both on a perfectly healthy link,
	* and painting the connection chip red for either would send the user to
	* debug their network. Real transport failures still arrive through the
	* pooled connection's own close/error events.
	*/
	async forwardOut(alias, dstHost, dstPort, srcPort = 0) {
		const conn = await this.acquire(alias);
		this.hold(alias);
		/**
		* What the channel-open callback does after the deadline already answered.
		*
		* ssh2 has no channel-open timeout (see `openSession`'s note), so the
		* deadline above can fire while the callback is still in flight. Without
		* this flag a late success would hand back a channel nobody owns — a
		* direct-tcpip that outlives every reference to it. The late channel is
		* closed here instead, and no `close`→`release` handler is attached to it
		* (the hold was already released by the timeout path).
		*/
		let settled = false;
		try {
			const channel = await withDeadline(new Promise((resolve, reject) => {
				conn.forwardOut("127.0.0.1", srcPort, dstHost, dstPort, (error, stream) => {
					if (settled) {
						if (error === void 0 || error === null) try {
							stream.close();
						} catch {}
						return;
					}
					settled = true;
					if (error !== void 0 && error !== null) reject(error);
					else resolve(stream);
				});
			}), CONTROL_TIMEOUT_MS, `forwarding channel to ${dstHost}:${dstPort} did not open within ${CONTROL_TIMEOUT_MS / 1e3}s`);
			channel.once("close", () => this.release(alias));
			this.markOk(alias);
			return channel;
		} catch (error) {
			settled = true;
			this.release(alias);
			throw error;
		}
	}
	/** Run one callback with a fresh SFTP session (closed afterwards). */
	async withSftp(alias, fn, opts = {}) {
		await this.acquireSlot(alias);
		let conn;
		try {
			conn = await this.acquire(alias);
		} catch (error) {
			this.releaseSlot(alias);
			throw error;
		}
		this.hold(alias);
		try {
			const sftp = await this.openSession(conn);
			try {
				const limit = opts.timeoutMs ?? SFTP_OP_TIMEOUT_MS;
				const result = limit <= 0 ? await fn(sftp) : await withDeadline(fn(sftp), limit, `SFTP operation timed out after ${limit / 1e3}s`);
				this.markOk(alias);
				return result;
			} finally {
				try {
					sftp.end();
				} catch {}
			}
		} catch (error) {
			this.noteOpFailure(alias, error);
			throw error;
		} finally {
			this.release(alias);
			this.releaseSlot(alias);
		}
	}
	/**
	* Run one bulk-transfer callback with a dedicated SFTP session, plus extra
	* channel windows on demand (`addChannel`).
	*
	* Why extra channels: ssh2 (Channel.js `MAX_WINDOW`) and OpenSSH cap ONE SSH
	* channel's window at 2 MiB, so a single channel can never hold 8 MiB of READs
	* in flight however much concurrency the caller asks for; the rest queue
	* client-side. Each extra session is another 2 MiB window. Measured against a
	* real host (96 MiB file, 256 KiB chunks, same total concurrency):
	* 1 channel 28.6 MiB/s, 2 channels 46.1, 4 channels 51.3 — two channels take
	* most of the gain, four cost twice the channels for little more. Uploads
	* showed no such gain (server-side write bound: 46.0 → 50.4 MiB/s), so only
	* downloads spread out.
	*
	* `addChannel` is best-effort and late on purpose: a small download must not
	* pay for a second channel, so the caller opens one only after it has the
	* size. It never queues for a channel slot (a 30 s wait would stall a body that
	* is already streaming) and a late call after the callback settled is a no-op.
	* Every session opened here is closed, and every slot/hold released, when the
	* callback settles — including a partially successful `addChannel`.
	*
	* There is no wall-clock deadline of its own: streaming is progress-bounded by
	* the caller, and the caller also bounds the one-shot SFTP calls it makes
	* around the stream (metadata phase, optional channel opens), because nothing
	* there produces progress to watch.
	*/
	async withTransferSftp(alias, fn) {
		const sessions = [];
		let slots = 0;
		let holds = 0;
		/** Set when the callback settles: a late `addChannel` must not leak resources. */
		let closed = false;
		let conn;
		try {
			await this.acquireSlot(alias);
			slots += 1;
			conn = await this.acquire(alias);
			this.hold(alias);
			holds += 1;
			sessions.push(await this.openSession(conn));
			const addChannel = async () => {
				if (closed) return void 0;
				if (!this.tryAcquireSlot(alias)) return void 0;
				slots += 1;
				this.hold(alias);
				holds += 1;
				try {
					const extra = await this.openSession(conn);
					if (closed) {
						try {
							extra.end();
						} catch {}
						return;
					}
					sessions.push(extra);
					return extra;
				} catch {
					return;
				}
			};
			const result = await fn(sessions[0], addChannel);
			this.markOk(alias);
			return result;
		} catch (error) {
			this.noteOpFailure(alias, error);
			throw error;
		} finally {
			closed = true;
			for (const session of sessions) try {
				session.end();
			} catch {}
			for (let i = 0; i < holds; i += 1) this.release(alias);
			for (let i = 0; i < slots; i += 1) this.releaseSlot(alias);
		}
	}
	/**
	* Run one callback on this alias's long-lived BROWSE SFTP session.
	*
	* Why: every list/stat/read used to open its own SFTP session, which is a
	* whole channel-open round trip BEFORE the operation's own round trip. A single
	* folder open is one list plus a stat per entry the explorer probes, and the
	* panel's revision refresh re-lists every open directory, so that open/close
	* churn sat directly on the click-to-pixels path. The session is shared by
	* every browse request for the alias; ssh2 multiplexes concurrent requests
	* over one channel by packet id (the same request map fastGet/fastPut use).
	*
	* Only read-only browse operations use it (`RemoteFiles.list/stat/read`):
	* writes, uploads and downloads keep their own short-lived session, so a
	* mutation never inherits a channel that a previous request may have left in
	* an odd state.
	*
	* The session holds one channel slot and one connection hold while it exists,
	* which is what a per-request session took too, so peak channel usage against
	* the server's MaxSessions does not change. The trade-off is that the slot
	* stays PARKED for up to `BROWSE_IDLE_MS` after the last request: the extras a
	* bulk transfer asks for use `tryAcquireSlot`, so they never wait on it.
	*/
	async withBrowseSftp(alias, fn, opts = {}) {
		let lease;
		try {
			lease = await this.leaseBrowse(alias);
		} catch (error) {
			this.noteOpFailure(alias, error);
			throw error;
		}
		const limit = opts.timeoutMs ?? SFTP_OP_TIMEOUT_MS;
		try {
			const result = limit <= 0 ? await fn(lease.sftp) : await withDeadline(fn(lease.sftp), limit, `SFTP operation on ${alias} timed out after ${limit / 1e3}s`);
			this.markOk(alias);
			return result;
		} catch (error) {
			if (error instanceof DeadlineError) lease.state.stale = true;
			else this.noteOpFailure(alias, error);
			throw error;
		} finally {
			this.touchBrowse(alias, lease.state);
		}
	}
	/** Upload one local file to an absolute remote path (parallel fastPut). */
	async putFile(alias, localPath, remotePath) {
		await this.withSftp(alias, async (sftp) => {
			await new Promise((resolve, reject) => {
				let settled = false;
				let timer;
				const finish = (error) => {
					if (settled) return;
					settled = true;
					if (timer !== void 0) clearTimeout(timer);
					if (error === void 0) resolve();
					else reject(error);
				};
				const arm = () => {
					if (timer !== void 0) clearTimeout(timer);
					timer = setTimeout(() => {
						try {
							sftp.end();
						} catch {}
						finish(/* @__PURE__ */ new Error(`SFTP upload stalled: no progress for ${UPLOAD_IDLE_MS / 1e3}s`));
					}, UPLOAD_IDLE_MS);
					timer.unref?.();
				};
				arm();
				sftp.fastPut(localPath, remotePath, {
					concurrency: 64,
					chunkSize: 256 * 1024,
					step: () => {
						arm();
					}
				}, (error) => {
					finish(error === void 0 || error === null ? void 0 : new Error(error.message));
				});
			});
		}, { timeoutMs: 0 });
	}
	/**
	* Open one SFTP session under its own deadline.
	*
	* ssh2 has no channel-open timeout: a server that never answers leaves this
	* promise pending forever, which pins the connection's hold count and blocks
	* idle re-arming (the "SSH looks dead" symptom) while the HTTP request hangs.
	*
	* The deadline is spelled out here instead of wrapped around the promise
	* because the ANSWER can arrive after it: `conn.sftp`'s callback is the only
	* place that can still see the session, and a late one would otherwise leak a
	* server-side channel that no slot or hold accounts for (the caller has long
	* returned its own and moved on).
	*/
	openSession(conn) {
		return new Promise((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(new DeadlineError(`SFTP session open timed out after ${SFTP_OP_TIMEOUT_MS / 1e3}s`));
			}, SFTP_OP_TIMEOUT_MS);
			timer.unref?.();
			const finish = (error, session) => {
				if (settled) {
					try {
						session?.end();
					} catch {}
					return;
				}
				settled = true;
				clearTimeout(timer);
				if (error !== void 0 && error !== null) reject(error);
				else resolve(session);
			};
			try {
				conn.sftp((error, session) => finish(error, session));
			} catch (error) {
				finish(error);
			}
		});
	}
	/**
	* Take the browse channel for one operation (open it on first use).
	*
	* The returned lease counts as one in-flight operation; the caller's `finally`
	* calls touchBrowse(). An open failure takes neither a slot nor a hold, so a
	* failed host does not leave the pool's accounting skewed.
	*/
	async leaseBrowse(alias) {
		const state = this.browseState(alias);
		if (state.stale) {
			this.evictBrowse(alias, state);
			return this.leaseBrowse(alias);
		}
		if (state.idle !== void 0) {
			clearTimeout(state.idle);
			state.idle = void 0;
		}
		if (state.session !== void 0) {
			state.active += 1;
			return {
				state,
				sftp: state.session
			};
		}
		if (state.opening === void 0) state.opening = this.openBrowse(alias, state);
		const opening = state.opening;
		try {
			const sftp = await opening;
			state.active += 1;
			return {
				state,
				sftp
			};
		} finally {
			if (state.opening === opening) state.opening = void 0;
		}
	}
	/**
	* Open the browse session: a channel slot + a connection hold + the SFTP
	* session itself, all released together by evictBrowse().
	*/
	async openBrowse(alias, state) {
		await this.acquireSlot(alias);
		let conn;
		try {
			conn = await this.acquire(alias);
		} catch (error) {
			this.releaseSlot(alias);
			throw error;
		}
		this.hold(alias);
		state.leased = true;
		try {
			const sftp = await this.openSession(conn);
			if (this.browsed.get(alias) !== state || !state.leased) {
				try {
					sftp.end();
				} catch {}
				throw new Error(`host ${alias} was disconnected while opening the browse session`);
			}
			state.session = sftp;
			sftp.on("close", () => {
				if (state.session !== sftp) return;
				state.session = void 0;
				this.evictBrowse(alias, state);
			});
			return sftp;
		} catch (error) {
			this.evictBrowse(alias, state);
			throw error;
		}
	}
	/** One completed browse operation: idle-close the channel when it is unused. */
	touchBrowse(alias, state) {
		if (state.active > 0) state.active -= 1;
		if (state.active > 0) return;
		if (state.stale) {
			this.evictBrowse(alias, state);
			return;
		}
		if (state.idle !== void 0) clearTimeout(state.idle);
		state.idle = setTimeout(() => {
			state.idle = void 0;
			if (state.active === 0) this.evictBrowse(alias, state);
		}, BROWSE_IDLE_MS);
		state.idle.unref?.();
	}
	/**
	* Close the browse session and give its slot and hold back. Idempotent; every
	* way the session can end (idle, open failure, channel close, connection drop)
	* goes through here so the accounting cannot drift.
	*
	* `expected` ties the eviction to ONE session object: a timer or a channel
	* `close` event that fires after the state was already replaced must not close
	* its successor. Callers that end the connection (drop/dispose) omit it.
	*/
	evictBrowse(alias, expected) {
		const state = this.browsed.get(alias);
		if (state === void 0) return;
		if (expected !== void 0 && state !== expected) return;
		this.browsed.delete(alias);
		if (state.idle !== void 0) {
			clearTimeout(state.idle);
			state.idle = void 0;
		}
		const session = state.session;
		state.session = void 0;
		if (session !== void 0) try {
			session.end();
		} catch {}
		if (state.leased) {
			state.leased = false;
			this.release(alias);
			this.releaseSlot(alias);
		}
	}
	browseState(alias) {
		const existing = this.browsed.get(alias);
		if (existing !== void 0) return existing;
		const created = {
			session: void 0,
			opening: void 0,
			active: 0,
			stale: false,
			leased: false,
			idle: void 0
		};
		this.browsed.set(alias, created);
		return created;
	}
	/**
	* Take one channel slot for `alias`, waiting FIFO when the limit is reached.
	* The wait is bounded: waiting forever behind a peer that never finishes is
	* worse than a readable error naming the cause and what to do about it.
	*/
	async acquireSlot(alias) {
		const state = this.slotState(alias);
		if (state.active < CHANNEL_LIMIT) {
			state.active += 1;
			return;
		}
		await new Promise((resolve, reject) => {
			const waiter = {
				granted: false,
				resolve,
				reject,
				timer: void 0
			};
			waiter.timer = setTimeout(() => {
				if (waiter.granted) return;
				waiter.granted = true;
				const index = state.queue.indexOf(waiter);
				if (index >= 0) state.queue.splice(index, 1);
				reject(/* @__PURE__ */ new Error(`remote host ${alias} is busy: ${CHANNEL_LIMIT} operations already hold channels (this one waited ${CHANNEL_WAIT_MS / 1e3}s — retry once the earlier work finishes)`));
			}, CHANNEL_WAIT_MS);
			waiter.timer.unref?.();
			state.queue.push(waiter);
		});
	}
	/**
	* Take one channel slot only if one is free RIGHT NOW; never queue.
	*
	* Optional work (a bulk transfer's second channel) must not wait behind
	* `CHANNEL_WAIT_MS` of other operations: a "best effort" extra channel that
	* delays the body of an already-streaming download by 30 s is worse than the
	* one channel the transfer would have used anyway. A queued waiter also blocks
	* the attempt on purpose — it has been waiting longer, and stealing its slot
	* would just move the wait.
	*/
	tryAcquireSlot(alias) {
		const state = this.slotState(alias);
		if (state.active >= CHANNEL_LIMIT || state.queue.length > 0) return false;
		state.active += 1;
		return true;
	}
	/** Give a slot back, handing it straight to the longest-waiting operation. */
	releaseSlot(alias) {
		const state = this.slots.get(alias);
		if (state === void 0) return;
		const waiter = state.queue.shift();
		if (waiter !== void 0) {
			if (waiter.timer !== void 0) clearTimeout(waiter.timer);
			waiter.granted = true;
			waiter.resolve();
			return;
		}
		if (state.active > 0) state.active -= 1;
		if (state.active === 0) this.slots.delete(alias);
	}
	slotState(alias) {
		const existing = this.slots.get(alias);
		if (existing !== void 0) return existing;
		const created = {
			active: 0,
			queue: []
		};
		this.slots.set(alias, created);
		return created;
	}
	/**
	* Whether this alias offers a util-linux-style `setsid --wait` — the only
	* shape that both detaches the command into its own session AND reports its
	* exit code (p2/ssh-proc.ts:7-21 learned that plain `setsid` double-forks and
	* the channel then reports the wrapper's exit 0, which would turn every exit
	* fact into fiction). The probe also verifies status propagation, so a broken
	* setsid fails it instead of quietly corrupting exit codes.
	*
	* Probed once per alias: the probe is a whole extra channel, and exec is the
	* hot path (SCM polling, search, agent tools). A remote without a compatible
	* setsid keeps the pre-existing behaviour, where a timeout can only close the
	* channel, and says so in the log.
	*
	* Only SUCCESS is remembered. A failed probe means "this host has no
	* setsid OR this one call did not get through", and folding the second case
	* into the first would be permanent: a single transient blip — a dropped
	* connection, a 15 s probe timeout on a slow link — would silently switch the
	* alias to the unwrapped path for the rest of the process, i.e. quietly
	* disable the kill this wrapper exists to perform. Every other backoff in
	* this codebase retries rather than blacklisting; so does this one now.
	*/
	supportsSetsid(alias) {
		const cached = this.setsidProbes.get(alias);
		if (cached !== void 0) return cached;
		const probe = this.exec(alias, SETSID_PROBE, {
			timeoutMs: CONTROL_TIMEOUT_MS,
			bare: true
		}).then((result) => result.stdout.includes(SETSID_PROBE_MARK), () => false);
		this.setsidProbes.set(alias, probe);
		probe.then((supported) => {
			if (!supported && this.setsidProbes.get(alias) === probe) this.setsidProbes.delete(alias);
		});
		return probe;
	}
	/** Hold the connection against idle eviction (balanced by release). */
	hold(alias) {
		this.holdIn(this.conns, alias);
	}
	holdIn(map, alias) {
		const pooled = map.get(alias);
		if (pooled === void 0) return;
		pooled.held += 1;
		pooled.lastUse = Date.now();
		if (pooled.timer !== void 0) {
			clearTimeout(pooled.timer);
			pooled.timer = void 0;
		}
	}
	release(alias) {
		this.releaseIn(this.conns, alias);
	}
	releaseIn(map, alias) {
		const pooled = map.get(alias);
		if (pooled === void 0) return;
		if (pooled.held > 0) pooled.held -= 1;
		pooled.lastUse = Date.now();
		if (pooled.held > 0) return;
		if (pooled.timer !== void 0) clearTimeout(pooled.timer);
		pooled.timer = setTimeout(() => this.evictFrom(map, alias), IDLE_MS);
		if (typeof pooled.timer === "object" && "unref" in pooled.timer) pooled.timer.unref();
	}
	async acquire(alias) {
		return this.acquireIn(this.conns, alias);
	}
	/** `acquire` for the dedicated PTY connection map. */
	async acquireShell(alias) {
		return this.acquireIn(this.shellConns, alias);
	}
	async acquireIn(map, alias) {
		const pooled = map.get(alias);
		if (pooled !== void 0 && pooled.connecting !== void 0) return pooled.connecting;
		if (pooled !== void 0) {
			pooled.lastUse = Date.now();
			return pooled.conn;
		}
		const entry = {
			conn: void 0,
			timer: void 0,
			lastUse: Date.now(),
			connecting: void 0,
			held: 0
		};
		map.set(alias, entry);
		/**
		* The entry object IS the ownership token: `drop()` deletes it and a later
		* `acquire()` creates a NEW one, so comparing identity answers "does this
		* dial still own the alias?" without any extra field.
		*
		* Both halves matter. Without the success check, a dial that finishes after
		* `drop()` (host edited/deleted while connecting) leaves a live connection
		* nobody can ever close: the entry is out of the map, `release()` is a no-op
		* so no idle timer arms, and `dispose()` only walks the map. Without the
		* failure check, a failed OLD dial deletes the NEW entry by alias.
		*/
		entry.connecting = this.dial(alias).then((conn) => {
			if (map.get(alias) !== entry) {
				try {
					conn.end();
				} catch {}
				throw new Error(`host ${alias} was disconnected while connecting`);
			}
			entry.conn = conn;
			entry.connecting = void 0;
			this.markOk(alias);
			conn.on("close", () => {
				if (map.get(alias) !== entry) return;
				this.markError(alias, /* @__PURE__ */ new Error("connection closed"));
				this.evictFrom(map, alias);
			});
			conn.on("error", (error) => {
				if (map.get(alias) !== entry) return;
				this.markError(alias, error);
				this.evictFrom(map, alias);
			});
			this.releaseIn(map, alias);
			return conn;
		}, (error) => {
			if (map.get(alias) === entry) map.delete(alias);
			this.markError(alias, error);
			throw error;
		});
		return entry.connecting;
	}
	/** Evict ONE alias from ONE map (host removal drops both maps explicitly). */
	evictFrom(map, alias) {
		const pooled = map.get(alias);
		if (pooled === void 0) return;
		map.delete(alias);
		if (pooled.timer !== void 0) clearTimeout(pooled.timer);
		try {
			pooled.conn.end();
		} catch {}
	}
	/**
	* The ssh2 client factory.
	*
	* A seam, not a preference: `dial` is the only place that has to react to
	* "connect emitted close but never error", and a fake client is the only way a
	* self-check can produce that shape without a real server. Production never
	* overrides it.
	*/
	makeClient() {
		return new import_lib.Client();
	}
	dial(alias) {
		const host = this.store.require(alias);
		return new Promise((resolve, reject) => {
			const conn = this.makeClient();
			let settled = false;
			let guard;
			const fail = (error) => {
				if (settled) return;
				settled = true;
				if (guard !== void 0) clearTimeout(guard);
				try {
					conn.end();
				} catch {}
				reject(explainAuthError(host, error));
			};
			conn.on("ready", () => {
				if (settled) return;
				settled = true;
				if (guard !== void 0) clearTimeout(guard);
				resolve(conn);
			});
			conn.on("error", (error) => fail(error));
			/**
			* ssh2 turns a socket close into an `error` only when the SSH banner never
			* arrived (client.js `onDone`: `wasConnected && !sawHeader`). A clean FIN
			* after the banner — a server restart or a middlebox dropping the flow
			* during KEX/auth — emits `end`/`close` and nothing else, which used to
			* leave this promise pending forever while the caller held a channel slot.
			*/
			conn.on("close", () => fail(/* @__PURE__ */ new Error("connection closed during SSH handshake")));
			guard = setTimeout(() => {
				fail(/* @__PURE__ */ new Error(`SSH handshake did not settle within ${(READY_TIMEOUT_MS + DIAL_GUARD_MARGIN_MS) / 1e3}s`));
			}, READY_TIMEOUT_MS + DIAL_GUARD_MARGIN_MS);
			guard.unref?.();
			conn.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
				const password = host.auth.kind === "password" ? host.auth.password : void 0;
				if (password !== void 0 && prompts.length === 1 && prompts[0]?.echo === false) {
					try {
						finish([password]);
					} catch {}
					return;
				}
				fail(/* @__PURE__ */ new Error("server requested keyboard-interactive auth (unsupported shape; use key auth or a password challenge)"));
				try {
					finish([]);
				} catch {}
			});
			const hostVerifier = (key) => {
				const fingerprint = createHash("sha256").update(key).digest("base64");
				const known = this.hostKeys.get(alias);
				if (known === void 0) this.hostKeys.set(alias, fingerprint);
				else if (known !== fingerprint) console.warn(`[dsh-remote-vs] host key changed for ${alias}: was ${known}, now ${fingerprint}`);
				return true;
			};
			try {
				if (host.auth.kind === "key") {
					const keyPath = host.auth.keyPath;
					conn.connect({
						host: host.host,
						port: host.port,
						username: host.user,
						privateKey: readFileSync(keyPath),
						passphrase: host.auth.passphrase,
						readyTimeout: READY_TIMEOUT_MS,
						keepaliveInterval: 3e4,
						keepaliveCountMax: 3,
						hostVerifier
					});
				} else conn.connect({
					host: host.host,
					port: host.port,
					username: host.user,
					password: host.auth.password,
					tryKeyboard: true,
					readyTimeout: READY_TIMEOUT_MS,
					keepaliveInterval: 3e4,
					keepaliveCountMax: 3,
					hostVerifier
				});
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}
};
/**
* Translate ssh2's generic auth failure into something actionable. Never
* includes secrets — only the entry shape and the likely server-side causes.
*/
function explainAuthError(host, error) {
	if (host.auth.kind !== "password" || !/authentication methods failed/i.test(error.message)) return error;
	const hints = ["verify the password (it may have changed/expired)", "many servers only offer keyboard-interactive (now auto-answered — retry the test)"];
	if (host.user === "root") hints.push("OpenSSH 7+ defaults prohibit password login for root (PermitRootLogin); use a non-root user or switch to key auth");
	return /* @__PURE__ */ new Error(`${error.message} — password rejected by the server; ${hints.join("; ")}`);
}
/** Append with a 2 MiB cap and a truncation marker. */
function appendCapped(current, chunk) {
	if (current.length >= OUTPUT_CAP) return current;
	const next = current + chunk;
	if (next.length <= OUTPUT_CAP) return next;
	return next.slice(0, OUTPUT_CAP) + TRUNCATED_MARKER;
}
/**
* Put one shell line in its own session/process group.
*
* `setsid --wait` is what makes the timeout able to end the command: the
* wrapper echoes its own pid, which IS the new session's process-group id, and
* this pid is what `kill -- -<pgid>` needs. Everything the command spawns stays
* in that group, so a pipeline's whole tree dies with it — `channel.close()`
* only releases our side, and `channel.signal()` addresses the outer shell.
*
* `$0` is the login shell sshd itself used for this line, so a bashism in a
* caller's line keeps working on a remote whose /bin/sh is dash (a leading dash
* — login-shell argv[0] — is not an executable, hence the fallback to `sh`).
* The line travels as a positional argument rather than being re-quoted into
* the wrapper, so quoting and `$` expansion stay exactly as they were.
*/
function sessionLine(command) {
	return `rv_shell="\${0:-sh}"; case "\$rv_shell" in -*) rv_shell=sh;; esac; exec ${`setsid --wait "$rv_shell" -c 'echo ${PGID_MARKER}$$; exec "$0" -c "$1"' "$rv_shell" ${shq$1(command)}`}`;
}
/** Single-quote one word for POSIX sh (same quoting p2/ssh-proc.ts uses). */
function shq$1(word) {
	return `'${word.replaceAll("'", `'\\''`)}'`;
}
/**
* Consume the session wrapper's leading `RV_PID=<pgid>` line. The wrapper
* writes it before it execs the target, so it is the first line of the stream
* by construction; anything else is left untouched, which keeps a command that
* happens to print a similar first line intact.
*/
function takePgid(out) {
	const newline = out.indexOf("\n");
	if (newline < 0) return {
		pgid: void 0,
		out
	};
	const line = out.slice(0, newline).replace(/\r$/, "");
	if (!line.startsWith(PGID_MARKER)) return {
		pgid: void 0,
		out
	};
	const digits = line.slice(7);
	if (!/^\d+$/.test(digits)) return {
		pgid: void 0,
		out
	};
	return {
		pgid: Number(digits),
		out: out.slice(newline + 1)
	};
}
/**
* A timed-out line whose process group was never learned cannot be killed, so
* say it out loud instead of pretending the command stopped.
*/
function warnDetached(alias) {
	console.warn(`[dsh-remote-vs] exec timed out on ${alias}: the channel is closed but the remote command may still be running (no killable process group)`);
}
/**
* Reject when `promise` has not settled within `ms`, so a stalled remote
* callback cannot keep a session (and its pooled connection) alive forever.
*/
function withDeadline(promise, ms, message) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new DeadlineError(message)), ms);
		timer.unref?.();
		promise.then((value) => {
			clearTimeout(timer);
			resolve(value);
		}, (error) => {
			clearTimeout(timer);
			reject(error instanceof Error ? error : new Error(String(error)));
		});
	});
}
/** What every forward binds to (never a LAN address). */
const LOOPBACK = "127.0.0.1";
/** Alias grammar (same rule the host store enforces). */
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
* Hostname / IPv4 / IPv6 accepted as the REMOTE target.
*
* The string never reaches a shell — ssh2 hands it to the server as the
* direct-tcpip destination — so this is a sanity fence (no whitespace, no
* control characters, bounded length) rather than escaping. A hostname with
* underscores and an IPv6 literal with brackets are both legal here.
*/
const REMOTE_HOST_RE = /^[A-Za-z0-9._:[\]%-]{1,255}$/;
function messageOf$2(error) {
	return error instanceof Error ? error.message : String(error ?? "");
}
/**
* Validate one request from the browser.
*
* `localPort` deliberately accepts 0 = "let the OS pick": the panel defaults to
* auto-assignment because a fixed port invites EADDRINUSE from whatever else
* the developer runs locally.
*/
function validateForwardRequest(input) {
	if (typeof input !== "object" || input === null) return {
		ok: false,
		error: "a JSON object is required"
	};
	const raw = input;
	if (typeof raw.alias !== "string" || !ALIAS_RE.test(raw.alias)) return {
		ok: false,
		error: "alias must be 1-64 chars of letters/digits/._- and start with an alphanumeric"
	};
	if (typeof raw.remoteHost !== "string" || !REMOTE_HOST_RE.test(raw.remoteHost)) return {
		ok: false,
		error: "remoteHost must be a hostname or IP address"
	};
	const remotePort = raw.remotePort;
	if (typeof remotePort !== "number" || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) return {
		ok: false,
		error: "remotePort must be an integer between 1 and 65535"
	};
	const localRaw = raw.localPort;
	let localPort = 0;
	if (localRaw !== void 0 && localRaw !== null) {
		if (typeof localRaw !== "number" || !Number.isInteger(localRaw) || localRaw < 0 || localRaw > 65535) return {
			ok: false,
			error: "localPort must be 0 (auto) or an integer between 1 and 65535"
		};
		localPort = localRaw;
	}
	return {
		ok: true,
		value: {
			alias: raw.alias,
			remoteHost: raw.remoteHost,
			remotePort,
			...localPort === 0 ? {} : { localPort }
		}
	};
}
/**
* Stable rule identity.
*
* `localPort` is the port the CALLER asked for (0 = auto), not the one the OS
* assigned: asking twice for the same automatic rule must return the running
* forward instead of opening a second listener on a second random port.
*/
function forwardIdOf(alias, remoteHost, remotePort, localPort) {
	return `${alias}|${remoteHost}|${remotePort}|${localPort}`;
}
/** What the panel copies / opens for one forward. */
function forwardLocalUrl(localPort) {
	return `http://127.0.0.1:${localPort}/`;
}
/** Listens on loopback and proxies every accepted connection over SSH. */
var ForwardManager = class {
	deps;
	forwards = /* @__PURE__ */ new Map();
	/**
	* Rules whose listener is still BINDING.
	*
	* Two clicks (or a restore racing the panel's own poll) must share one bind:
	* without this map the second call binds a SECOND listener on a different
	* automatic port, overwrites the first entry in `forwards`, and leaves the
	* first listener orphaned — unreachable from the panel and never closed.
	*/
	starting = /* @__PURE__ */ new Map();
	/**
	* Rules stopped while their listener was still BINDING.
	*
	* A pending bind is not in `forwards` yet, so `stop()`, `stopAlias()`,
	* `stopAll()` and `dispose()` used to see nothing to close: the listener the
	* OS was about to hand out stayed bound with no panel row left to stop it
	* (click a forward, immediately disable the plugin or delete the host, and
	* `127.0.0.1:<port>` stayed taken until the Host restarted). The id sits here
	* until the bind settles; a settling bind that finds its id records itself as
	* stopped and closes the fresh listener instead of entering `forwards`.
	*/
	stoppedWhileBinding = /* @__PURE__ */ new Set();
	/** Set on unload so a bind that settles afterwards closes itself. */
	disposed = false;
	constructor(deps) {
		this.deps = deps;
	}
	/**
	* Start one rule (idempotent for the same requested tuple).
	*
	* Resolves with the state once the local listener is BOUND; a bind failure
	* (EADDRINUSE, permission) rejects, which the route maps to a caller-visible
	* status. A remote-side failure cannot be known yet — the first connection
	* discovers it and records it on the rule.
	*/
	async start(request) {
		const requestedLocalPort = request.localPort ?? 0;
		const id = forwardIdOf(request.alias, request.remoteHost, request.remotePort, requestedLocalPort);
		const existing = this.forwards.get(id);
		if (existing !== void 0) return this.stateOf(existing);
		const inFlight = this.starting.get(id);
		if (inFlight !== void 0) return inFlight;
		const pendingOnAlias = [...this.starting.keys()].filter((key) => key.startsWith(`${request.alias}|`)).length;
		const perAlias = [...this.forwards.values()].filter((forward) => forward.alias === request.alias).length + pendingOnAlias;
		const maxPerAlias = this.deps.maxPerAlias ?? 16;
		if (perAlias >= maxPerAlias) throw new Error(`host ${request.alias} already has ${maxPerAlias} local forwards; stop one first`);
		const pending = this.bindForward(id, request, requestedLocalPort).then((forward) => {
			if (this.disposed || this.stoppedWhileBinding.has(id)) {
				this.closeForward(forward);
				throw new Error(this.disposed ? "the port-forward manager was unloaded while the rule was binding" : "the rule was stopped while its local listener was binding");
			}
			this.forwards.set(id, forward);
			this.log("info", `forward ${id} listening on 127.0.0.1:${forward.localPort}`);
			return this.stateOf(forward);
		}).finally(() => {
			this.starting.delete(id);
			this.stoppedWhileBinding.delete(id);
		});
		this.starting.set(id, pending);
		return pending;
	}
	/** Stop one rule. Returns false when the id is unknown (already stopped). */
	stop(id) {
		const forward = this.forwards.get(id);
		if (forward !== void 0) {
			this.forwards.delete(id);
			this.closeForward(forward);
			this.log("info", `forward ${id} stopped`);
			return true;
		}
		if (!this.starting.has(id)) return false;
		this.stoppedWhileBinding.add(id);
		this.log("info", `forward ${id} stopped while binding; its listener will close on settle`);
		return true;
	}
	/**
	* Stop every rule for one host alias (the host was deleted).
	*
	* A deleted host disappears from the panel — there is no row left to press
	* "stop" on — so leaving its listeners bound would squat the local ports
	* until the Host restarts. Returns how many rules were closed.
	*/
	stopAlias(alias) {
		let stopped = 0;
		for (const [id, forward] of [...this.forwards]) {
			if (forward.alias !== alias) continue;
			this.forwards.delete(id);
			this.closeForward(forward);
			stopped += 1;
		}
		for (const id of [...this.starting.keys()]) {
			if (this.forwards.has(id) || !id.startsWith(`${alias}|`)) continue;
			this.stoppedWhileBinding.add(id);
			stopped += 1;
		}
		if (stopped > 0) this.log("info", `stopped ${stopped} forward(s) for deleted host ${alias}`);
		return stopped;
	}
	/**
	* Stop every rule but keep the manager alive (plugin disabled).
	*
	* `dispose()` is the unload path and flips a flag that makes later binds
	* throw; a settings toggle needs the listeners gone without burning the
	* instance, because re-enabling the plugin must be able to start rules again.
	*/
	stopAll() {
		let stopped = 0;
		for (const id of [...this.forwards.keys()]) if (this.stop(id)) stopped += 1;
		for (const id of [...this.starting.keys()]) {
			if (this.forwards.has(id)) continue;
			this.stoppedWhileBinding.add(id);
			stopped += 1;
		}
		return stopped;
	}
	/** Every rule, optionally narrowed to one host alias. */
	list(alias) {
		return [...this.forwards.values()].filter((forward) => alias === void 0 || forward.alias === alias).sort((left, right) => left.alias.localeCompare(right.alias) || left.localPort - right.localPort).map((forward) => this.stateOf(forward));
	}
	/** Close every listener and every proxied connection (plugin unload). */
	dispose() {
		this.disposed = true;
		this.stopAll();
	}
	/** Bind the loopback listener. Split out so the error path is one place. */
	async bindForward(id, request, requestedLocalPort) {
		const server = createServer();
		const forward = {
			id,
			alias: request.alias,
			remoteHost: request.remoteHost,
			remotePort: request.remotePort,
			localPort: 0,
			server,
			sockets: /* @__PURE__ */ new Set(),
			channels: /* @__PURE__ */ new Set(),
			bytesIn: 0,
			bytesOut: 0,
			lastError: void 0,
			startedAt: Date.now()
		};
		server.on("connection", (socket) => {
			this.accept(forward, socket);
		});
		await new Promise((resolve, reject) => {
			const onError = (error) => {
				server.removeListener("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				server.removeListener("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(requestedLocalPort, LOOPBACK);
		});
		forward.localPort = server.address().port;
		server.on("error", (error) => {
			forward.lastError = messageOf$2(error);
			this.log("warn", `forward ${id} listener error: ${forward.lastError}`);
		});
		return forward;
	}
	/** One accepted local TCP connection: bound, or refused when the rule is full. */
	accept(forward, socket) {
		const maxConnections = this.deps.maxConnections ?? 32;
		if (forward.sockets.size >= maxConnections) {
			forward.lastError = `too many simultaneous connections (limit ${maxConnections}); close one and retry`;
			this.log("warn", `forward ${forward.id}: ${forward.lastError}`);
			socket.destroy();
			return;
		}
		forward.sockets.add(socket);
		/**
		* A reset in the DIAL WINDOW must never crash the Host.
		*
		* `finish` — the handler that owns the socket/channel pair and absorbs both
		* errors — is attached only AFTER a channel exists. A cold dial takes
		* seconds (up to the 15 s channel-open deadline), and a client that resets
		* in that window emits `error` on a socket with no listener: Node turns
		* that into an `uncaughtException`, and the DSH Host exits on those. This
		* accept-time handler ends the local half; the later `finish` closes the
		* channel if the dial wins the race.
		*/
		const dropSocket = () => {
			forward.sockets.delete(socket);
			socket.destroy();
		};
		socket.once("close", dropSocket);
		socket.once("error", dropSocket);
		this.connect(forward, socket);
	}
	/**
	* Open one direct-tcpip channel for a local socket and pipe both ways.
	*
	* The channel is opened through the pool, so a dropped SSH connection is
	* re-dialed per new local connection; an in-flight one fails with the pool's
	* reason and is recorded on the rule.
	*/
	async connect(forward, socket) {
		let channel;
		try {
			channel = await this.deps.pool.forwardOut(forward.alias, forward.remoteHost, forward.remotePort);
		} catch (error) {
			forward.lastError = messageOf$2(error);
			this.log("warn", `forward ${forward.id} -> ${forward.remoteHost}:${forward.remotePort} failed: ${forward.lastError}`);
			forward.sockets.delete(socket);
			socket.destroy();
			return;
		}
		if (socket.destroyed) {
			try {
				channel.close();
			} catch {}
			return;
		}
		forward.channels.add(channel);
		forward.lastError = void 0;
		socket.on("data", (chunk) => {
			forward.bytesIn += chunk.length;
		});
		channel.on("data", (chunk) => {
			forward.bytesOut += chunk.length;
		});
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			forward.sockets.delete(socket);
			forward.channels.delete(channel);
			socket.destroy();
			try {
				channel.close();
			} catch {}
		};
		socket.once("close", finish);
		socket.once("error", finish);
		channel.once("close", finish);
		channel.once("error", finish);
		socket.pipe(channel);
		channel.pipe(socket);
	}
	/** Tear one rule down: listener, then every proxied connection. */
	closeForward(forward) {
		try {
			forward.server.close();
		} catch {}
		for (const socket of [...forward.sockets]) try {
			socket.destroy();
		} catch {}
		forward.sockets.clear();
		for (const channel of [...forward.channels]) try {
			channel.close();
		} catch {}
		forward.channels.clear();
	}
	stateOf(forward) {
		return {
			id: forward.id,
			alias: forward.alias,
			remoteHost: forward.remoteHost,
			remotePort: forward.remotePort,
			localPort: forward.localPort,
			localUrl: forwardLocalUrl(forward.localPort),
			state: forward.lastError === void 0 ? "listening" : "error",
			connections: forward.sockets.size,
			bytesIn: forward.bytesIn,
			bytesOut: forward.bytesOut,
			...forward.lastError === void 0 ? {} : { lastError: forward.lastError },
			startedAt: forward.startedAt
		};
	}
	log(level, message) {
		try {
			this.deps.log?.(level, message);
		} catch {}
	}
};
//#endregion
//#region src/http.ts
const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"referrer-policy": "no-referrer"
};
/**
* Extra bytes a too-large body may stream past its cap before the socket is
* dropped. Draining the rest keeps the caller's error response readable; the
* hard stop below refuses to read an unbounded body from a stuck/hostile client.
*/
const DRAIN_LIMIT_BYTES = 8 * 1024 * 1024;
/**
* Bounded body reader with a truthful outcome.
*
* Oversize no longer destroys the request immediately: returning early from the
* `for await` loop would tear the socket down, and the caller's 400/413 then
* reaches the client as a connection reset (the reported A11 symptom). The body
* is drained instead, up to `DRAIN_LIMIT_BYTES`, so the route can answer with a
* readable JSON error; an absurd stream is still cut off with `destroy()`.
*/
async function readJsonBodyResult(req, opts = {}) {
	const maxBytes = opts.maxBytes ?? 64 * 1024;
	const chunks = [];
	let size = 0;
	let tooLarge = false;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (!tooLarge && size > maxBytes) {
			tooLarge = true;
			chunks.length = 0;
		}
		if (tooLarge) {
			if (size > maxBytes + DRAIN_LIMIT_BYTES) {
				req.destroy();
				return {
					kind: "too-large",
					maxBytes
				};
			}
			continue;
		}
		chunks.push(buffer);
	}
	if (tooLarge) return {
		kind: "too-large",
		maxBytes
	};
	const text = Buffer.concat(chunks).toString("utf8");
	if (text === "") return { kind: "empty" };
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { kind: "invalid" };
	}
	if (opts.objectOnly === true && !isJsonObject(parsed)) return { kind: "invalid" };
	return {
		kind: "ok",
		value: parsed
	};
}
function isJsonObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* The host alias one response is about (consumed by {@link writeJson}).
*
* A response may only carry news about the host it concerns, otherwise one
* window shows another window's silent helper push and the queue loses it for
* the window that caused it. `null` is the explicit "about no single host"
* answer (a hosts/workspaces listing): it leaves the queue alone. An untouched
* response keeps the historical drain-all answer — only this plugin's route
* table marks its responses, and every route states what it is about.
*/
const noticeAliasOf = /* @__PURE__ */ new WeakMap();
/** Declare which host the response being written concerns (`null` = no host). */
function scopeHostNotices(res, alias) {
	noticeAliasOf.set(res, alias === "" ? null : alias);
}
/** The notices this response may carry and consume. */
function noticesFor(res, attachable, status) {
	if (!attachable || status >= 400) return [];
	if (!noticeAliasOf.has(res)) return drainHostNotices();
	const alias = noticeAliasOf.get(res);
	return typeof alias === "string" && alias !== "" ? takeHostNotices(alias) : [];
}
/** Write one JSON response. */
function writeJson(res, status, body, headers = {}) {
	const notices = noticesFor(res, typeof body === "object" && body !== null && !Array.isArray(body), status);
	const payload = notices.length > 0 ? {
		...body,
		notices
	} : body;
	res.writeHead(status, {
		...JSON_HEADERS,
		...headers
	});
	res.end(JSON.stringify(payload));
}
/**
* Write one failed-operation response, tagging a budget that merely ran out.
*
* `code: 'deadline'` is what lets the browser tell "this one request was too
* slow" from "the link is down": the client keeps the status chip green and the
* editor editable, while the operation still fails with a readable reason. Only
* the error object carries that distinction — the message is prose, and matching
* on prose stops working the moment the sentence changes.
*/
function writeRouteError(res, error) {
	writeJson(res, 502, {
		error: error instanceof Error ? error.message : String(error),
		...error instanceof DeadlineError ? { code: "deadline" } : {}
	});
}
//#endregion
//#region src/loopback.ts
function isIPv4Loopback(v4) {
	const parts = v4.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function isLoopbackAddress(address) {
	if (address === void 0) return false;
	const normalized = address.toLowerCase();
	if (normalized === "::1") return true;
	if (normalized.startsWith("::ffff:")) return isIPv4Loopback(normalized.slice(7));
	return isIPv4Loopback(normalized);
}
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	return isIPv4Loopback(hostname);
}
function isLoopbackRequest(request) {
	if (!isLoopbackAddress(request.socket.remoteAddress)) return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL("http://" + host);
	} catch {
		return false;
	}
	if (!isLoopbackHostname(hostUrl.hostname)) return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
//#endregion
//#region src/git-format.ts
/** Wrap a value for POSIX sh single-quote context. */
function shQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
//#endregion
//#region src/archive.ts
/**
* Remote directory archiving for the download route.
*
* The archive is produced ON the remote host (`tar -czf -`) and streamed
* straight into the HTTP response, so the Host never builds it in memory or
* writes it to its own disk. Pure string builders (no fs, no exec) so the
* download gate can pin the exact command shape.
*/
/**
* Best-effort normal form of one remote path, shared by the guard, the command
* and the download NAME.
*
* The name used to take its basename from the RAW string while the command
* normalized: `/a/b/..` archived `/a` but was saved as `...tar.gz`. One
* normalization for both is the only way the file name can be trusted to name
* what is inside.
*/
function normalizeArchivePath(raw) {
	return posix.normalize(String(raw).replace(/\\/g, "/")).replace(/\/+$/, "");
}
/** Download file name for one archived directory (normalized like the command). */
function directoryArchiveName(dir) {
	const trimmed = normalizeArchivePath(dir);
	const at = trimmed.lastIndexOf("/");
	const base = at < 0 ? trimmed : trimmed.slice(at + 1);
	return `${base === "" ? "root" : base}.tar.gz`;
}
/**
* Normalize one remote path into the exact string the tar command will use.
*
* The normalization has to live HERE, not only in the caller: `files.stat()`
* normalizes internally (`remotePath()`), so a raw `/..` passed the "is it a
* directory" check and still reached the builder un-normalized — `-C '/' './..'`
* then archived the whole remote root, which is exactly what the guard is
* supposed to refuse. Guard and command therefore have to be derived from the
* SAME value; a character-class check on the raw string cannot do it.
*
* `/a/b/..` → `/a`: climbing down to a real directory is a legitimate target,
* only the root itself (and anything relative) is refused.
*/
function archivePath(raw) {
	const path = normalizeArchivePath(raw);
	if (path === "" || path === "/") throw new Error("refusing to archive the remote root");
	if (!path.startsWith("/")) throw new Error("remote path must be absolute");
	if (path.split("/").includes("..")) throw new Error("path must not contain ..");
	return path;
}
/**
* One POSIX shell command that writes the directory's gzip tar to stdout.
*
* The member name is prefixed with `./` so a directory whose name starts with
* `-` cannot be read as a tar option; `-C` names the parent instead of relying
* on a shell `cd`, and both paths are single-quoted (`shQuote`) so spaces,
* quotes and `$()` in a real path cannot escape into the command.
*/
function directoryArchiveCommand(dir) {
	const path = archivePath(dir);
	const parent = posix.dirname(path);
	const name = posix.basename(path);
	return `tar -czf - -C ${shQuote(parent)} ${shQuote(`./${name}`)}`;
}
/**
* One POSIX shell command archiving several selected paths to stdout.
*
* GNU tar accepts one `-C` before each member, so every entry is stored as its
* own bare `./name` while keeping its real parent on the remote side; that is
* what lets a selection span several directories (mixed files and directories
* are fine — tar recurses into directories). Two entries with the same basename
* from different directories collide inside the archive by design: the
* alternative would be a synthetic directory tree the remote never had.
*/
function selectionArchiveCommand(paths) {
	if (paths.length === 0) throw new Error("refusing to archive an empty selection");
	if (paths.length > 100) throw new Error(`too many entries: ${paths.length} (max 100)`);
	let command = "tar -czf -";
	for (const raw of paths) {
		const path = archivePath(raw);
		command += ` -C ${shQuote(posix.dirname(path))} ${shQuote(`./${posix.basename(path)}`)}`;
	}
	return command;
}
//#endregion
//#region src/keygen.ts
/**
* Password -> key bootstrap (Q2 decision): a password host gets a dedicated
* ed25519 keypair generated locally (ssh-keygen), the public half is appended
* to the remote ~/.ssh/authorized_keys over the password connection, and the
* store entry flips to key auth with the managed keyPath.
*/
const execFileAsync = promisify(execFile);
/**
* `type base64` — the only two fields of a `.pub` file that are key material.
*
* ssh-keygen appends a free-text comment, and that comment is NOT part of the
* key. The old code only checked the line's prefix and then spliced the WHOLE
* line into a single-quoted remote shell command; a garbled or tampered `.pub`
* therefore reached `sh -c` as code. The strict grammar below admits nothing
* but the two safe fields, and the comment is regenerated from the alias.
*/
const PUBLIC_KEY_FIELDS_RE = /^(ssh-ed25519) ([A-Za-z0-9+/]+={0,2})$/;
/** Ed25519 wire blob: 4-byte length + "ssh-ed25519", 4-byte length + 32 bytes. */
function isEd25519Blob(blob) {
	const decoded = Buffer.from(blob, "base64");
	if (decoded.length !== 51) return false;
	if (decoded.readUInt32BE(0) !== 11) return false;
	if (decoded.subarray(4, 15).toString("latin1") !== "ssh-ed25519") return false;
	return decoded.readUInt32BE(15) === 32;
}
/**
* Normalize one `.pub` line to `ssh-ed25519 <base64> dsh-remote-vs/<alias>`.
*
* Throws when the line is not a well-formed ed25519 public key, so the caller
* sees a clear "this file is not a key" error instead of a remote login that
* fails later. The returned text is the only form that may enter the shell
* command: its comment is ours, and both remaining fields are shell-inert.
*/
function formatPublicKey(raw, alias) {
	const fields = raw.trim().split(/\s+/);
	const type = fields[0];
	const blob = fields[1];
	if (fields.length < 2 || type === void 0 || blob === void 0 || !PUBLIC_KEY_FIELDS_RE.test(`${type} ${blob}`)) throw new Error("expected an \"ssh-ed25519 <base64>\" public key line");
	if (!isEd25519Blob(blob)) throw new Error("the base64 blob is not a valid ed25519 public key");
	return `${type} ${blob} dsh-remote-vs/${alias.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}
/** Ensure the managed keypair exists; return the private key path. */
async function ensureKeypair(alias, dir = keysDir()) {
	ensurePrivateDir(dir);
	const privatePath = join(dir, alias);
	const publicPath = `${privatePath}.pub`;
	if (!existsSync(privatePath) || !existsSync(publicPath)) {
		try {
			await execFileAsync("ssh-keygen", [
				"-t",
				"ed25519",
				"-f",
				privatePath,
				"-N",
				"",
				"-C",
				`dsh-remote-vs/${alias}`
			]);
		} catch (error) {
			throw new Error(`ssh-keygen failed (required for key bootstrap): ${error instanceof Error ? error.message : String(error)}`);
		}
		try {
			chmodSync(privatePath, 384);
		} catch {}
	}
	let publicKey;
	try {
		publicKey = formatPublicKey(readFileSync(publicPath, "utf8"), alias);
	} catch (error) {
		throw new Error(`unexpected public key format in ${publicPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return {
		privatePath,
		publicKey
	};
}
/**
* Bootstrap one host: install the managed public key remotely, then flip the
* entry to key auth and drop the pooled password connection.
*/
async function bootstrap(pool, store, alias) {
	const entry = store.require(alias);
	if (entry.auth.kind !== "password") return {
		alias,
		keyPath: entry.auth.keyPath ?? "",
		flipped: false,
		detail: "host already uses key auth"
	};
	const { privatePath, publicKey } = await ensureKeypair(alias);
	const script = [
		"mkdir -p ~/.ssh && chmod 700 ~/.ssh",
		`touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
		`grep -qF '${publicKey.split(" ").slice(0, 2).join(" ")}' ~/.ssh/authorized_keys 2>/dev/null || echo '${publicKey}' >> ~/.ssh/authorized_keys`
	].join(" && ");
	const result = await pool.exec(alias, script, { timeoutMs: 3e4 });
	if (!result.success) throw new Error(`key install failed [exit code: ${result.exitCode}]: ${result.stderr || result.stdout || result.error || "unknown"}`);
	store.update(alias, { auth: {
		kind: "key",
		keyPath: privatePath
	} });
	pool.drop(alias);
	const check = await pool.test(alias);
	if (!check.ok) throw new Error(`key installed but key login failed: ${check.error} (password entry was already flipped; fix the key or re-enter the password)`);
	return {
		alias,
		keyPath: privatePath,
		flipped: true,
		detail: "public key installed; entry now uses key auth"
	};
}
//#endregion
//#region src/importers.ts
/**
* One-shot importers: ~/.ssh/config and the existing dsh-ssh.json. Both only
* READ the source and produce payloads for our own store — no runtime coupling.
* P0 supports direct key/password hosts only; jump/proxy/agent entries are
* reported as skipped with reasons.
*/
/** Expand a leading ~ to the user home. */
function expandHome(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}
/**
* Parse one configured port (number, or a decimal string from older stores).
*
* `undefined` means absent (caller defaults to 22); `NaN`/out-of-range returns
* `undefined` too, and callers turn that into an explicit skip — silently
* importing an invalid port as 22 would connect to the wrong sshd (or none).
*/
function validPort(value) {
	const port = typeof value === "number" ? value : /^\d+$/.test(value) ? Number(value) : NaN;
	if (!Number.isInteger(port) || port < 1 || port > 65535) return void 0;
	return port;
}
/** Parse OpenSSH client config text into host payloads. */
function parseSshConfig(text) {
	const payloads = [];
	const skipped = [];
	const blocks = [];
	let current;
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		const match = /^(\S+)\s+(.*)$/.exec(line);
		if (match === null) continue;
		const key = match[1].toLowerCase();
		let value = match[2].trim().replace(/^"(.*)"$/, "$1");
		const hash = value.indexOf(" #");
		if (hash >= 0) value = value.slice(0, hash).trim();
		if (key === "host") {
			current = {
				patterns: value.split(/\s+/),
				fields: /* @__PURE__ */ new Map()
			};
			blocks.push(current);
		} else if (key === "match") {
			current = void 0;
			skipped.push({
				alias: "(match)",
				reason: "Match conditional blocks are not imported"
			});
		} else if (key === "include") skipped.push({
			alias: "(include)",
			reason: `Include ${value} is not expanded — import that file separately`
		});
		else if (current !== void 0 && !current.fields.has(key)) current.fields.set(key, value);
	}
	for (const block of blocks) {
		const concrete = block.patterns.filter((pattern) => pattern !== "" && !/[*?!]/.test(pattern));
		const special = block.patterns.filter((pattern) => pattern !== "" && /[*?!]/.test(pattern));
		if (special.length > 0) skipped.push({
			alias: special.join(" "),
			reason: "wildcard/negation patterns are not imported"
		});
		if (concrete.length === 0) {
			if (special.length === 0) skipped.push({
				alias: "(empty)",
				reason: "Host line has no pattern"
			});
			continue;
		}
		if (block.fields.has("proxyjump") || block.fields.has("proxycommand")) {
			for (const alias of concrete) skipped.push({
				alias,
				reason: "proxyJump/proxyCommand needs P1 (direct hosts only in P0)"
			});
			continue;
		}
		const rawPort = block.fields.get("port");
		const port = rawPort === void 0 ? 22 : validPort(rawPort);
		const identityFile = block.fields.get("identityfile")?.split(/\s+/)[0];
		const user = block.fields.get("user") ?? "";
		for (const alias of concrete) {
			if (port === void 0) {
				skipped.push({
					alias,
					reason: `invalid Port '${rawPort ?? ""}' (expected 1-65535)`
				});
				continue;
			}
			if (user === "") {
				skipped.push({
					alias,
					reason: "no User in ssh_config — set the login user after import"
				});
				continue;
			}
			if (identityFile === void 0) {
				skipped.push({
					alias,
					reason: "no IdentityFile in ssh_config — add the key or password after import"
				});
				continue;
			}
			payloads.push({
				alias,
				host: block.fields.get("hostname") ?? alias,
				port,
				user,
				auth: {
					kind: "key",
					keyPath: expandHome(identityFile)
				},
				tags: ["imported:ssh-config"]
			});
		}
	}
	return {
		payloads,
		skipped
	};
}
/** Read the default ~/.ssh/config (throws when missing). */
function readDefaultSshConfig() {
	const file = join(homedir(), ".ssh", "config");
	if (!existsSync(file)) throw new Error(`no such file: ${file}`);
	return readFileSync(file, "utf8");
}
/** Migrate entries from the third-party dsh-ssh.json (one-shot copy). */
function migrateDshSsh(home = dshHome()) {
	const file = join(home, "dsh-ssh.json");
	if (!existsSync(file)) throw new Error(`no such file: ${file} (nothing to import)`);
	const doc = JSON.parse(readFileSync(file, "utf8"));
	if (!Array.isArray(doc.hosts)) throw new Error(`${file}: hosts is not an array`);
	const payloads = [];
	const skipped = [];
	for (const raw of doc.hosts) {
		const alias = typeof raw.alias === "string" ? raw.alias : "(unknown)";
		const auth = raw.auth ?? {};
		const kind = auth.kind;
		const proxyJump = raw.proxyJump;
		const proxyCommand = raw.proxyCommand;
		const hasProxy = Array.isArray(proxyJump) && proxyJump.length > 0 || typeof proxyJump === "string" && proxyJump !== "" || typeof proxyCommand === "string" && proxyCommand !== "";
		if (kind !== "key" && kind !== "password") {
			skipped.push({
				alias,
				reason: `auth kind '${String(kind)}' needs P1 (key/password only in P0)`
			});
			continue;
		}
		if (hasProxy) {
			skipped.push({
				alias,
				reason: "proxyJump/proxyCommand needs P1 (direct hosts only in P0)"
			});
			continue;
		}
		if (kind === "key" && (typeof auth.keyPath !== "string" || auth.keyPath.trim() === "")) {
			skipped.push({
				alias,
				reason: "key auth without keyPath"
			});
			continue;
		}
		if (kind === "password" && (typeof auth.password !== "string" || auth.password === "")) {
			skipped.push({
				alias,
				reason: "password auth without stored password (enter it manually)"
			});
			continue;
		}
		const host = typeof raw.host === "string" ? raw.host : "";
		const user = typeof raw.user === "string" ? raw.user : "";
		const rawPort = raw.port;
		const port = rawPort === void 0 ? 22 : validPort(rawPort);
		if (host === "") {
			skipped.push({
				alias,
				reason: "no host address — enter it manually after import"
			});
			continue;
		}
		if (user === "") {
			skipped.push({
				alias,
				reason: "no login user — enter it manually after import"
			});
			continue;
		}
		if (port === void 0) {
			skipped.push({
				alias,
				reason: `invalid port '${String(rawPort)}' (expected 1-65535)`
			});
			continue;
		}
		payloads.push({
			alias,
			host,
			port,
			user,
			auth: kind === "key" ? {
				kind: "key",
				keyPath: auth.keyPath,
				...typeof auth.passphrase === "string" ? { passphrase: auth.passphrase } : {}
			} : {
				kind: "password",
				password: auth.password
			},
			...typeof raw.description === "string" && raw.description !== "" ? { description: raw.description } : {},
			tags: ["imported:dsh-ssh"]
		});
	}
	return {
		payloads,
		skipped
	};
}
//#endregion
//#region src/terminal.ts
/**
* Remote PTY terminal sessions: one ssh2 shell per session, surviving socket
* detaches (reattach by id). Frames are JSON text (see protocol.ts).
*/
/**
* A session with no attached socket is kept this long so that a page reload
* can reattach by id. Past it the session closes and the remote shell dies.
*
* Without this sweep nothing ever released the session: its `pool.hold` never
* returned to zero, so the connection could not idle out, and the remote sshd
* session slot stayed taken for the life of the host process. Ten minutes is
* far longer than a reload needs and far shorter than "until you restart DSH".
*/
const EMPTY_SOCKET_TTL_MS = 10 * 6e4;
/**
* Terminal output is a live stream with no natural end, so it needs a bound.
* When a socket falls this far behind, pause the channel — that pushes the
* brake all the way back to the remote command, instead of growing the host
* process. Resume once the socket has drained.
*
* The pause is real backpressure, not a local buffer: ssh2 only sends a window
* adjustment while the stream is flowing, so a paused channel lets the peer's
* send window drain to zero and the remote command blocks on its own write.
* The retained ceiling is therefore this mark plus ssh2's window (2 MiB) plus
* whatever is in flight — bounded, but not exactly 4 MiB.
*
* The mark is RESPONSIVENESS, not just memory: everything already handed to a
* socket has to be parsed and painted by the browser before a later keystroke's
* echo can appear, so a large mark means "type during a huge dump and wait
* seconds". 2 MiB still absorbs a burst comfortably (a keystroke is bytes) while
* keeping the worst-case echo delay down; ssh2's own 2 MiB window is the part we
* cannot shrink from here.
*
* The counter is per session, not per socket: one lagging socket pauses the
* channel for every socket attached to that shell. That is deliberate — the
* alternative is letting the slowest consumer grow the host process.
*/
const OUT_HIGH_WATER = 2 * 1024 * 1024;
const OUT_LOW_WATER = 512 * 1024;
/** Default window for coalescing output frames (0 = one frame per chunk). */
const OUT_COALESCE_MS = 8;
/**
* Flush immediately past this much buffered text (measured in UTF-16 code
* units, i.e. `String.length`): a producer faster than the window must not turn
* into an unbounded string copy (the channel backpressure bounds the bytes
* handed to the SOCKETS, not this buffer).
*
* Code units rather than bytes on purpose: converting to a byte count would
* copy the whole buffer on every chunk just to compare a threshold. CJK/emoji
* output therefore flushes at up to ~3x this many bytes, which is still far
* below the 1 MiB client-frame cap this path never approaches (it is the
* client→host direction).
*/
const OUT_COALESCE_CHARS = 64 * 1024;
/**
* How long the output must have been quiet for the NEXT chunk to be sent at once.
*
* A terminal echoes what the user types. Holding that echo for the coalescing
* window is invisible at 8 ms — but under load the window itself is a timer in
* an event loop shared with the agent, and the delay adds up. After a quiet
* period the chunk is therefore flushed synchronously; only a running stream
* (where `lastFlushAt` is fresh) is batched.
*/
const OUT_ECHO_IDLE_MS = 24;
/**
* How much recent output a reattaching socket receives (see `Session.replay`).
*
* 128 Ki UTF-16 units is a few screens of logs plus the prompt line; the buffer
* may grow to twice this between trims, so one terminal costs at most ~512 KiB
* of the host's memory in replay state.
*/
const REPLAY_MAX_CHARS = 128 * 1024;
/**
* The largest client frame accepted, in bytes.
*
* The only frame with a payload is `in` — keystrokes, and pastes, which the
* client chunks to stay under this. The upgrade server (`routes.ts`) passes
* this value as ws's `maxPayload`, so an oversized frame is refused before it
* is buffered at all; the check in `hookSocket` is the second layer, and it is
* what keeps such a frame from becoming a string plus an object graph in the
* process that also runs the agent.
*/
const TERMINAL_MAX_FRAME_BYTES = 1024 * 1024;
/**
* `WebSocket.OPEN` (RFC 6455 readyState 1).
*
* Used to detect a socket that closed while a shell was still being opened: the
* library never replays a `close` event to a listener attached afterwards.
*/
const WS_OPEN = 1;
var TerminalSessionRegistry = class {
	pool;
	options;
	sessions = /* @__PURE__ */ new Map();
	constructor(pool, options = {}) {
		this.pool = pool;
		this.options = options;
	}
	/** The window this registry coalesces within (`0` = every chunk is a frame). */
	get coalesceMs() {
		return this.options.coalesceMs ?? OUT_COALESCE_MS;
	}
	/** Open a shell and attach the first socket. */
	async open(ws, alias, cols, rows) {
		const id = randomUUID().slice(0, 8);
		let channel;
		try {
			channel = await this.pool.shell(alias, {
				cols,
				rows
			});
		} catch (error) {
			this.send(ws, {
				t: "error",
				message: error instanceof Error ? error.message : String(error)
			});
			try {
				ws.close(1011);
			} catch {}
			throw error;
		}
		const session = {
			id,
			alias,
			channel,
			alive: true,
			exitCode: null,
			sockets: /* @__PURE__ */ new Set(),
			pending: 0,
			paused: false,
			outBuffer: "",
			outTimer: void 0,
			replay: "",
			lastFlushAt: 0,
			outstanding: /* @__PURE__ */ new Map(),
			reap: void 0,
			outDecoder: new StringDecoder("utf8"),
			errDecoder: new StringDecoder("utf8")
		};
		this.sessions.set(id, session);
		channel.on("data", (chunk) => {
			const text = session.outDecoder.write(chunk);
			if (text !== "") this.queueOut(session, text);
		});
		channel.stderr.on("data", (chunk) => {
			const text = session.errDecoder.write(chunk);
			if (text !== "") this.queueOut(session, text);
		});
		channel.on("close", (code) => {
			session.alive = false;
			session.exitCode = code;
			for (const tail of [session.outDecoder.end(), session.errDecoder.end()]) if (tail !== "") this.queueOut(session, tail);
			this.flushOut(session);
			this.broadcast(session, {
				t: "exit",
				code
			});
			for (const socket of session.sockets) try {
				socket.close(1e3);
			} catch {}
		});
		this.hookSocket(session, ws);
		this.send(ws, {
			t: "ready",
			id
		});
		return id;
	}
	/**
	* Attach another socket to a live session; false when unknown/dead.
	*
	* The size in the URL is deliberately NOT applied here. It is the same
	* fixed 80x24 the view uses to open a shell, and re-applying it on every
	* reattach — which is what a page reload does — SHRANK a running shell:
	* SIGWINCH, and a full-screen program re-laying itself out at 80 columns,
	* until that tab became visible and refit. The session already has a size.
	* The socket sends a real `resize` frame as soon as it can measure itself
	* (`XTerm.pushSize`), which is the only place that knows how wide it is.
	*
	* The parameters stay because the upgrade handler owns the URL and passes
	* them on both paths; they matter to `open` (the PTY's initial size) only.
	*/
	attach(ws, id, _cols, _rows) {
		const session = this.sessions.get(id);
		if (session === void 0 || !session.alive) return false;
		this.hookSocket(session, ws);
		if (session.replay !== "") this.sendOutTo(session, ws, JSON.stringify({
			t: "out",
			d: session.replay
		}));
		this.flushOut(session);
		this.send(ws, {
			t: "ready",
			id
		});
		return true;
	}
	/** Close one session (kills the remote shell). */
	close(id) {
		const session = this.sessions.get(id);
		if (session === void 0) return false;
		this.sessions.delete(id);
		this.cancelReap(session);
		this.flushOut(session);
		try {
			session.channel.close();
		} catch {}
		for (const socket of session.sockets) try {
			socket.close(1e3);
		} catch {}
		session.sockets.clear();
		session.outstanding.clear();
		session.pending = 0;
		return true;
	}
	/** Close every session (plugin unload). */
	dispose() {
		for (const id of [...this.sessions.keys()]) this.close(id);
	}
	list() {
		return [...this.sessions.values()].map((s) => ({
			id: s.id,
			alias: s.alias,
			alive: s.alive
		}));
	}
	hookSocket(session, ws) {
		this.cancelReap(session);
		session.sockets.add(ws);
		ws.on("message", (raw) => {
			if ((Array.isArray(raw) ? raw.reduce((total, part) => total + part.byteLength, 0) : raw.byteLength) > 1048576) {
				try {
					ws.close(1009);
				} catch {}
				return;
			}
			let frame;
			try {
				frame = JSON.parse(String(raw));
			} catch {
				return;
			}
			if (!session.alive) return;
			if (frame.t === "in" && typeof frame.d === "string") try {
				session.channel.write(frame.d);
			} catch {}
			else if (frame.t === "resize" && Number.isFinite(frame.cols) && Number.isFinite(frame.rows)) try {
				session.channel.setWindow(frame.rows, frame.cols, 0, 0);
			} catch {}
		});
		const detach = () => {
			this.flushOut(session);
			const unsettled = session.outstanding.get(ws);
			if (unsettled !== void 0) {
				session.outstanding.delete(ws);
				session.pending = Math.max(0, session.pending - unsettled);
				if (session.pending <= OUT_LOW_WATER) this.setPaused(session, false);
			}
			session.sockets.delete(ws);
			if (session.sockets.size > 0) return;
			session.pending = 0;
			session.outstanding.clear();
			this.setPaused(session, false);
			this.armReap(session);
		};
		ws.on("close", detach);
		ws.on("error", detach);
		/**
		* The socket may have closed while `pool.shell()` was still dialing: a cold
		* connection takes seconds, and a page reload (or a closed tab) during it
		* happens well before those listeners exist. EventEmitter does not replay
		* events, so without this the socket would sit in `sockets` forever, no
		* detach would ever run, no reap would ever arm — and the session, its PTY
		* and the pooled connection's hold would leak for the life of the process.
		* `readyState` is the only way to observe "already gone" from here.
		*/
		if (ws.readyState !== WS_OPEN) detach();
	}
	/** Keep the shell for a while (reload can reattach), then close it for good. */
	armReap(session) {
		this.cancelReap(session);
		const timer = setTimeout(() => {
			session.reap = void 0;
			if (this.sessions.get(session.id) !== session) return;
			if (session.sockets.size === 0) this.close(session.id);
		}, EMPTY_SOCKET_TTL_MS);
		timer.unref?.();
		session.reap = timer;
	}
	cancelReap(session) {
		if (session.reap === void 0) return;
		clearTimeout(session.reap);
		session.reap = void 0;
	}
	/**
	* Queue one output chunk and schedule the coalesced frame.
	*
	* `coalesceMs === 0` broadcasts immediately (the checks rely on that
	* synchrony). A chunk that arrives after an idle gap is also sent at once —
	* that is the interactive echo path (a keystroke must not wait for the
	* window) — while a stream that keeps producing coalesces.
	*/
	queueOut(session, text) {
		if (text === "") return;
		const idle = Date.now() - session.lastFlushAt >= OUT_ECHO_IDLE_MS;
		session.outBuffer += text;
		if (session.outBuffer.length >= OUT_COALESCE_CHARS || this.coalesceMs <= 0 || idle) {
			this.flushOut(session);
			return;
		}
		if (session.outTimer !== void 0) return;
		const timer = setTimeout(() => {
			session.outTimer = void 0;
			this.flushOut(session);
		}, this.coalesceMs);
		timer.unref?.();
		session.outTimer = timer;
	}
	/** Send the buffered output as ONE `out` frame (no-op when empty). */
	flushOut(session) {
		if (session.outTimer !== void 0) {
			clearTimeout(session.outTimer);
			session.outTimer = void 0;
		}
		if (session.outBuffer === "") return;
		const text = session.outBuffer;
		session.outBuffer = "";
		session.replay += text;
		if (session.replay.length > REPLAY_MAX_CHARS * 2) session.replay = session.replay.slice(-131072);
		session.lastFlushAt = Date.now();
		this.broadcast(session, {
			t: "out",
			d: text
		});
	}
	setPaused(session, paused) {
		if (session.paused === paused) return;
		session.paused = paused;
		try {
			if (paused) session.channel.pause();
			else session.channel.resume();
		} catch {}
	}
	send(ws, frame) {
		try {
			ws.send(JSON.stringify(frame));
		} catch {}
	}
	broadcast(session, frame) {
		const text = JSON.stringify(frame);
		for (const socket of session.sockets) this.sendOutTo(session, socket, text);
		if (session.pending > OUT_HIGH_WATER) this.setPaused(session, true);
	}
	/**
	* Send one already-stringified `out` frame to ONE socket with accounting.
	*
	* Shared by `broadcast` and by the replay on `attach`; the byte count must be
	* counted once per socket so the session's brake reflects every socket's
	* backlog (see `Session.pending`).
	*/
	sendOutTo(session, socket, text) {
		const size = Buffer.byteLength(text, "utf8");
		let settled = false;
		const done = () => {
			if (settled) return;
			settled = true;
			const left = session.outstanding.get(socket);
			if (left === void 0) return;
			const remaining = Math.max(0, left - size);
			if (remaining === 0) session.outstanding.delete(socket);
			else session.outstanding.set(socket, remaining);
			session.pending = Math.max(0, session.pending - size);
			if (session.pending <= OUT_LOW_WATER) this.setPaused(session, false);
		};
		session.pending += size;
		session.outstanding.set(socket, (session.outstanding.get(socket) ?? 0) + size);
		try {
			socket.send(text, done);
		} catch {
			done();
		}
	}
};
//#endregion
//#region src/listen-ports.ts
/** Prefix of every control line the probe prints (also the "did it answer" proof). */
const LISTEN_PORTS_MARK = "@@RVS-PORTS";
/**
* Budget for the whole probe. A handful of local commands over one channel; if
* `ss` hangs (a stuck kernel table), the route answers with the exec deadline
* instead of holding the panel's refresh forever.
*/
const LISTEN_PORTS_TIMEOUT_MS = 15e3;
/**
* The remote probe line.
*
* `if/elif/fi` rather than `a && b || c` chains: the shell's operator
* precedence would make a failing `ss` fall through into `netstat`'s branch in
* ways that depend on the last command's status, and one missing tool would be
* indistinguishable from a tool that ran and failed.
*
* `-p` is requested first and silently degrades to `-n`: it only ADDS process
* names, and it is allowed for a non-root user (the kernel just omits other
* users' sockets). `netstat -an` is the last resort for macOS, whose `-l` is
* not the Linux spelling; the parser understands both the colon and the dotted
* `addr.port` form.
*/
function listenPortsCommand() {
	return [
		"export LC_ALL=C",
		"if command -v ss >/dev/null 2>&1; then",
		`  echo "${LISTEN_PORTS_MARK} ss"`,
		"  ss -ltnp 2>/dev/null || ss -ltn 2>/dev/null",
		"elif command -v netstat >/dev/null 2>&1; then",
		`  echo "${LISTEN_PORTS_MARK} netstat"`,
		"  netstat -ltnp 2>/dev/null || netstat -ltn 2>/dev/null || netstat -an 2>/dev/null",
		"else",
		`  echo "${LISTEN_PORTS_MARK} none"`,
		"fi",
		`echo "${LISTEN_PORTS_MARK} end"`
	].join("\n");
}
function splitAddressPort(value) {
	let addr;
	let portText;
	const dotted = /^(.*)\.(\d+)$/.exec(value);
	if (dotted !== null) {
		addr = dotted[1];
		portText = dotted[2];
	} else if (value.includes(":")) {
		const at = value.lastIndexOf(":");
		addr = value.slice(0, at);
		portText = value.slice(at + 1);
		if (addr.startsWith("[") && addr.endsWith("]")) addr = addr.slice(1, -1);
	} else return;
	if (addr === "" || !/^[0-9]+$/.test(portText)) return void 0;
	const port = Number(portText);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return void 0;
	return {
		addr,
		port
	};
}
/** `[::]:22` → `[::]` for display; the bracket strip above already handles it. */
function normalizeAddr(addr) {
	if (addr === "" || addr === "*") return "*";
	return addr;
}
/** Process name out of `users:(("sshd",pid=1,fd=3))`, if the tool printed one. */
function processOf(text) {
	const match = /users:\(\("([^"]+)"/.exec(text);
	if (match !== null) return match[1];
	const short = /(?:^|\s)[0-9]+\/([^\s/]+)/.exec(text);
	return short === null ? void 0 : short[1];
}
/** One `ss -ltn[p]` row, or undefined for headers/foreign lines. */
function parseSsLine(line) {
	if (!line.startsWith("LISTEN ")) return void 0;
	const fields = line.split(/\s+/);
	const local = fields[3];
	if (local === void 0) return void 0;
	const split = splitAddressPort(local);
	if (split === void 0) return void 0;
	const process = fields.length > 5 ? processOf(fields.slice(5).join(" ")) : void 0;
	return {
		addr: normalizeAddr(split.addr),
		port: split.port,
		...process === void 0 ? {} : { process }
	};
}
/** One `netstat -ltn[p]` / `netstat -an` row, or undefined for headers. */
function parseNetstatLine(line) {
	if (!/^tcp[0-9]*\s/.test(line)) return void 0;
	const fields = line.split(/\s+/);
	const stateAt = fields.indexOf("LISTEN");
	if (stateAt < 0) return void 0;
	const local = fields[3];
	if (local === void 0) return void 0;
	const split = splitAddressPort(local);
	if (split === void 0) return void 0;
	const tail = fields.slice(stateAt + 1).join(" ");
	const process = tail === "" ? void 0 : processOf(tail);
	return {
		addr: normalizeAddr(split.addr),
		port: split.port,
		...process === void 0 ? {} : { process }
	};
}
/**
* Parse one probe's stdout into the panel's result.
*
* @param stdout - the probe's standard output (both tools plus markers).
* @param exitCode - the exec exit code; a non-zero run with no `end` marker is
*   reported as `unknown`, because an interrupted probe proves nothing about
*   the ports it never reached.
*/
function parseListenPorts(stdout, exitCode) {
	let tool = "unknown";
	let sawEnd = false;
	/** Lines that looked like a candidate row, for the "parsed nothing" verdict. */
	let sawCandidate = false;
	const seen = /* @__PURE__ */ new Map();
	for (const raw of stdout.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		if (line.startsWith("@@RVS-PORTS")) {
			const arg = line.slice(11).trim();
			if (arg === "end") sawEnd = true;
			else if (arg === "ss" || arg === "netstat" || arg === "none") tool = arg;
			continue;
		}
		const parsed = tool === "ss" ? parseSsLine(line) : tool === "netstat" ? parseNetstatLine(line) : void 0;
		if (parsed !== void 0) {
			const key = `${parsed.addr}|${parsed.port}`;
			if (!seen.has(key)) seen.set(key, parsed);
			sawCandidate = true;
			continue;
		}
		if (tool === "ss" && line.startsWith("LISTEN ")) sawCandidate = true;
		if (tool === "netstat" && /^tcp[0-9]*\s/.test(line) && line.includes("LISTEN")) sawCandidate = true;
	}
	if (tool === "none") return {
		tool,
		ports: [],
		error: "neither ss nor netstat is installed on the remote host"
	};
	if (tool === "unknown") return {
		tool,
		ports: [],
		error: "the remote probe did not answer (no marker line in its output)"
	};
	if (!sawEnd && exitCode !== null && exitCode !== 0) return {
		tool,
		ports: [],
		error: `the remote probe exited with code ${exitCode} before it finished`
	};
	if (exitCode === null) return {
		tool: "unknown",
		ports: [],
		error: "the remote probe ended without an exit status (the SSH channel closed)"
	};
	const ports = [...seen.values()].sort((left, right) => left.port - right.port || (left.addr < right.addr ? -1 : left.addr > right.addr ? 1 : 0));
	if (ports.length === 0 && sawCandidate) return {
		tool,
		ports: [],
		error: `${tool} printed listening sockets but the output could not be parsed`
	};
	if (ports.length > 500) return {
		tool,
		ports: ports.slice(0, 500),
		error: `only the first 500 listening sockets are listed`
	};
	return {
		tool,
		ports
	};
}
//#endregion
//#region src/metrics.ts
/**
* One bounded POSIX probe for the host monitor panel, and its pure parser.
*
* Why a shell one-liner instead of the helper or Python on the remote:
* - the plugin targets bare POSIX hosts (the doctor probe already works this
*   way); requiring `python3`/`psutil` would make the panel dead on a stock
*   router or NAS;
* - one `exec` over the pooled SSH channel needs no helper deploy and no
*   version handshake, so the panel also works on a host the deploy pipeline
*   never touched.
*
* Every fact is a marker line (`@@RVS-MET key detail`), so a banner printed by
* a login shell or a stray line of a command can never be mistaken for a
* measurement. A metric the host cannot answer is `null` (rendered as unknown),
* never zero: a VM without a thermal zone has no temperature, it does not have
* 0 °C.
*
* CPU% and the network rate are DELTAS over the previous sample: the caller
* keeps the counters (`cpuPercent` / `netRateBps` below). The first sample is
* honestly unknown instead of a made-up number.
*
* Linux is the supported source (`/proc`). A host that is not Linux simply
* answers `unknown`, which the UI renders as "unknown", not as an empty host.
*/
/** Prefix of every control line the probe prints (also the "did it answer" proof). */
const METRICS_MARK = "@@RVS-MET";
/**
* Budget for the whole probe.
*
* A handful of `/proc` reads over one channel: if the host itself is stuck (a
* hung mount, a thief of a process, a network blip) the route must answer with
* the exec deadline instead of holding the monitor's poll forever.
*/
const METRICS_TIMEOUT_MS = 8e3;
/**
* The remote probe line.
*
* `printf` never interpolates the input; every value comes from a fixed local
* command. `2>/dev/null` is only used where the missing tool/file is itself a
* normal answer (`/proc` on a non-Linux host); the parser then sees an empty
* value and reports it as unknown rather than as a zero.
*/
function metricsCommand() {
	const mark = METRICS_MARK;
	return [
		"export LC_ALL=C",
		`printf '%s begin\\n' '${mark}'`,
		`printf '%s kernel %s\\n' '${mark}' "$(uname -srm 2>/dev/null)"`,
		`printf '%s cores %s\\n' '${mark}' "$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null)"`,
		`printf '%s uptime %s\\n' '${mark}' "$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"`,
		`printf '%s load %s\\n' '${mark}' "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"`,
		`printf '%s cpu %s\\n' '${mark}' "$(awk '/^cpu /{print $2,$3,$4,$5,$6,$7,$8,$9; exit}' /proc/stat 2>/dev/null)"`,
		`printf '%s mem %s\\n' '${mark}' "$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} /^MemFree:/{f=$2} /^Buffers:/{b=$2} /^Cached:/{c=$2} END{if(t=="")exit; if(a=="")a=f+b+c; printf "%s %s", t, a}' /proc/meminfo 2>/dev/null)"`,
		`printf '%s disk %s\\n' '${mark}' "$(df -Pk / 2>/dev/null | awk 'NR==2{print $2, $3}')"`,
		`printf '%s net %s\\n' '${mark}' "$(awk 'NR>2{iface=$1; sub(/:$/,"",iface); if(iface=="lo")next; rx+=$2; tx+=$10} END{printf "%s %s", rx+0, tx+0}' /proc/net/dev 2>/dev/null)"`,
		`printf '%s temp %s\\n' '${mark}' "$(for f in /sys/class/thermal/thermal_zone*/temp; do if [ -r "$f" ]; then cat "$f"; break; fi; done 2>/dev/null)"`,
		`printf '%s model %s\\n' '${mark}' "$(awk -F: '/model name/{sub(/^[ \\t]+/,"",$2); print $2; exit}' /proc/cpuinfo 2>/dev/null)"`,
		`printf '%s ip %s\\n' '${mark}' "$(hostname -I 2>/dev/null | awk '{print $1}')"`,
		`printf '%s end\\n' '${mark}'`
	].join("\n");
}
/** Anchored marker: a metric line's content can never forge or split a marker. */
const LINE_RE = new RegExp(`^${METRICS_MARK} ([a-z]+)(?: (.*))?$`);
const EMPTY = {
	kernel: null,
	cpuCores: null,
	cpuModel: null,
	ip: null,
	uptimeSeconds: null,
	load: null,
	cpu: null,
	memTotalBytes: null,
	memUsedBytes: null,
	diskTotalBytes: null,
	diskUsedBytes: null,
	temperatureC: null,
	net: null
};
function unavailable(reason) {
	return {
		state: "unknown",
		reason,
		...EMPTY
	};
}
function numberFrom(text) {
	if (text === void 0 || text.trim() === "") return null;
	const value = Number(text.trim());
	return Number.isFinite(value) ? value : null;
}
function intFrom(text) {
	const value = numberFrom(text);
	return value === null ? null : Math.trunc(value);
}
function tokensOf(detail) {
	return detail === void 0 ? [] : detail.trim().split(/\s+/).filter((token) => token !== "");
}
function textOf(facts, key) {
	const value = facts.get(key);
	if (value === void 0) return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}
/**
* Parse the probe's stdout.
*
* Exit-code/timed-out/transport outcomes are answered BEFORE the markers so a
* half-written probe can never be reported as a complete sample.
*/
function parseMetrics(stdout, options) {
	if (options.error !== void 0 && options.error !== "") return unavailable(options.error);
	if (options.timedOut === true) return unavailable(`probe timed out after ${METRICS_TIMEOUT_MS / 1e3}s`);
	if (options.exitCode === null) return unavailable("the SSH channel closed before the probe exited");
	if (options.exitCode !== 0) {
		const first = (options.stderr ?? "").trim().split(/\r?\n/)[0] ?? "";
		return unavailable(`probe exited with code ${options.exitCode}${first === "" ? "" : `: ${first}`}`);
	}
	const facts = /* @__PURE__ */ new Map();
	let sawBegin = false;
	let sawEnd = false;
	for (const raw of stdout.split(/\r?\n/)) {
		const match = LINE_RE.exec(raw.trim());
		if (match === null) continue;
		const key = match[1];
		const detail = match[2] ?? "";
		if (key === "begin") {
			sawBegin = true;
			continue;
		}
		if (key === "end") {
			sawEnd = true;
			continue;
		}
		facts.set(key, detail);
	}
	if (!sawBegin) return unavailable("the probe did not start (no begin marker)");
	if (!sawEnd) return unavailable("the probe did not finish (no end marker)");
	const cpuTokens = tokensOf(facts.get("cpu"));
	const cpu = cpuTokens.length >= 8 ? {
		total: cpuTokens.slice(0, 8).reduce((sum, token) => sum + (Number(token) || 0), 0),
		idle: (Number(cpuTokens[3]) || 0) + (Number(cpuTokens[4]) || 0)
	} : null;
	const memTokens = tokensOf(facts.get("mem"));
	const memTotalKb = memTokens.length >= 2 ? numberFrom(memTokens[0]) : null;
	const memAvailableKb = memTokens.length >= 2 ? numberFrom(memTokens[1]) : null;
	const memTotalBytes = memTotalKb === null ? null : memTotalKb * 1024;
	const memUsedBytes = memTotalBytes === null || memAvailableKb === null ? null : Math.max(0, memTotalBytes - memAvailableKb * 1024);
	const diskTokens = tokensOf(facts.get("disk"));
	const diskTotalKb = diskTokens.length >= 2 ? numberFrom(diskTokens[0]) : null;
	const diskUsedKb = diskTokens.length >= 2 ? numberFrom(diskTokens[1]) : null;
	const diskTotalBytes = diskTotalKb === null ? null : diskTotalKb * 1024;
	const diskUsedBytes = diskUsedKb === null ? null : diskUsedKb * 1024;
	const loadTokens = tokensOf(facts.get("load"));
	const load = loadTokens.length >= 3 ? [
		Number(loadTokens[0]) || 0,
		Number(loadTokens[1]) || 0,
		Number(loadTokens[2]) || 0
	] : null;
	const netTokens = tokensOf(facts.get("net"));
	const net = netTokens.length >= 2 ? {
		rx: Number(netTokens[0]) || 0,
		tx: Number(netTokens[1]) || 0
	} : null;
	const temperatureMilli = intFrom(facts.get("temp"));
	const temperatureC = temperatureMilli === null ? null : temperatureMilli / 1e3;
	if (cpu === null && memTotalBytes === null) return unavailable("the probe answered without /proc CPU or memory (not a Linux host?)");
	return {
		state: "ok",
		kernel: textOf(facts, "kernel"),
		cpuCores: intFrom(facts.get("cores")),
		cpuModel: textOf(facts, "model"),
		ip: tokensOf(facts.get("ip"))[0] ?? null,
		uptimeSeconds: numberFrom(facts.get("uptime")),
		load,
		cpu,
		memTotalBytes,
		memUsedBytes,
		diskTotalBytes,
		diskUsedBytes,
		temperatureC,
		net
	};
}
/**
* CPU busy percentage between two counter samples.
*
* Null when a counter is missing, the sum did not advance, or the counters
* went backwards (a reboot between the two samples): all three mean "unknown",
* not "0%".
*/
function cpuPercent(previous, next) {
	if (previous === null || previous === void 0 || next === null || next === void 0) return null;
	const total = next.total - previous.total;
	const idle = next.idle - previous.idle;
	if (total <= 0 || idle < 0 || idle > total) return null;
	return Math.min(100, Math.max(0, (1 - idle / total) * 100));
}
/**
* Network bytes-per-second between two counter samples.
*
* Null when either counter is missing, the interval is not positive, or a
* counter went backwards (a reboot): a rate computed from a reset counter is
* noise, and showing it as a huge spike would be worse than "unknown".
*/
function netRateBps(previous, next, elapsedMs) {
	if (previous === null || previous === void 0 || next === null || next === void 0) return null;
	if (elapsedMs === null || elapsedMs === void 0 || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
	const rx = next.rx - previous.rx;
	const tx = next.tx - previous.tx;
	if (rx < 0 || tx < 0) return null;
	const seconds = elapsedMs / 1e3;
	return {
		rx: rx / seconds,
		tx: tx / seconds
	};
}
/** Bytes as a percentage of a total; null when either side is unknown. */
function usedPercent(used, total) {
	if (used === null || total === null || total <= 0) return null;
	return Math.min(100, Math.max(0, used / total * 100));
}
function messageOf$1(error) {
	return error instanceof Error ? error.message : String(error);
}
/** Every field null: an honest "we did not get an answer". */
function emptyMetrics(alias, state, reason, sampledAt) {
	return {
		alias,
		state,
		reason,
		sampledAt,
		kernel: null,
		cpuCores: null,
		cpuModel: null,
		ip: null,
		uptimeSeconds: null,
		load1: null,
		load5: null,
		load15: null,
		cpuPercent: null,
		memUsedBytes: null,
		memTotalBytes: null,
		memPercent: null,
		diskUsedBytes: null,
		diskTotalBytes: null,
		diskPercent: null,
		temperatureC: null,
		netRxBps: null,
		netTxBps: null
	};
}
var HostMonitor = class {
	pool;
	now;
	freshMs;
	cache = /* @__PURE__ */ new Map();
	inflight = /* @__PURE__ */ new Map();
	/**
	* Bumped by `forget`. A probe that started before a host edit/delete must not
	* write its answer into the cache afterwards — the counters belong to the old
	* connection, and a re-created host with the same alias would briefly read a
	* stale sample.
	*/
	generations = /* @__PURE__ */ new Map();
	constructor(pool, options = {}) {
		this.pool = pool;
		this.now = options.now ?? (() => Date.now());
		this.freshMs = options.freshMs ?? 3e3;
	}
	/** One sample for one alias; `force` bypasses the reuse window (manual refresh). */
	async sample(alias, force = false) {
		const cached = this.cache.get(alias);
		if (!force && cached !== void 0 && this.now() - cached.snapshot.sampledAt < this.freshMs) return cached.snapshot;
		const running = this.inflight.get(alias);
		if (running !== void 0) return running;
		const task = this.probe(alias).finally(() => {
			if (this.inflight.get(alias) === task) this.inflight.delete(alias);
		});
		this.inflight.set(alias, task);
		return task;
	}
	/** Drop everything known about one alias (host edited or deleted). */
	forget(alias) {
		this.cache.delete(alias);
		this.inflight.delete(alias);
		this.generations.set(alias, (this.generations.get(alias) ?? 0) + 1);
	}
	/**
	* Snapshots already in the cache, without dialing anything.
	*
	* A GET must not have a dial side effect: listing what the Host knows is the
	* read-only shape, and only an explicit per-host request (or the opt-in batch
	* flag) may wake a sleeping host.
	*/
	cached() {
		return [...this.cache.values()].map((entry) => entry.snapshot).sort((left, right) => left.alias.localeCompare(right.alias));
	}
	async probe(alias) {
		const generation = this.generations.get(alias) ?? 0;
		const startedAt = this.now();
		let result;
		try {
			result = await this.pool.exec(alias, metricsCommand(), { timeoutMs: METRICS_TIMEOUT_MS });
		} catch (error) {
			return emptyMetrics(alias, "error", messageOf$1(error), startedAt);
		}
		if (result.error !== void 0 && result.error !== "") return emptyMetrics(alias, "error", result.error, startedAt);
		const parsed = parseMetrics(result.stdout, {
			exitCode: result.exitCode,
			timedOut: result.timedOut,
			stderr: result.stderr
		});
		const sampledAt = this.now();
		const previous = this.cache.get(alias);
		const elapsedMs = previous?.counterAt === null || previous?.counterAt === void 0 ? null : Math.max(0, sampledAt - previous.counterAt);
		const cpu = cpuPercent(previous?.cpu ?? null, parsed.cpu);
		const rate = netRateBps(previous?.net ?? null, parsed.net, elapsedMs);
		const snapshot = {
			alias,
			state: parsed.state === "ok" ? "ok" : "unknown",
			...parsed.reason === void 0 ? {} : { reason: parsed.reason },
			sampledAt,
			kernel: parsed.kernel,
			cpuCores: parsed.cpuCores,
			cpuModel: parsed.cpuModel,
			ip: parsed.ip,
			uptimeSeconds: parsed.uptimeSeconds,
			load1: parsed.load?.[0] ?? null,
			load5: parsed.load?.[1] ?? null,
			load15: parsed.load?.[2] ?? null,
			cpuPercent: cpu,
			memUsedBytes: parsed.memUsedBytes,
			memTotalBytes: parsed.memTotalBytes,
			memPercent: usedPercent(parsed.memUsedBytes, parsed.memTotalBytes),
			diskUsedBytes: parsed.diskUsedBytes,
			diskTotalBytes: parsed.diskTotalBytes,
			diskPercent: usedPercent(parsed.diskUsedBytes, parsed.diskTotalBytes),
			temperatureC: parsed.temperatureC,
			netRxBps: rate?.rx ?? null,
			netTxBps: rate?.tx ?? null
		};
		const counters = parsed.cpu ?? previous?.cpu ?? null;
		const countersAt = parsed.cpu === null ? previous?.counterAt ?? null : sampledAt;
		const net = parsed.net ?? previous?.net ?? null;
		if ((this.generations.get(alias) ?? 0) === generation) this.cache.set(alias, {
			snapshot,
			cpu: counters,
			net,
			counterAt: countersAt
		});
		return snapshot;
	}
};
//#endregion
//#region src/processes.ts
/** Marker proving which probe branch actually ran. */
const PROCESSES_MARK = "@@RVS-PROCS";
/** Budget for the whole probe; a stuck process table must not pin a channel. */
const PROCESSES_TIMEOUT_MS = 15e3;
/**
* One bounded probe.
*
* GNU first (`--sort` + `etimes`), then the portable `ps aux` table for BSD /
* old systems (`ppid` and elapsed time are unknown there). The marker
* line is printed BEFORE the table so an interrupted probe is distinguishable
* from a genuinely empty one; the final marker lets the parser reject a
* truncated run.
*/
function processesCommand(max = 500) {
	const cap = Math.max(1, Math.min(500, Math.floor(max)));
	const gnu = `ps -eo pid=,ppid=,user:20=,pcpu=,pmem=,etimes=,args= --sort=-pcpu 2>/dev/null`;
	return [
		"export LC_ALL=C",
		`if ${gnu} >/dev/null 2>&1; then`,
		`  echo "${PROCESSES_MARK} gnu"`,
		`  ${gnu} | head -n ${cap + 1}`,
		"elif ps aux >/dev/null 2>&1; then",
		`  echo "${PROCESSES_MARK} bsd"`,
		`  ps aux | tail -n +2 | sort -k3 -rn | head -n ${cap + 1}`,
		"else",
		`  echo "${PROCESSES_MARK} none"`,
		"fi",
		`echo "${PROCESSES_MARK} end"`
	].join("\n");
}
function isKillSignal(value) {
	return value === "TERM" || value === "KILL";
}
/** Assert a PID a process snapshot may contain (1 is the remote init). */
function assertProcessPid(value) {
	const pid = typeof value === "number" ? value : Number(value);
	if (!Number.isInteger(pid) || pid <= 1 || pid > 2147483647) throw new Error("invalid process id");
	return pid;
}
/**
* Build the one kill command. The PID has already passed the snapshot check;
* single-quoting it keeps the command shape uniform with every other builder.
*/
function killCommand(pid, signal) {
	return `kill -s ${signal} ${shQuote(String(assertProcessPid(pid)))}`;
}
function numberOr(value) {
	if (!/^[0-9]+(?:\.[0-9]+)?$/.test(value)) return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}
/** Bound one argv line before it is serialized into the JSON response. */
function trimCommand(command) {
	return command.length <= 300 ? command : `${command.slice(0, 299)}…`;
}
/** GNU row: pid ppid user pcpu pmem etimes args. */
function parseGnuRow(line) {
	const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([0-9.]+)\s+([0-9.]+)\s+(\d+)\s+(.*)$/.exec(line);
	if (match === null) return void 0;
	const pid = match[1];
	const ppid = match[2];
	const user = match[3];
	const cpu = match[4];
	const mem = match[5];
	const elapsed = match[6];
	const command = match[7];
	return {
		pid: Number(pid),
		ppid: Number(ppid),
		user,
		cpuPercent: numberOr(cpu) ?? 0,
		memPercent: numberOr(mem) ?? 0,
		elapsedSeconds: numberOr(elapsed) ?? null,
		command: trimCommand(command.trim())
	};
}
/** BSD `ps aux` row: user pid %cpu %mem vsz rss tt stat started time command. */
function parseBsdRow(line) {
	const match = /^\s*(\S+)\s+(\d+)\s+([0-9.]+)\s+([0-9.]+)\s+\S+\s+\S+\s+\S+\s+\S+\s+(\S+)\s+\S+\s+(.*)$/.exec(line);
	if (match === null) return void 0;
	const user = match[1];
	const pid = match[2];
	const cpu = match[3];
	const mem = match[4];
	const command = match[6];
	return {
		pid: Number(pid),
		ppid: 0,
		user,
		cpuPercent: numberOr(cpu) ?? 0,
		memPercent: numberOr(mem) ?? 0,
		elapsedSeconds: null,
		command: trimCommand(command.trim())
	};
}
/**
* Parse one probe. `exitCode === null` (channel died) or a missing end marker
* means `unknown`, never an empty process table.
*/
function parseProcesses(stdout, exitCode) {
	const lines = stdout.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
	const markerAt = lines.findIndex((line) => line.trim() === `@@RVS-PROCS gnu` || line.trim() === `@@RVS-PROCS bsd` || line.trim() === `@@RVS-PROCS none`);
	if (exitCode === null || markerAt < 0) return {
		tool: "unknown",
		processes: [],
		truncated: false,
		error: "the remote process probe ended without a complete answer"
	};
	const marker = lines[markerAt]?.trim() ?? "";
	let endAt = -1;
	for (let index = lines.length - 1; index > markerAt; index -= 1) if (lines[index].trim() === `@@RVS-PROCS end`) {
		endAt = index;
		break;
	}
	if (endAt < 0) return {
		tool: "unknown",
		processes: [],
		truncated: false,
		error: "the remote process probe was interrupted"
	};
	if (marker.endsWith("none")) return {
		tool: "none",
		processes: [],
		truncated: false
	};
	const gnu = marker.endsWith("gnu");
	const parsedProcesses = [];
	for (const line of lines.slice(markerAt + 1, endAt)) {
		if (line.trim() === "") continue;
		const row = gnu ? parseGnuRow(line) : parseBsdRow(line);
		if (row !== void 0 && !row.command.includes("@@RVS-PROCS")) parsedProcesses.push(row);
	}
	if (parsedProcesses.length === 0) return {
		tool: "unknown",
		processes: [],
		truncated: false,
		error: "the remote ps output could not be parsed"
	};
	const truncated = parsedProcesses.length > 500;
	return {
		tool: gnu ? "gnu" : "bsd",
		processes: parsedProcesses.slice(0, 500),
		truncated
	};
}
//#endregion
//#region src/routes.ts
function queryParam(url, name) {
	const value = url.searchParams.get(name);
	return value === null ? void 0 : value;
}
/**
* Host alias a request URL names (`?alias=`), or `null` when it names none.
*
* Only the routes know what a request is about; the response writer needs that
* in order to attach only THIS host's notices (see `scopeHostNotices`).
*/
function urlAliasOf(req) {
	const alias = new URL(req.url ?? "/", "http://localhost").searchParams.get("alias");
	return alias === null || alias === "" ? null : alias;
}
/** Host alias a parsed JSON body names, or `null` when it names none. */
function bodyAliasOf(value) {
	if (typeof value !== "object" || value === null) return null;
	const alias = value.alias;
	return typeof alias === "string" && alias !== "" ? alias : null;
}
/**
* A caller mistake the route can name: well-formed HTTP, unusable payload.
*
* `/files` used to throw plain Errors for missing fields and map EVERY failure
* to 502, so "your request had no path" was reported as "the remote host
* failed". The class keeps that distinction at the HTTP status.
*/
var BadRequestError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "BadRequestError";
	}
};
/**
* Reject an oversized JSON body BEFORE reading it.
*
* A known Content-Length lets the route answer 413 without draining the body at
* all (the GUI always sends one). A chunked body without the header is caught by
* `readJsonBodyResult` after the read and answered with the same 413, so this
* preflight is only the cheap path — not the only one.
*/
function bodyTooLarge(req, maxBytes) {
	const raw = req.headers["content-length"];
	if (typeof raw !== "string") return false;
	const length = Number(raw);
	return Number.isFinite(length) && length > maxBytes;
}
/** Answer 413 and drain the rest of the body so the socket is not reset mid-response. */
function writePayloadTooLarge(req, res, maxBytes) {
	writeJson(res, 413, { error: `request body exceeds ${maxBytes} bytes` }, { connection: "close" });
	req.resume();
}
/**
* Read one JSON request body, answering the outcomes every route shares the same
* way: an oversized body is a 413 (the connection closes), malformed JSON is a
* 400. `{ ok: false }` means a response was already written — the handler returns.
*
* An EMPTY body still arrives as `null`, so each route keeps its own "missing
* object" answer, and `objectOnly` is passed through unchanged.
*/
async function readBodyOrError(req, res, opts = {}) {
	const result = await readJsonBodyResult(req, opts);
	if (result.kind === "too-large") {
		writeJson(res, 413, { error: `request body exceeds ${result.maxBytes} bytes` }, { connection: "close" });
		return { ok: false };
	}
	if (result.kind === "invalid") {
		writeJson(res, 400, { error: "invalid JSON body" });
		return { ok: false };
	}
	if (result.kind === "ok") {
		const alias = bodyAliasOf(result.value);
		if (alias !== null) scopeHostNotices(res, alias);
	}
	return {
		ok: true,
		body: result.kind === "ok" ? result.value : null
	};
}
/** Body cap of the /files route (base64/UTF-8 file content). */
const FILES_BODY_LIMIT = 10 * 1024 * 1024;
/** Body cap of the ssh_config import route (pasted config text). */
const SSH_CONFIG_BODY_LIMIT = 1024 * 1024;
/**
* Total budget for one archive stream (directory or multi-selection download).
*
* A hung remote `tar` (a stalled mount, a failing disk, a huge tree) otherwise
* pins the Host channel until the CLIENT disconnects, and `channel.close()`
* alone cannot stop a tar that is blocked on a read. Enforced on the remote side
* so it survives a dead HTTP socket too.
*/
const ARCHIVE_TIMEOUT_SECONDS = 600;
/**
* Wrap one archive command in a remote-side deadline.
*
* The command is a single `tar` invocation with already-quoted operands
* (`archive.ts` builders), so prefixing is syntactically safe and makes tar the
* direct child of `timeout` — TERM (then KILL after 3 s) reaches tar itself, no
* process-group id is needed (2026-10 audit, A16-1). Hosts without GNU `timeout`
* (BSD/macOS) fall back to today's behaviour instead of failing the download.
*/
function archiveCommandWithDeadline(command) {
	return `if command -v timeout >/dev/null 2>&1; then timeout -k 3 ${ARCHIVE_TIMEOUT_SECONDS} ${command}; else ${command}; fi`;
}
/**
* Error for a failed archive stream.
*
* GNU `timeout` reports 124 when TERM sufficed and 137 when KILL was needed;
* both mean "the remote budget ran out", which is more actionable than
* `tar failed (124): no stderr`.
*/
function archiveFailureMessage(exitCode, stderr) {
	if (exitCode === 124 || exitCode === 137) return /* @__PURE__ */ new Error(`archive timed out after ${ARCHIVE_TIMEOUT_SECONDS}s`);
	const detail = stderr.trim() === "" ? "no stderr" : stderr.trim().slice(0, 400);
	return /* @__PURE__ */ new Error(`tar failed (${exitCode === null || exitCode === void 0 ? "signal" : exitCode}): ${detail}`);
}
/** This plugin's version from the shipped package.json (Settings display). */
let cachedVersion;
function pluginVersion() {
	if (cachedVersion !== void 0) return cachedVersion;
	try {
		let dir = dirname(fileURLToPath(import.meta.url));
		for (let depth = 0; depth < 4; depth += 1) {
			const pkg = join(dir, "package.json");
			try {
				if (existsSync(pkg)) {
					const raw = JSON.parse(readFileSync(pkg, "utf8"));
					if (raw.name === "dsh-remote-vs" && typeof raw.version === "string" && raw.version !== "") {
						cachedVersion = raw.version;
						return cachedVersion;
					}
				}
			} catch {}
			dir = dirname(dir);
		}
	} catch {}
	cachedVersion = "unknown";
	return cachedVersion;
}
/** Package name our loader row is mounted from (ns discovery key). */
const REMOTE_PACKAGE_NAME = "dsh-remote-vs";
/**
* The working directory of one LIVE session, or undefined.
*
* Soft reads only: a composition without `agents`/`workingDirectory` answers
* undefined instead of throwing, and the callers treat that as "unknown".
*/
function liveSessionCwd(ctx, sessionId) {
	try {
		const agents = ctx.get("agents");
		const workingDirectory = ctx.get("workingDirectory");
		const agent = agents?.get?.(sessionId);
		if (agent?.session !== void 0 && typeof workingDirectory?.get === "function") {
			const value = workingDirectory.get(agent.session);
			if (typeof value === "string" && value !== "") return value;
		}
	} catch {}
}
/**
* This plugin's own loader entry id (the settings-form namespace).
*
* Settings are addressed by profile entry id, which is a mount choice, not
* a package property — an aggregate bundle may mount this package under any
* id. So the row is identified by package name plus fiber identity, with an
* enabled same-name row as fallback (the dsh-better-sidebar pattern). All
* reads are soft: unknown compositions answer undefined instead of throwing.
*/
function ownSettingsNs(ctx) {
	let fallback;
	try {
		const loader = ctx.get("loader");
		if (typeof loader?.entries !== "function") return void 0;
		const self = ctx.fiber;
		for (const entry of loader.entries()) {
			const id = entry.options.id;
			if (entry.options.name !== REMOTE_PACKAGE_NAME || typeof id !== "string" || id === "") continue;
			if (self !== void 0 && entry.fiber === self) return id;
			if (entry.disabled !== true && fallback === void 0) fallback = id;
		}
	} catch {
		return;
	}
	return fallback;
}
function makeRoutes(deps) {
	const { store, pool, worlds, ctx } = deps;
	/** Timeouts for this request (a volatile config edit must apply live). */
	const timeouts = () => deps.timeouts?.() ?? DEFAULT_TIMEOUTS;
	const files = new RemoteFiles(pool);
	const terminalSessions = new TerminalSessionRegistry(pool);
	const monitor = new HostMonitor(pool);
	/**
	* Last process snapshot per alias. The kill route validates against this
	* table, so a browser cannot construct a `kill` for an arbitrary PID; a stale
	* entry is refreshed before validation rather than trusted indefinitely.
	*/
	const processSnapshots = /* @__PURE__ */ new Map();
	/** One probe per alias at a time; a second reader joins the in-flight one. */
	const processInflight = /* @__PURE__ */ new Map();
	const forgetProcesses = (alias) => {
		processSnapshots.delete(alias);
		processInflight.delete(alias);
	};
	const readProcesses = async (alias, maxAgeMs) => {
		const cached = processSnapshots.get(alias);
		if (maxAgeMs > 0 && cached !== void 0 && Date.now() - cached.at < maxAgeMs) return cached.result;
		const joined = processInflight.get(alias);
		if (joined !== void 0) return joined;
		const task = (async () => {
			const result = await pool.exec(alias, processesCommand(), { timeoutMs: PROCESSES_TIMEOUT_MS });
			let parsed;
			if (result.error !== void 0) parsed = {
				tool: "unknown",
				processes: [],
				truncated: false,
				error: result.error
			};
			else if (result.timedOut) parsed = {
				tool: "unknown",
				processes: [],
				truncated: false,
				error: `the process probe did not finish within ${PROCESSES_TIMEOUT_MS / 1e3}s`
			};
			else if (result.exitCode === null) parsed = {
				tool: "unknown",
				processes: [],
				truncated: false,
				error: "the process probe ended without an exit status"
			};
			else parsed = parseProcesses(result.stdout, result.exitCode);
			if (parsed.tool === "gnu" || parsed.tool === "bsd") processSnapshots.set(alias, {
				at: Date.now(),
				result: parsed
			});
			else processSnapshots.delete(alias);
			return parsed;
		})();
		processInflight.set(alias, task);
		task.then(() => {
			if (processInflight.get(alias) === task) processInflight.delete(alias);
		}, () => {
			if (processInflight.get(alias) === task) processInflight.delete(alias);
		});
		return task;
	};
	const forwards = deps.forwards;
	const viewSettings = deps.viewSettings ?? new RemoteViewSettingsStore();
	/**
	* One noServer WebSocket server for terminal upgrades (RFC 6455).
	*
	* `maxPayload` is the authoritative frame bound: without it ws buffers up to
	* its 100 MiB default before the handler ever sees the message, in the
	* process that also runs the agent. Terminal frames are small JSON control
	* messages.
	*
	* It belongs to the route set, not to the module: as a module-level singleton
	* a plugin unload (and every later reload with a fresh module instance) left
	* the old server object alive forever. It must NOT close per route rebuild —
	* live PTYs survive a settings edit, and ws answers an upgrade on a closed
	* server with 503 — so teardown is bound to the fiber (the unload boundary);
	* a later load builds a fresh instance.
	*/
	const terminalWss = new WebSocketServer({
		noServer: true,
		maxPayload: TERMINAL_MAX_FRAME_BYTES
	});
	/** Idempotent teardown of the terminal upgrade server (plugin unload). */
	const close = () => {
		try {
			terminalWss.close();
		} catch {}
	};
	if (typeof ctx.effect === "function") ctx.effect(() => close, "dsh-remote-vs: terminal websocket server");
	/**
	* A corrupt store is a service-side failure with a path the user can repair.
	*
	* `store.list()`/`listWorkspaces()` re-read the JSON file, and a bad file
	* threw straight out of the route: the host webserver answered a bare 400
	* with no body, so the GUI could only report "request failed" and the path
	* that needs fixing never reached the person who could fix it.
	*/
	const writeStoreError = (res, error) => {
		writeJson(res, 503, {
			code: "store-corrupt",
			error: error instanceof Error ? error.message : String(error),
			path: store.filePath
		});
	};
	/** Did the store's own JSON parse/validate fail? (`store.filePath` names it.) */
	const isStoreError = (error) => error instanceof Error && error.message.includes(store.filePath);
	/**
	* Stream one remote `tar -czf -` command into a `.tar.gz` download response.
	*
	* Shared by the directory and multi-selection routes (they differ only in the
	* command and the attachment name). The archive is produced remotely; the
	* response has no length, backpressure pauses the channel, and a non-zero tar
	* exit destroys the response with the stderr tail.
	*/
	const streamArchive = async (alias, command, res, downloadName) => {
		let channel;
		try {
			channel = await pool.execChannel(alias, archiveCommandWithDeadline(command));
		} catch (error) {
			writeRouteError(res, error);
			return;
		}
		res.writeHead(200, {
			"content-type": "application/gzip",
			"content-disposition": attachmentHeader(downloadName),
			"cache-control": "no-store",
			"x-content-type-options": "nosniff"
		});
		res.flushHeaders();
		let closed = false;
		/** `undefined` until the remote process reports one. */
		let exitCode;
		let stderr = "";
		/** Finish once: end on success, destroy on failure, close the remote channel either way. */
		const stop = (error) => {
			if (closed) return;
			closed = true;
			try {
				channel.close();
			} catch {}
			if (error === void 0) {
				try {
					res.end();
				} catch {}
				return;
			}
			res.destroy(error);
		};
		channel.stdout.on("data", (chunk) => {
			if (closed) return;
			try {
				if (!res.write(chunk)) channel.stdout.pause();
			} catch (error) {
				stop(error instanceof Error ? error : new Error(String(error)));
			}
		});
		res.on("drain", () => {
			if (!closed) try {
				channel.stdout.resume();
			} catch {}
		});
		channel.stderr.on("data", (chunk) => {
			if (stderr.length < 16384) stderr += chunk.toString("utf8");
		});
		channel.on("error", (error) => stop(error));
		channel.on("exit", (code) => {
			exitCode = code;
		});
		channel.on("close", () => {
			if (closed) return;
			if (exitCode !== 0) {
				stop(archiveFailureMessage(exitCode, stderr));
				return;
			}
			stop();
		});
		res.on("close", () => stop());
	};
	/** Apply parsed import payloads; per-entry errors become skips. */
	const applyImport = (parsed) => {
		const imported = [];
		const skipped = [...parsed.skipped];
		for (const payload of parsed.payloads) {
			if (store.get(payload.alias) !== void 0) {
				skipped.push({
					alias: payload.alias,
					reason: "alias already exists"
				});
				continue;
			}
			try {
				store.create(payload);
				imported.push(payload.alias);
			} catch (error) {
				skipped.push({
					alias: payload.alias,
					reason: error instanceof Error ? error.message : String(error)
				});
			}
		}
		return {
			imported,
			skipped
		};
	};
	const routes = [
		{
			kind: "exact",
			path: REMOTE_API.hosts,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				const method = req.method ?? "GET";
				const url = new URL(req.url ?? "/", "http://localhost");
				if (method === "GET") {
					try {
						writeJson(res, 200, { hosts: store.list().map((h) => store.summarize(h)) });
					} catch (error) {
						writeStoreError(res, error);
					}
					return;
				}
				if (method === "POST") {
					const read = await readBodyOrError(req, res, { objectOnly: true });
					if (!read.ok) return;
					const body = read.body;
					if (body === null) {
						writeJson(res, 400, { error: "invalid JSON body" });
						return;
					}
					try {
						const entry = store.create(body);
						writeJson(res, 201, { host: store.summarize(entry) });
					} catch (error) {
						writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
					}
					return;
				}
				if (method !== "PATCH" && method !== "DELETE") {
					writeJson(res, 405, { error: `method not allowed: ${method}` });
					return;
				}
				const alias = queryParam(url, "alias");
				if (alias === void 0 || alias === "") {
					writeJson(res, 400, { error: "alias query parameter is required" });
					return;
				}
				if (method === "DELETE") {
					forwards?.stopAlias(alias);
					pool.forget(alias);
					monitor.forget(alias);
					forgetProcesses(alias);
					worlds.dropHost(alias).catch(() => void 0);
					if (!store.remove(alias)) {
						writeJson(res, 404, { error: `unknown host alias: ${alias}` });
						return;
					}
					worlds.syncWorkspaces().catch(() => void 0);
					writeJson(res, 200, { ok: true });
					return;
				}
				const read = await readBodyOrError(req, res, { objectOnly: true });
				if (!read.ok) return;
				const body = read.body;
				if (body === null) {
					writeJson(res, 400, { error: "invalid JSON body" });
					return;
				}
				try {
					pool.forget(alias);
					monitor.forget(alias);
					forgetProcesses(alias);
					worlds.dropHost(alias).catch(() => void 0);
					const entry = store.update(alias, body);
					writeJson(res, 200, { host: store.summarize(entry) });
				} catch (error) {
					writeJson(res, (error instanceof Error ? error.message : "").startsWith("unknown host alias") ? 404 : 400, { error: error instanceof Error ? error.message : String(error) });
				}
			}
		},
		{
			kind: "exact",
			path: REMOTE_API.status,
			handler: (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "GET") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				writeJson(res, 200, { connections: pool.status() });
			}
		},
		{
			kind: "exact",
			path: REMOTE_API.test,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "POST") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const read = await readBodyOrError(req, res, { objectOnly: true });
				if (!read.ok) return;
				const body = read.body;
				if (body === null || typeof body.alias !== "string") {
					writeJson(res, 400, { error: "alias is required" });
					return;
				}
				writeJson(res, 200, await pool.test(body.alias));
			}
		},
		{
			kind: "exact",
			path: REMOTE_API.keygen,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "POST") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const read = await readBodyOrError(req, res, { objectOnly: true });
				if (!read.ok) return;
				const body = read.body;
				if (body === null || typeof body.alias !== "string") {
					writeJson(res, 400, { error: "alias is required" });
					return;
				}
				try {
					writeJson(res, 200, await bootstrap(pool, store, body.alias));
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					writeJson(res, message.startsWith("unknown host alias") ? 404 : 502, { error: message });
				}
			}
		},
		{
			kind: "exact",
			path: REMOTE_API.exec,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "POST") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const read = await readBodyOrError(req, res, { objectOnly: true });
				if (!read.ok) return;
				const body = read.body;
				if (body === null || typeof body.alias !== "string" || typeof body.command !== "string" || body.command === "") {
					writeJson(res, 400, { error: "alias and a non-empty command are required" });
					return;
				}
				const timeoutMs = clampExecTimeout(body.timeoutMs);
				/** The client closed the request: its response is never read. */
				let clientGone = false;
				/** The client asked to stop: kill the remote even if the read is still opening. */
				let cancelRequested = false;
				/** The cancel handle was invoked (only once). */
				let cancelSent = false;
				let cancel;
				/**
				* Stop the remote process group exactly once.
				*
				* Same latch as the streaming route: the disconnect may land while
				* `pool.exec` is still acquiring the channel (slot queue, setsid probe,
				* connect), where no handle exists yet — the request is remembered and
				* fired the moment `onCancel` supplies one. Without this the command kept
				* running to its timeout after a page refresh, holding a channel slot and
				* remote CPU for nobody.
				*/
				const abortRemote = () => {
					cancelRequested = true;
					if (cancel === void 0 || cancelSent) return;
					cancelSent = true;
					cancel();
				};
				res.on("close", () => {
					clientGone = true;
					abortRemote();
				});
				try {
					const result = await pool.exec(body.alias, body.command, {
						...timeoutMs === void 0 ? {} : { timeoutMs },
						onCancel: (handle) => {
							cancel = handle;
							if (cancelRequested && !cancelSent) {
								cancelSent = true;
								handle();
							}
						}
					});
					if (!clientGone) writeJson(res, 200, result);
				} catch (error) {
					if (!clientGone) writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
				}
			}
		},
		{
			kind: "exact",
			path: REMOTE_API.execStream,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "POST") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const read = await readBodyOrError(req, res, { objectOnly: true });
				if (!read.ok) return;
				const body = read.body;
				if (body === null || typeof body.alias !== "string" || typeof body.command !== "string" || body.command === "") {
					writeJson(res, 400, { error: "alias and a non-empty command are required" });
					return;
				}
				const timeoutMs = clampExecTimeout(body.timeoutMs);
				res.writeHead(200, {
					"Content-Type": "text/event-stream; charset=utf-8",
					"Cache-Control": "no-cache, no-transform",
					Connection: "keep-alive",
					"X-Accel-Buffering": "no"
				});
				res.flushHeaders();
				/** No more events to the client (finished, or the socket broke). */
				let outputClosed = false;
				/** `res.end` already called. */
				let ended = false;
				/** The client asked to stop: kill the remote even if the read is still opening. */
				let cancelRequested = false;
				/** The cancel handle was invoked (only once). */
				let cancelSent = false;
				let cancel;
				/** Server-side forward cap: the client shows a scrolling tail anyway. */
				let sent = 0;
				const FORWARD_CAP = 4 * 1024 * 1024;
				/**
				* Stop the remote process group exactly once.
				*
				* The disconnect may happen while `pool.exec` is still acquiring the
				* channel (slot queue, setsid probe, connect) — the handle does not exist
				* yet then, so the request is latched and fired the moment `onCancel`
				* arrives; otherwise a push would finish unseen and uncancellable.
				*/
				const abortRemote = () => {
					cancelRequested = true;
					if (cancel === void 0 || cancelSent) return;
					cancelSent = true;
					cancel();
				};
				const send = (event) => {
					if (outputClosed) return;
					try {
						res.write(`data: ${JSON.stringify(event)}\n\n`);
					} catch {
						outputClosed = true;
						abortRemote();
					}
				};
				const heartbeat = setInterval(() => {
					if (outputClosed) return;
					try {
						res.write(": ping\n\n");
					} catch {
						outputClosed = true;
						abortRemote();
					}
				}, 15e3);
				heartbeat.unref?.();
				const stop = () => {
					if (ended) return;
					ended = true;
					outputClosed = true;
					clearInterval(heartbeat);
					try {
						res.end();
					} catch {}
				};
				res.on("close", () => {
					abortRemote();
					stop();
				});
				try {
					const result = await pool.exec(body.alias, body.command, {
						...timeoutMs === void 0 ? {} : { timeoutMs },
						onData: (stream, text) => {
							if (outputClosed || sent >= FORWARD_CAP) return;
							sent += Buffer.byteLength(text, "utf8");
							send({
								t: stream,
								d: text
							});
						},
						onCancel: (handle) => {
							cancel = handle;
							if (cancelRequested && !cancelSent) {
								cancelSent = true;
								handle();
							}
						}
					});
					if (outputClosed) return;
					send({
						t: "exit",
						success: result.success,
						exitCode: result.exitCode,
						timedOut: result.timedOut,
						durationMs: result.durationMs,
						...result.error === void 0 ? {} : { error: result.error }
					});
				} catch (error) {
					send({
						t: "exit",
						success: false,
						exitCode: null,
						timedOut: false,
						durationMs: 0,
						error: error instanceof Error ? error.message : String(error)
					});
				} finally {
					stop();
				}
			}
		},
		{
			kind: "exact",
			path: REMOTE_API.files,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "POST") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				if (bodyTooLarge(req, FILES_BODY_LIMIT)) {
					writePayloadTooLarge(req, res, FILES_BODY_LIMIT);
					return;
				}
				const read = await readBodyOrError(req, res, {
					objectOnly: true,
					maxBytes: FILES_BODY_LIMIT
				});
				if (!read.ok) return;
				const body = read.body;
				if (body === null || typeof body.op !== "string" || typeof body.alias !== "string") {
					writeJson(res, 400, { error: "op and alias are required" });
					return;
				}
				const alias = body.alias;
				try {
					switch (body.op) {
						case "list":
							if (typeof body.path !== "string") throw new BadRequestError("path is required");
							writeJson(res, 200, { entries: await files.list(alias, body.path) });
							return;
						case "stat":
							if (typeof body.path !== "string") throw new BadRequestError("path is required");
							writeJson(res, 200, { entry: await files.stat(alias, body.path) });
							return;
						case "read":
							if (typeof body.path !== "string") throw new BadRequestError("path is required");
							writeJson(res, 200, await files.read(alias, body.path));
							return;
						case "write": {
							if (typeof body.path !== "string" || typeof body.content !== "string") throw new BadRequestError("path and content are required");
							const encoding = body.encoding === "base64" ? "base64" : "utf8";
							/**
							* Optional optimistic lock. `expectMtime` is the version the client
							* loaded; when present the Host refuses a file that changed since.
							* Requests without it (helpers, deploy, the agent's write tool)
							* keep the old unconditional semantics — the guard protects a
							* human's buffer, it must not make programmatic writes fail.
							*/
							const expectMtime = body.expectMtime;
							const expectSize = body.expectSize;
							/**
							* A malformed baseline is a CALLER mistake, not "no baseline".
							*
							* Silently dropping it would turn `{expectMtime: "123"}` (a client
							* bug, a serializer change) into an UNGUARDED write — the exact
							* overwrite the caller was asking to be protected from, reported as
							* a success.
							*/
							if (expectMtime !== void 0 && (typeof expectMtime !== "number" || !Number.isFinite(expectMtime))) throw new BadRequestError("expectMtime must be a finite number");
							if (expectSize !== void 0 && (typeof expectSize !== "number" || !Number.isFinite(expectSize))) throw new BadRequestError("expectSize must be a finite number");
							const guard = typeof expectMtime === "number" ? {
								expectMtime,
								...typeof expectSize === "number" ? { expectSize } : {}
							} : void 0;
							writeJson(res, 200, await files.write(alias, body.path, body.content, encoding, guard));
							return;
						}
						case "mkdir":
							if (typeof body.path !== "string") throw new BadRequestError("path is required");
							await files.mkdir(alias, body.path);
							writeJson(res, 200, { ok: true });
							return;
						case "rm":
							if (typeof body.path !== "string") throw new BadRequestError("path is required");
							await files.remove(alias, body.path, body.recursive === true);
							writeJson(res, 200, { ok: true });
							return;
						case "rename":
							if (typeof body.from !== "string" || typeof body.to !== "string") throw new BadRequestError("from and to are required");
							await files.rename(alias, body.from, body.to);
							writeJson(res, 200, { ok: true });
							return;
						default: writeJson(res, 400, { error: `unknown op: ${body.op}` });
					}
				} catch (error) {
					/**
					* A save the remote side refused because the file moved on.
					*
					* 409, not 502: the operation did not fail, it was DECLINED — and the
					* client needs the current version to offer overwrite / reload / see
					* the difference. Collapsing this into the generic remote-error path
					* is how a silent overwrite becomes a red toast nobody can act on.
					*/
					if (error instanceof WriteConflictError) {
						writeJson(res, 409, {
							error: error.message,
							code: "conflict",
							conflict: error.conflict
						});
						return;
					}
					writeJson(res, error instanceof BadRequestError ? 400 : 502, { error: error instanceof Error ? error.message : String(error) });
				}
			}
		},
		{
			kind: "exact",
			path: REMOTE_API.upload,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "POST") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const url = new URL(req.url ?? "/", "http://localhost");
				const alias = url.searchParams.get("alias") ?? "";
				const path = url.searchParams.get("path") ?? "";
				const overwrite = url.searchParams.get("overwrite") === "1";
				if (alias === "" || path === "") {
					writeJson(res, 400, { error: "alias and path query parameters are required" });
					return;
				}
				if (!path.startsWith("/")) {
					writeJson(res, 400, { error: `path must be absolute: ${path}` });
					return;
				}
				try {
					if (!overwrite) {
						if (await files.stat(alias, path).then(() => true, () => false)) {
							writeJson(res, 409, {
								error: `${path} already exists`,
								exists: true
							});
							return;
						}
					}
					writeJson(res, 200, {
						ok: true,
						size: (await files.upload(alias, path, req, void 0, overwrite)).size
					});
				} catch (error) {
					writeRouteError(res, error);
				}
			}
		},
		{
			kind: "exact",
			path: REMOTE_API.download,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "GET") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const url = new URL(req.url ?? "/", "http://localhost");
				const alias = url.searchParams.get("alias") ?? "";
				const path = url.searchParams.get("path") ?? "";
				if (alias === "" || path === "") {
					writeJson(res, 400, { error: "alias and path query parameters are required" });
					return;
				}
				if (!path.startsWith("/")) {
					writeJson(res, 400, { error: `path must be absolute: ${path}` });
					return;
				}
				try {
					await files.download(alias, path, res);
				} catch (error) {
					if (!res.headersSent && !res.destroyed) writeRouteError(res, error);
					else res.destroy(error instanceof Error ? error : void 0);
				}
			}
		},
		{
			kind: "exact",
			path: REMOTE_API.downloadDir,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "GET") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const url = new URL(req.url ?? "/", "http://localhost");
				const alias = url.searchParams.get("alias") ?? "";
				const path = url.searchParams.get("path") ?? "";
				if (alias === "" || path === "") {
					writeJson(res, 400, { error: "alias and path query parameters are required" });
					return;
				}
				if (!path.startsWith("/")) {
					writeJson(res, 400, { error: `path must be absolute: ${path}` });
					return;
				}
				let command;
				try {
					if (!(await files.stat(alias, path)).isDir) {
						writeJson(res, 400, { error: `not a directory: ${path}` });
						return;
					}
					command = directoryArchiveCommand(path);
				} catch (error) {
					writeRouteError(res, error);
					return;
				}
				await streamArchive(alias, command, res, directoryArchiveName(path));
			}
		},
		{
			kind: "exact",
			path: REMOTE_API.downloadMany,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "GET") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const url = new URL(req.url ?? "/", "http://localhost");
				const alias = url.searchParams.get("alias") ?? "";
				const paths = url.searchParams.getAll("path");
				if (alias === "" || paths.length === 0) {
					writeJson(res, 400, { error: "alias and at least one path query parameter are required" });
					return;
				}
				if (paths.length > 100) {
					writeJson(res, 400, { error: `too many entries: ${paths.length} (max 100)` });
					return;
				}
				for (const path of paths) if (!path.startsWith("/")) {
					writeJson(res, 400, { error: `path must be absolute: ${path}` });
					return;
				}
				let command;
				try {
					for (const path of paths) await files.stat(alias, path);
					command = selectionArchiveCommand(paths);
				} catch (error) {
					writeRouteError(res, error);
					return;
				}
				await streamArchive(alias, command, res, selectionDownloadName(paths.length));
			}
		},
		{
			kind: "exact",
			path: REMOTE_API.workspaces,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				const method = req.method ?? "GET";
				const url = new URL(req.url ?? "/", "http://localhost");
				if (method === "GET") {
					try {
						const bindings = store.listWorkspaces();
						const aliasPaths = {};
						for (const b of bindings) aliasPaths[b.id] = worlds.aliasPathFor(b.id);
						worlds.syncWorkspaces().catch(() => void 0);
						writeJson(res, 200, {
							workspaces: bindings,
							mode: worlds.mode,
							aliasPaths,
							tombstones: store.listTombstones(),
							version: pluginVersion(),
							timeouts: timeouts()
						});
					} catch (error) {
						writeStoreError(res, error);
					}
					return;
				}
				if (method === "POST") {
					const read = await readBodyOrError(req, res, { objectOnly: true });
					if (!read.ok) return;
					const body = read.body;
					if (body === null) {
						writeJson(res, 400, { error: "invalid JSON body" });
						return;
					}
					try {
						const binding = store.createWorkspace(body);
						const aliasPath = worlds.aliasPathFor(binding.id);
						try {
							mkdirSync(aliasPath, { recursive: true });
						} catch (error) {
							throw new Error(`cannot materialize alias dir ${aliasPath}: ${error instanceof Error ? error.message : String(error)}`);
						}
						await worlds.syncWorkspaces().catch(() => void 0);
						writeJson(res, 201, {
							workspace: binding,
							aliasPath
						});
					} catch (error) {
						writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
					}
					return;
				}
				if (method !== "DELETE") {
					writeJson(res, 405, { error: `method not allowed: ${method}` });
					return;
				}
				const id = queryParam(url, "id");
				if (id === void 0 || id === "") {
					writeJson(res, 400, { error: "id query parameter is required" });
					return;
				}
				if (!store.removeWorkspace(id)) {
					writeJson(res, 404, { error: `unknown workspace id: ${id}` });
					return;
				}
				worlds.syncWorkspaces().catch(() => void 0);
				writeJson(res, 200, { ok: true });
			}
		},
		{
			kind: "exact",
			path: REMOTE_API.sessionCwd,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if ((req.method ?? "GET") !== "POST") {
					writeJson(res, 405, { error: `method not allowed: ${req.method ?? "GET"}` });
					return;
				}
				const read = await readBodyOrError(req, res, { objectOnly: true });
				if (!read.ok) return;
				const body = read.body;
				const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
				if (sessionId === "") {
					writeJson(res, 400, { error: "sessionId must be a non-empty string" });
					return;
				}
				writeJson(res, 200, { cwd: liveSessionCwd(ctx, sessionId) });
			}
		},
		{
			kind: "exact",
			path: REMOTE_API.changes,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if ((req.method ?? "GET") !== "POST") {
					writeJson(res, 405, { error: `method not allowed: ${req.method ?? "GET"}` });
					return;
				}
				const read = await readBodyOrError(req, res, { objectOnly: true });
				if (!read.ok) return;
				const body = read.body;
				const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
				const op = typeof body?.op === "string" ? body.op : "";
				if (sessionId === "" || op !== "list" && op !== "diff" && op !== "turnDiff") {
					writeJson(res, 400, { error: "op (list|diff|turnDiff) and a non-empty sessionId are required" });
					return;
				}
				const ledger = deps.changes;
				if (ledger === void 0) {
					writeJson(res, 200, {
						summary: null,
						diff: null
					});
					return;
				}
				if (typeof body?.repoSubdir === "string" || body?.repoSubdir === null) ledger.useRepoSubdir(sessionId, typeof body.repoSubdir === "string" ? body.repoSubdir : void 0);
				if (op === "list") {
					if (ledger.summary(sessionId) === null) {
						const cwd = liveSessionCwd(ctx, sessionId);
						if (cwd !== void 0) ledger.beginTurn({
							sessionId,
							cwd
						});
					}
					if (body?.force === true) ledger.rescan(sessionId);
					else if (body?.trackedOnly === true) ledger.touch(sessionId, 0);
					else ledger.touch(sessionId);
					writeJson(res, 200, { summary: ledger.summary(sessionId) });
					return;
				}
				const path = typeof body?.path === "string" ? body.path : "";
				if (path === "") {
					writeJson(res, 400, { error: `path is required for op=${op}` });
					return;
				}
				try {
					writeJson(res, 200, { diff: op === "turnDiff" ? await ledger.turnDiff(sessionId, path) : await ledger.diff(sessionId, path) });
				} catch (error) {
					writeRouteError(res, error);
				}
			}
		},
		{
			kind: "exact",
			path: REMOTE_API.routing,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if ((req.method ?? "GET") !== "POST") {
					writeJson(res, 405, { error: `method not allowed: ${req.method ?? "GET"}` });
					return;
				}
				const read = await readBodyOrError(req, res, { objectOnly: true });
				if (!read.ok) return;
				const mode = read.body?.mode;
				if (mode !== "off" && mode !== "shadow" && mode !== "enforce") {
					writeJson(res, 400, { error: `mode must be one of off/shadow/enforce (got ${JSON.stringify(mode) ?? "missing"})` });
					return;
				}
				try {
					const settings = ctx.get("settings");
					if (typeof settings?.update !== "function") {
						writeJson(res, 503, { error: "settings service unavailable (cannot persist routing mode)" });
						return;
					}
					const ns = ownSettingsNs(ctx) ?? "remote-vs";
					await settings.update(ns, { routingMode: mode });
					writeJson(res, 200, { mode: worlds.mode });
				} catch (error) {
					writeRouteError(res, error);
				}
			}
		},
		{
			kind: "exact",
			path: REMOTE_API.viewSettings,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				const method = req.method ?? "GET";
				if (method === "GET") {
					try {
						writeJson(res, 200, { settings: viewSettings.get() });
					} catch (error) {
						writeRouteError(res, error);
					}
					return;
				}
				if (method !== "POST") {
					writeJson(res, 405, { error: `method not allowed: ${method}` });
					return;
				}
				const read = await readBodyOrError(req, res, { objectOnly: true });
				if (!read.ok) return;
				try {
					writeJson(res, 200, { settings: viewSettings.patch(read.body ?? {}) });
				} catch (error) {
					writeRouteError(res, error);
				}
			}
		},
		{
			kind: "exact",
			path: REMOTE_API.deploy,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				const method = req.method ?? "GET";
				const url = new URL(req.url ?? "/", "http://localhost");
				if (method === "GET") {
					const alias = queryParam(url, "alias");
					const view = queryParam(url, "view") ?? "status";
					if (alias === void 0 || alias === "") {
						writeJson(res, 400, { error: "alias query parameter is required" });
						return;
					}
					if (view === "probe") {
						try {
							writeJson(res, 200, await probe(pool, alias));
						} catch (error) {
							writeRouteError(res, error);
						}
						return;
					}
					if (view === "status") {
						try {
							writeJson(res, 200, {
								deploy: store.require(alias).deploy ?? { status: "not-deployed" },
								helpers: helperAvailability()
							});
						} catch (error) {
							if (isStoreError(error)) writeStoreError(res, error);
							else writeJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
						}
						return;
					}
					writeJson(res, 400, { error: `unknown view: ${view}` });
					return;
				}
				if (method !== "POST") {
					writeJson(res, 405, { error: `method not allowed: ${method}` });
					return;
				}
				const read = await readBodyOrError(req, res, { objectOnly: true });
				if (!read.ok) return;
				const body = read.body;
				if (body === null || typeof body.alias !== "string") {
					writeJson(res, 400, { error: "alias is required" });
					return;
				}
				try {
					writeJson(res, 200, await pushPipeline(pool, store, body.alias, typeof body.version === "string" ? { version: body.version } : {}));
				} catch (error) {
					writeRouteError(res, error);
				}
			}
		},
		{
			kind: "exact",
			path: REMOTE_API.importSshConfig,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "POST") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				if (bodyTooLarge(req, SSH_CONFIG_BODY_LIMIT)) {
					writePayloadTooLarge(req, res, SSH_CONFIG_BODY_LIMIT);
					return;
				}
				const read = await readBodyOrError(req, res, { maxBytes: SSH_CONFIG_BODY_LIMIT });
				if (!read.ok) return;
				const body = read.body;
				try {
					const text = body !== null && typeof body.text === "string" ? body.text : readDefaultSshConfig();
					writeJson(res, 200, applyImport(parseSshConfig(text)));
				} catch (error) {
					writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
				}
			}
		},
		{
			kind: "exact",
			path: REMOTE_API.importDshSsh,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "POST") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				try {
					writeJson(res, 200, applyImport(migrateDshSsh()));
				} catch (error) {
					writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
				}
			}
		},
		{
			kind: "exact",
			path: REMOTE_API.terminalClose,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "POST") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const read = await readBodyOrError(req, res, { objectOnly: true });
				if (!read.ok) return;
				const body = read.body;
				if (body === null || typeof body.id !== "string" || body.id === "") {
					writeJson(res, 400, { error: "id is required" });
					return;
				}
				writeJson(res, 200, { ok: terminalSessions.close(body.id) });
			}
		},
		{
			kind: "exact",
			path: REMOTE_API.forwards,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (forwards === void 0) {
					writeJson(res, 503, { error: "port forwarding is not available in this composition" });
					return;
				}
				const url = new URL(req.url ?? "/", "http://localhost");
				if (req.method === "GET") {
					const alias = queryParam(url, "alias");
					writeJson(res, 200, { forwards: forwards.list(alias === void 0 || alias === "" ? void 0 : alias) });
					return;
				}
				if (req.method === "DELETE") {
					const id = queryParam(url, "id");
					if (id === void 0 || id === "") {
						writeJson(res, 400, { error: "id query parameter is required" });
						return;
					}
					writeJson(res, 200, { ok: forwards.stop(id) });
					return;
				}
				if (req.method !== "POST") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const read = await readBodyOrError(req, res, { objectOnly: true });
				if (!read.ok) return;
				const validated = validateForwardRequest(read.body);
				if (!validated.ok) {
					writeJson(res, 400, { error: validated.error });
					return;
				}
				try {
					writeJson(res, 200, { forward: await forwards.start(validated.value) });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					writeJson(res, /EADDRINUSE|EACCES|already in use|already has \d+ local forwards|permission denied|not permitted/i.test(message) ? 409 : 502, { error: message });
				}
			}
		},
		{
			kind: "exact",
			path: REMOTE_API.listenPorts,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "GET") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const alias = queryParam(new URL(req.url ?? "/", "http://localhost"), "alias");
				if (alias === void 0 || alias === "") {
					writeJson(res, 400, { error: "alias query parameter is required" });
					return;
				}
				try {
					const result = await pool.exec(alias, listenPortsCommand(), { timeoutMs: LISTEN_PORTS_TIMEOUT_MS });
					if (result.error !== void 0) {
						writeJson(res, 502, { error: result.error });
						return;
					}
					if (result.timedOut) {
						writeJson(res, 200, {
							tool: "unknown",
							ports: [],
							error: `the remote probe did not finish within ${LISTEN_PORTS_TIMEOUT_MS / 1e3}s`
						});
						return;
					}
					if (result.exitCode === null) {
						writeJson(res, 200, {
							tool: "unknown",
							ports: [],
							error: "the remote probe ended without an exit status (the SSH channel closed)"
						});
						return;
					}
					writeJson(res, 200, parseListenPorts(result.stdout, result.exitCode));
				} catch (error) {
					if (isStoreError(error)) writeStoreError(res, error);
					else writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
				}
			}
		},
		{
			kind: "exact",
			path: REMOTE_API.processes,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				const method = req.method ?? "GET";
				if (method !== "GET" && method !== "POST") {
					writeJson(res, 405, { error: `method not allowed: ${method}` });
					return;
				}
				try {
					if (method === "GET") {
						const url = new URL(req.url ?? "/", "http://localhost");
						const alias = queryParam(url, "alias");
						if (alias === void 0 || alias === "") {
							writeJson(res, 400, { error: "alias query parameter is required" });
							return;
						}
						if (store.get(alias) === void 0) {
							writeJson(res, 404, { error: `unknown host alias: ${alias}` });
							return;
						}
						writeJson(res, 200, await readProcesses(alias, queryParam(url, "refresh") === "1" ? 0 : 3e3));
						return;
					}
					const read = await readBodyOrError(req, res, { objectOnly: true });
					if (!read.ok) return;
					const body = read.body ?? {};
					const alias = typeof body.alias === "string" ? body.alias : "";
					if (alias === "") {
						writeJson(res, 400, { error: "alias is required" });
						return;
					}
					let pid;
					try {
						pid = assertProcessPid(body.pid);
					} catch (error) {
						writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
						return;
					}
					if (!isKillSignal(body.signal)) {
						writeJson(res, 400, { error: "signal must be TERM or KILL" });
						return;
					}
					if ((await readProcesses(alias, 0)).processes.find((process) => process.pid === pid) === void 0) {
						writeJson(res, 400, { error: `process ${pid} is not in the current remote snapshot` });
						return;
					}
					const result = await pool.exec(alias, killCommand(pid, body.signal), { timeoutMs: 1e4 });
					if (result.error !== void 0 || result.exitCode !== 0) {
						const message = result.error ?? result.stderr.trim() ?? "";
						writeJson(res, 502, { error: message === "" ? `kill failed [exit code: ${result.exitCode ?? "?"}]` : message });
						return;
					}
					processSnapshots.delete(alias);
					writeJson(res, 200, {
						ok: true,
						pid,
						signal: body.signal
					});
				} catch (error) {
					if (isStoreError(error)) writeStoreError(res, error);
					else writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
				}
			}
		},
		{
			kind: "exact",
			path: REMOTE_API.metrics,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "GET") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const url = new URL(req.url ?? "/", "http://localhost");
				const alias = queryParam(url, "alias");
				const refresh = queryParam(url, "refresh") === "1";
				/** Explicit opt-in to sampling every configured host (tooling/debug). */
				const all = queryParam(url, "all") === "1";
				try {
					let hosts;
					if (alias !== void 0 && alias !== "") {
						if (store.get(alias) === void 0) {
							writeJson(res, 404, { error: `unknown host alias: ${alias}` });
							return;
						}
						hosts = [await monitor.sample(alias, refresh)];
					} else if (all) {
						const aliases = store.list().map((host) => host.alias);
						hosts = await Promise.all(aliases.map((host) => monitor.sample(host, refresh)));
					} else hosts = monitor.cached();
					writeJson(res, 200, { hosts });
				} catch (error) {
					writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
				}
			}
		}
	];
	const upgrade = {
		path: REMOTE_API.terminal,
		handler: (req, socket, head) => {
			if (!isLoopbackRequest(req)) {
				socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
				socket.destroy();
				return;
			}
			const url = new URL(req.url ?? "/", "http://localhost");
			const alias = queryParam(url, "alias");
			const sessionId = queryParam(url, "session");
			if (alias === void 0 && sessionId === void 0) {
				socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
				socket.destroy();
				return;
			}
			const cols = Number.parseInt(queryParam(url, "cols") ?? "80", 10);
			const rows = Number.parseInt(queryParam(url, "rows") ?? "24", 10);
			const size = {
				cols: Number.isFinite(cols) && cols > 0 ? Math.min(cols, 500) : 80,
				rows: Number.isFinite(rows) && rows > 0 ? Math.min(rows, 200) : 24
			};
			terminalWss.handleUpgrade(req, socket, head, (ws) => {
				if (sessionId !== void 0) {
					if (terminalSessions.attach(ws, sessionId, size.cols, size.rows)) return;
					try {
						ws.send(JSON.stringify({
							t: "error",
							message: "terminal session expired"
						}));
					} catch {}
					try {
						ws.close(1e3);
					} catch {}
					return;
				}
				terminalSessions.open(ws, alias, size.cols, size.rows).then(() => void 0, () => void 0);
			});
		}
	};
	return {
		routes: routes.map((route) => ({
			...route,
			handler: (req, res) => {
				scopeHostNotices(res, urlAliasOf(req));
				return route.handler(req, res);
			}
		})),
		upgrade,
		terminalSessions,
		close
	};
}
//#endregion
//#region src/preset-switch.ts
/**
* Auto-switch decision for a new session born in a remote workspace.
*
* Why this module is pure
* -----------------------
* The 2026-11-10 bug was "sometimes no preset switch about 3 s after creating a
* session". Two independent causes had to be found by reading the Host:
*
* 1. **The switch only listened to `source === 'startup'`.** The Web client does
*    not always mint a session: `session.create` accepts a named BLANK session
*    and reuses it (`createInWorkspace` passes the first listed blank id), which
*    the Host answers through `agents.resume` → `agent/created` with source
*    `'resume'`. Those sessions never even armed the timer.
* 2. **A single 2.5 s shot lost every transient state.** At fire time the preset
*    may not be composed yet, the working directory may be unreadable, or the
*    workspace binding may not be listed; each guard returned silently, and the
*    one chance was spent.
*
* The fix keeps the "never block session creation" contract and turns the
* decision into a pure function plus a bounded retry loop, so every branch is
* covered by a gate instead of being inferred from a silent return.
*
* Blankness — no turn started — is the real precondition (`presets.select`
* enforces exactly that), and it is also what excludes resumed sessions with
* history. The event source only told us how the session came to be.
*/
/** Preset id this plugin switches remote sessions to (see `cordis.patch.yml`). */
const REMOTE_PRESET_ID = "remote";
/** Delay before each attempt, in order. The first attempt keeps the old 2.5 s. */
const PRESET_SWITCH_DELAYS_MS = [
	2500,
	1e3,
	1500,
	2e3,
	3e3
];
/**
* Decide one attempt.
*
* Order matters: the terminal reasons come first (config, history, user choice),
* then the transient ones (composed preset, cwd, route), then the switch.
*/
function decidePresetSwitch(facts) {
	if (facts.mode !== "enforce") return {
		action: "stop",
		reason: "routing-off"
	};
	if (!facts.hasPresets) return {
		action: "stop",
		reason: "presets-absent"
	};
	if (!facts.blank) return {
		action: "stop",
		reason: "not-blank"
	};
	if (facts.currentPreset === "remote") return {
		action: "stop",
		reason: "already-remote"
	};
	if (facts.currentPreset === void 0) return {
		action: "retry",
		reason: "preset-unbound"
	};
	if (facts.currentPreset !== facts.defaultPreset) return {
		action: "stop",
		reason: "custom-preset"
	};
	if (facts.cwd.trim() === "") return {
		action: "retry",
		reason: "cwd-unavailable"
	};
	if (facts.tombstoned) return {
		action: "stop",
		reason: "tombstoned"
	};
	if (facts.remote === void 0) return {
		action: "retry",
		reason: "route-unknown"
	};
	if (!facts.remote) return {
		action: "stop",
		reason: "local-session"
	};
	return { action: "switch" };
}
/** Wait for `ms`, unref'd so a pending switch never keeps the Host alive. */
function defaultSleep(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms).unref?.();
	});
}
/**
* Run attempts with the given delays until one stops or switches.
*
* A retry is only worth spending for the transient reasons the planner names;
* the loop itself does not re-classify, so a future terminal reason added to the
* planner stays terminal automatically.
*
* @returns the last attempt and how many attempts were used (1-based).
*/
async function runPresetSwitchAttempts(attempt, sleep = defaultSleep, delays = PRESET_SWITCH_DELAYS_MS) {
	let last;
	let attempts = 0;
	for (const delay of delays) {
		attempts += 1;
		await sleep(delay);
		last = await attempt();
		if (last.step.action !== "retry") return {
			step: last.step,
			facts: last.facts,
			attempts
		};
	}
	return {
		step: last === void 0 ? {
			action: "stop",
			reason: "services-absent"
		} : last.step,
		facts: last?.facts,
		attempts
	};
}
//#endregion
//#region src/changes/status.ts
/** Exit statuses of the read commands (git's own statuses pass through as-is). */
const READ_EXIT = {
	/** The reported root does not exist on the host (stale alias). */
	noRoot: 90,
	/**
	* No `base64` on the host. Probed up front because without it every read
	* would come back empty and look like "this file has no content", which is a
	* far worse failure than a clear refusal.
	*/
	noBase64: 92
};
/** Marker that starts one file block in a read reply. */
const FILE_MARKER = "@@RVS-FILE ";
/**
* Strict UTF-8 decoder — one instance, reused.
*
* A file's bytes are only "text" if they decode as UTF-8; anything else used to be
* decoded lossily into U+FFFD, which made the panel show mojibake with counts that
* were pure fiction AND made every revert fail (the patch's context lines could
* never match the real bytes). "Not decodable" is reported as binary instead — the
* one honest answer, and the one the undo path already refuses to touch.
*
* `ignoreBOM: true` is required, despite the confusing name: with the default
* (false) the decoder CONSUMES a leading UTF-8 BOM, while the editor's read path
* (`sftp.ts` → `Buffer.toString('utf8')`) keeps it. Stripping it here would make
* the ledger's text one code point shorter than the file on disk; the patch the
* undo path builds from that text then lacks the BOM on the first line and
* `git apply -R` rejects it (fail-closed, but the revert is unusable), and the
* first-line inline marks shift by one column.
*/
const strictUtf8 = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: true
});
/** Decode strict UTF-8, or undefined when the bytes are not valid UTF-8. */
function decodeUtf8Strict(bytes) {
	try {
		return strictUtf8.decode(bytes);
	} catch {
		return;
	}
}
/** POSIX single-quote one shell word. Throws on NUL, which no shell can carry. */
function shq(word) {
	if (word.includes("\0")) throw new Error("NUL byte in shell word");
	return `'${word.replace(/'/g, `'\\''`)}'`;
}
/** `base64` of a UTF-8 string, for the marker's path field. */
function pathToken(path) {
	return Buffer.from(path, "utf8").toString("base64");
}
/** `cd` into the root, or exit with {@link READ_EXIT.noRoot}. */
function cdLine(root) {
	return `cd ${shq(root)} || exit ${READ_EXIT.noRoot}`;
}
/** A cap is a byte count: non-negative, integral, and never NaN. */
function capOf(value) {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}
/**
* Tracked paths that changed, HEAD/index vs worktree, staged changes included.
*
* `-uno` is what keeps this cheap: untracked detection is the expensive half
* (11s above) and it is answered by {@link untrackedCommand} instead. `-- .`
* scopes the walk to the session root, so a session sitting in one package of
* a monorepo does not pay for the rest.
*
* @param root - remote absolute POSIX directory (the session cwd).
* @returns a `sh` script printing NUL-separated porcelain v1 records.
*/
function trackedStatusCommand(root) {
	return [cdLine(root), "git --no-pager status --porcelain -z -uno -- ."].join("\n");
}
/**
* Directory names the ledger does not count as session changes.
*
* Build output and dependency caches are the two things a build leaves behind,
* and neither is this session's work. `--exclude-standard` only covers what the
* repository's own ignore rules name, so a checkout whose build directory is NOT
* ignored pays twice: thousands of paths fill the 500-row list (sorted, and
* `build/`/`out/` sort BEFORE `src/`, so the real changes get truncated away) and
* every listed path costs a read out of the 8 MiB transfer budget.
*
* The names mirror the three lists the plugin already prunes by elsewhere
* (`client/quickopen-model.ts` `EXCLUDED_DIRECTORIES`, `p2/file-refs.ts`
* `REMOTE_FILE_SEARCH_EXCLUDED_DIRECTORIES`, `search-ops.ts` `PRUNE_DIRS`). One
* vocabulary, four consumers: fold them into a shared module when one of those
* surfaces is next touched, instead of adding a fifth spelling here.
*/
const UNTRACKED_EXCLUDED_DIRECTORIES = [
	".git",
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	"target",
	".next",
	".nuxt",
	".turbo",
	".venv",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".gradle"
];
/** Ceiling on the pathspecs one command carries (a cap, not a policy). */
const MAX_EXCLUDE_DIRS = 32;
/**
* Keep only directory names a pathspec may name safely.
*
* A value that is absolute, carries a separator, walks up or looks like a flag
* is DROPPED rather than rejected: the list is configuration, and one bad entry
* must not stop the scan — the scan's job is to say what changed, not to police
* a setting. Dropping is also the conservative direction: a name that is not
* excluded is merely visible, while a malformed pathspec would hide paths the
* user never asked to hide (or turn `--exclude` into another flag).
*
* @param dirs - candidate names (undefined = none).
* @returns the usable names, deduplicated, in the given order.
*/
function excludeDirNames(dirs) {
	const kept = [];
	for (const raw of dirs ?? []) {
		const name = raw.trim();
		if (name === "" || name === "." || name === "..") continue;
		if (name.includes("/") || name.includes("\\") || name.includes("\0")) continue;
		if (/[*?[\]]/.test(name)) continue;
		if (name.startsWith("-")) continue;
		if (kept.includes(name)) continue;
		if (kept.length >= MAX_EXCLUDE_DIRS) break;
		kept.push(name);
	}
	return kept;
}
/**
* New files git is not tracking yet (the ones a session usually creates).
*
* The exclusions are pushed down as pathspecs (`:(exclude)out`) rather than
* filtered after the fact, so those paths never cross the wire and never enter
* the 500-row cap. Measured on a tree with 3000 build outputs + 300 sources:
* 3300 records / 61.5 KB unfiltered versus 300 records / 6.8 KB with two
* exclusions — the walk itself costs the same either way (git still descends
* those directories), so the win is wire bytes, parse time and the read budget,
* not scan latency.
*
* @param root - remote absolute POSIX directory (the session cwd).
* @param excludeDirs - directory names to leave out (see {@link excludeDirNames}).
* @returns a `sh` script printing NUL-separated paths.
*/
function untrackedCommand(root, excludeDirs = []) {
	const pathspec = [
		"--",
		".",
		...excludeDirNames(excludeDirs).map((name) => shq(`:(exclude)${name}`))
	].join(" ");
	return [cdLine(root), `git ls-files --others --exclude-standard -z ${pathspec}`].join("\n");
}
/**
* Parse `git status --porcelain -z -uno` output.
*
* Porcelain v1 with `-z` writes `XY <path>\0`, and for a rename or copy the
* source path follows as its own record: `R  <new>\0<old>\0` (verified against
* git 2.x: the NEW path comes first). The source record is consumed, not parsed
* as its own entry, and the reported path is the NEW one — the only path the
* editor can open.
*
* The two status columns mean "index vs HEAD" (X) and "worktree vs index" (Y);
* one letter is reported, chosen for how the file reads in a session review:
* conflict > deleted > renamed > copied > added > typechange > modified.
*
* @param stdout - raw reply of {@link trackedStatusCommand}.
*/
function parseStatusZ(stdout) {
	const entries = [];
	const records = stdout.split("\0");
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (record === void 0 || record.length < 4) continue;
		const x = record.charAt(0);
		const y = record.charAt(1);
		if (record.charAt(2) !== " ") continue;
		const path = record.slice(3);
		if (path === "") continue;
		if (x === "R" || y === "R" || x === "C" || y === "C") index += 1;
		entries.push({
			path,
			status: statusOf(x, y)
		});
	}
	return entries;
}
/** Collapse porcelain's two columns into the one letter a review panel shows. */
function statusOf(x, y) {
	const both = `${x}${y}`;
	if (x === "?" || y === "?") return "?";
	if (x === "U" || y === "U" || both === "AA" || both === "DD") return "U";
	if (x === "D" || y === "D") return "D";
	if (x === "R" || y === "R") return "R";
	if (x === "C" || y === "C") return "C";
	if (x === "A" || y === "A") return "A";
	if (x === "T" || y === "T") return "T";
	return "M";
}
/**
* Parse `git ls-files --others --exclude-standard -z` output into untracked
* entries. Git already filtered ignored files out, and its paths are never
* quoted in `-z` mode.
*/
function parseUntrackedZ(stdout) {
	const entries = [];
	for (const record of stdout.split("\0")) {
		if (record === "") continue;
		entries.push({
			path: record,
			status: "?"
		});
	}
	return entries;
}
/**
* Read several worktree files in one remote run.
*
* One `sh` script walks the paths in order and emits a {@link ReadResult} block
* per path. Sizes come from `wc -c` before anything is transferred, so a 4GB
* build artifact costs one `stat` instead of 5GB of base64; the running total
* stops the reply from growing past `totalCapBytes`, after which the remaining
* paths are reported `big` without being read.
*
* A symlink reports its target as content, because that is what git stores for
* mode 120000 — catting the link's target file would diff the wrong bytes.
*
* @param root - remote absolute POSIX directory (the session cwd).
* @param paths - paths relative to `root`.
* @param capBytes - per-file cap; larger files are reported `big`.
* @param totalCapBytes - cap on the sum of transferred content bytes.
*/
function readWorktreeCommand(root, paths, capBytes, totalCapBytes) {
	return [
		"set -u",
		`command -v base64 >/dev/null 2>&1 || exit ${READ_EXIT.noBase64}`,
		cdLine(root),
		`rvs_cap=${capOf(capBytes)}`,
		`rvs_ttl=${capOf(totalCapBytes)}`,
		"rvs_total=0",
		"# rvs_one <base64(path)> <path>: emit one @@RVS-FILE block.",
		"rvs_one() {",
		"  rvs_b=$1",
		"  rvs_p=$2",
		"  rvs_src=missing",
		"  rvs_n=0",
		"  if [ -L \"$rvs_p\" ]; then",
		"    if rvs_v=$(readlink -- \"$rvs_p\" 2>/dev/null); then",
		"      rvs_src=symlink",
		"      # Bytes, not characters: the caps below are byte budgets.",
		"      rvs_n=$(printf \"%s\" \"$rvs_v\" | wc -c | tr -d \" \")",
		"    fi",
		"  elif [ -f \"$rvs_p\" ] && [ -r \"$rvs_p\" ]; then",
		"    rvs_n=$(wc -c < \"$rvs_p\" 2>/dev/null | tr -d \" \")",
		"    case $rvs_n in",
		"      \"\"|*[!0-9]*) rvs_n=0 ;;",
		"      *) rvs_src=file ;;",
		"    esac",
		"  fi",
		"  if [ \"$rvs_src\" = missing ]; then",
		"    printf '@@RVS-FILE %s %s 0 0@@\\n' \"$rvs_b\" absent",
		"    return 0",
		"  fi",
		"  # mtime is what lets a caller rule out \"unchanged\" for a file whose bytes",
		"  # were withheld by the caps below.",
		"  rvs_m=$(stat -c %Y -- \"$rvs_p\" 2>/dev/null || echo 0)",
		"  case $rvs_m in \"\"|*[!0-9]*) rvs_m=0 ;; esac",
		"  if [ \"$rvs_n\" -gt \"$rvs_cap\" ] || [ \"$((rvs_total + rvs_n))\" -gt \"$rvs_ttl\" ]; then",
		"    printf '@@RVS-FILE %s %s %s %s@@\\n' \"$rvs_b\" big \"$rvs_m\" \"$rvs_n\"",
		"    return 0",
		"  fi",
		"  if [ \"$rvs_src\" = symlink ]; then",
		"    rvs_e=$(printf \"%s\" \"$rvs_v\" | base64 | tr -d \"\\n\")",
		"  else",
		"    rvs_e=$(base64 < \"$rvs_p\" 2>/dev/null | tr -d \"\\n\")",
		"    # A non-empty file that produced no bytes vanished under us.",
		"    if [ -z \"$rvs_e\" ] && [ \"$rvs_n\" -gt 0 ]; then",
		"      printf '@@RVS-FILE %s %s 0 0@@\\n' \"$rvs_b\" absent",
		"      return 0",
		"    fi",
		"  fi",
		"  printf '@@RVS-FILE %s %s %s %s@@\\n%s\\n' \"$rvs_b\" ok \"$rvs_m\" \"$rvs_n\" \"$rvs_e\"",
		"  rvs_total=$((rvs_total + rvs_n))",
		"  return 0",
		"}",
		...paths.map((path) => `rvs_one ${shq(pathToken(path))} ${shq(path)}`)
	].join("\n");
}
/**
* Read several `HEAD:<path>` blobs in one remote run — the "before" side of a
* file that was already committed and clean when the session started.
*
* `git cat-file -s` answers existence *and* size before any bytes move, so the
* caps are exact, and a path that is not in `HEAD` (a new file, a repository
* with no commit yet, a submodule gitlink) is reported `absent` rather than
* failing the whole read. `cat-file blob` is used instead of `show` on purpose:
* no textconv, no filters, no pager — the bytes git will diff.
*
* @param root - remote absolute POSIX directory (the session cwd).
* @param paths - paths relative to `root`.
* @param capBytes - per-file cap; larger blobs are reported `big`.
* @param totalCapBytes - cap on the sum of transferred content bytes.
*/
function readHeadCommand(root, paths, capBytes, totalCapBytes) {
	return [
		"set -u",
		`command -v base64 >/dev/null 2>&1 || exit ${READ_EXIT.noBase64}`,
		cdLine(root),
		`rvs_cap=${capOf(capBytes)}`,
		`rvs_ttl=${capOf(totalCapBytes)}`,
		"rvs_total=0",
		"# rvs_one <base64(path)> <path>: emit one @@RVS-FILE block.",
		"rvs_one() {",
		"  rvs_b=$1",
		"  rvs_p=$2",
		"  rvs_n=",
		"  if ! rvs_n=$(git cat-file -s \"HEAD:$rvs_p\" 2>/dev/null); then",
		"    printf '@@RVS-FILE %s absent 0 0@@\\n' \"$rvs_b\"",
		"    return 0",
		"  fi",
		"  rvs_n=$(printf \"%s\" \"$rvs_n\" | tr -d \" \")",
		"  case $rvs_n in",
		"    \"\"|*[!0-9]*)",
		"      printf '@@RVS-FILE %s absent 0 0@@\\n' \"$rvs_b\"",
		"      return 0",
		"      ;;",
		"  esac",
		"  if [ \"$rvs_n\" -gt \"$rvs_cap\" ] || [ \"$((rvs_total + rvs_n))\" -gt \"$rvs_ttl\" ]; then",
		"    printf '@@RVS-FILE %s big 0 %s@@\\n' \"$rvs_b\" \"$rvs_n\"",
		"    return 0",
		"  fi",
		"  rvs_e=$(git cat-file blob \"HEAD:$rvs_p\" 2>/dev/null | base64 | tr -d \"\\n\")",
		"  # Non-empty blob but no bytes decoded: not a blob (a tree or a gitlink).",
		"  if [ -z \"$rvs_e\" ] && [ \"$rvs_n\" -gt 0 ]; then",
		"    printf '@@RVS-FILE %s absent 0 0@@\\n' \"$rvs_b\"",
		"    return 0",
		"  fi",
		"  printf '@@RVS-FILE %s ok 0 %s@@\\n%s\\n' \"$rvs_b\" \"$rvs_n\" \"$rvs_e\"",
		"  rvs_total=$((rvs_total + rvs_n))",
		"  return 0",
		"}",
		...paths.map((path) => `rvs_one ${shq(pathToken(path))} ${shq(path)}`)
	].join("\n");
}
/**
* Name every immediate subdirectory that is a git repository.
*
* A session working directory is often a CONTAINER for repositories (a root
* that holds another repository inside it), and
* `git status` at the container answers 128. This is a one-level `ls`-style
* probe — bounded work, no `find` — so it can never become the expensive part
* of a scan.
*
* It prints ALL matches on purpose: a workspace with several repositories has no
* single right answer, and the caller must refuse to guess rather than pick the
* first one. The SCM panel's explicit repository directory is the real answer.
*
* @param root - remote absolute POSIX directory (the session cwd).
*/
function reposBelowCommand(root) {
	return [
		"set -u",
		`cd ${shq(root)} || exit ${READ_EXIT.noRoot}`,
		"for rvs_d in */; do",
		"  [ -d \"$rvs_d/.git\" ] || continue",
		"  printf '%s\\n' \"${rvs_d%/}\"",
		"done"
	].join("\n");
}
/**
* Parse a {@link readWorktreeCommand} / {@link readHeadCommand} reply.
*
* Keys are the decoded paths, exactly as requested. A marker without its
* content line can only mean the reply was cut short (a timeout killing the
* pipe); such a path is reported truncated rather than as an empty file, so an
* aborted read never masquerades as "the file is empty".
*
* @param stdout - raw reply of either read command.
*/
function parseReads(stdout) {
	const results = /* @__PURE__ */ new Map();
	const lines = stdout.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === void 0 || !line.startsWith(FILE_MARKER)) continue;
		const fields = line.slice(11);
		if (!fields.endsWith("@@")) continue;
		const parts = fields.slice(0, -2).split(" ");
		if (parts.length < 2) continue;
		const token = parts[0] ?? "";
		const flags = parts[1] ?? "";
		const path = Buffer.from(token, "base64").toString("utf8");
		if (path === "") continue;
		const mtime = parts.length > 3 ? Number.parseInt(parts[2] ?? "", 10) : NaN;
		const size = parts.length > 3 ? Number.parseInt(parts[3] ?? "", 10) : NaN;
		const stats = {
			...Number.isSafeInteger(mtime) && mtime > 0 ? { mtime } : {},
			...Number.isSafeInteger(size) && size >= 0 ? { size } : {}
		};
		if (flags !== "ok") {
			results.set(path, flags === "big" ? {
				text: null,
				truncated: true,
				binary: false,
				absent: false,
				...stats
			} : {
				text: null,
				truncated: false,
				binary: false,
				absent: true,
				...stats
			});
			continue;
		}
		const encoded = lines[index + 1];
		if (encoded === void 0 || index + 1 === lines.length - 1) {
			results.set(path, {
				text: null,
				truncated: true,
				binary: false,
				absent: false,
				...stats
			});
			break;
		}
		index += 1;
		const bytes = Buffer.from(encoded, "base64");
		if (bytes.includes(0)) {
			results.set(path, {
				text: null,
				truncated: false,
				binary: true,
				absent: false,
				...stats
			});
			continue;
		}
		const text = decodeUtf8Strict(bytes);
		if (text === void 0) {
			results.set(path, {
				text: null,
				truncated: false,
				binary: true,
				absent: false,
				...stats
			});
			continue;
		}
		results.set(path, {
			text,
			truncated: false,
			binary: false,
			absent: false,
			...stats
		});
	}
	return results;
}
//#endregion
//#region src/changes/text-diff.ts
/** How far Myers may wander before the comparison degrades to "all replaced". */
const MAX_EDIT_DISTANCE = 2e3;
/**
* Split text into lines the way git does: `\n` is the separator, the last one
* does not create an empty line, and `\r` stays part of the line.
*/
function splitLines(text) {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}
/** Diff two line arrays into an edit script; `undefined` when the cap was hit. */
function editScript(before, after) {
	const prefix = [];
	let start = 0;
	const shortest = Math.min(before.length, after.length);
	while (start < shortest && before[start] === after[start]) {
		prefix.push({
			kind: "=",
			text: before[start] ?? ""
		});
		start += 1;
	}
	const suffix = [];
	let beforeEnd = before.length - 1;
	let afterEnd = after.length - 1;
	while (beforeEnd >= start && afterEnd >= start && before[beforeEnd] === after[afterEnd]) {
		suffix.push({
			kind: "=",
			text: before[beforeEnd] ?? ""
		});
		beforeEnd -= 1;
		afterEnd -= 1;
	}
	suffix.reverse();
	const middle = myers(before.slice(start, beforeEnd + 1), after.slice(start, afterEnd + 1));
	if (middle === void 0) return void 0;
	return [
		...prefix,
		...middle,
		...suffix
	];
}
/**
* Myers' greedy algorithm with a per-level trace, so the path can be walked back.
*
* `trace[d]` holds the furthest x per diagonal after `d - 1` steps, which is
* exactly what the backtrack at distance `d` reads (`prevK` is always a
* diagonal reachable in `d - 1` steps). Only the diagonals a level touches are
* copied, which keeps the trace at O(d²) instead of O(d · (n + m)).
*/
function myers(before, after) {
	const n = before.length;
	const m = after.length;
	if (n === 0) return after.map((text) => ({
		kind: "+",
		text
	}));
	if (m === 0) return before.map((text) => ({
		kind: "-",
		text
	}));
	const limit = Math.min(n + m, MAX_EDIT_DISTANCE);
	const offset = limit + 2;
	const furthest = new Int32Array(2 * offset + 5).fill(-1);
	furthest[1 + offset] = 0;
	const trace = [];
	let distance = -1;
	for (let d = 0; d <= limit && distance < 0; d += 1) {
		const base = -(d + 1);
		const snapshot = new Int32Array(2 * d + 3);
		for (let k = base; k <= d + 1; k += 1) snapshot[k - base] = furthest[k + offset] ?? -1;
		trace.push(snapshot);
		for (let k = -d; k <= d; k += 2) {
			let x;
			if (k === -d || k !== d && (furthest[k - 1 + offset] ?? -1) < (furthest[k + 1 + offset] ?? -1)) x = furthest[k + 1 + offset] ?? -1;
			else x = (furthest[k - 1 + offset] ?? -1) + 1;
			let y = x - k;
			while (x < n && y < m && before[x] === after[y]) {
				x += 1;
				y += 1;
			}
			furthest[k + offset] = x;
			if (x >= n && y >= m) {
				distance = d;
				break;
			}
		}
	}
	if (distance < 0) return void 0;
	return backtrack(trace, before, after, distance);
}
/** Walk a completed Myers trace back into an edit script, in file order. */
function backtrack(trace, before, after, distance) {
	const ops = [];
	let x = before.length;
	let y = after.length;
	for (let d = distance; d > 0; d -= 1) {
		const snapshot = trace[d];
		if (snapshot === void 0) break;
		const base = -(d + 1);
		const at = (k) => snapshot[k - base] ?? -1;
		const k = x - y;
		const prevK = k === -d || k !== d && at(k - 1) < at(k + 1) ? k + 1 : k - 1;
		const prevX = at(prevK);
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			ops.push({
				kind: "=",
				text: before[x - 1] ?? ""
			});
			x -= 1;
			y -= 1;
		}
		if (x === prevX) {
			ops.push({
				kind: "+",
				text: after[y - 1] ?? ""
			});
			y -= 1;
		} else {
			ops.push({
				kind: "-",
				text: before[x - 1] ?? ""
			});
			x -= 1;
		}
	}
	while (x > 0 && y > 0) {
		ops.push({
			kind: "=",
			text: before[x - 1] ?? ""
		});
		x -= 1;
		y -= 1;
	}
	while (x > 0) {
		ops.push({
			kind: "-",
			text: before[x - 1] ?? ""
		});
		x -= 1;
	}
	while (y > 0) {
		ops.push({
			kind: "+",
			text: after[y - 1] ?? ""
		});
		y -= 1;
	}
	ops.reverse();
	return ops;
}
/** Compare two texts into git-shaped hunks (default 3 lines of context). */
function diffText(before, after, context = 3) {
	const span = Number.isFinite(context) ? Math.max(0, Math.floor(context)) : 3;
	if (before === after) return {
		hunks: [],
		added: 0,
		deleted: 0
	};
	const oldLines = splitLines(before);
	const newLines = splitLines(after);
	const beforeNoEol = before !== "" && !before.endsWith("\n");
	const afterNoEol = after !== "" && !after.endsWith("\n");
	const ops = editScript(oldLines, newLines) ?? [...oldLines.map((text) => ({
		kind: "-",
		text
	})), ...newLines.map((text) => ({
		kind: "+",
		text
	}))];
	markTrailingNewline(ops, beforeNoEol, afterNoEol);
	return buildHunks(ops, span, beforeNoEol, afterNoEol);
}
/**
* Make "this line's final newline changed" visible to the diff.
*
* `splitLines` drops the terminator, so a line without one is indistinguishable
* from the same line with one — yet to git they are different lines, and it
* prints such a pair once removed (with the marker) and once added:
*
* ```
* before "a"          after "a\nb\n"      =>  -a (no eol),  +a, +b
* before "a\nb\n"     after "a\nb"        =>   a,  -b, +b (no eol)
* ```
*
* The old file's final line can only be byte-equal to a new-side line when that
* line is the new file's final line too *and* both sides agree about the EOL, so
* any other match against it must be broken into a removal plus an addition.
*/
function markTrailingNewline(ops, beforeNoEol, afterNoEol) {
	if (!beforeNoEol && !afterNoEol) return;
	const oldLast = lastIndexOfKind(ops, (kind) => kind !== "+");
	const newLast = lastIndexOfKind(ops, (kind) => kind !== "-");
	const oldOp = ops[oldLast];
	if (oldOp !== void 0 && oldOp.kind === "=" && beforeNoEol && !(oldLast === newLast && afterNoEol)) {
		ops.splice(oldLast, 1, {
			kind: "-",
			text: oldOp.text
		}, {
			kind: "+",
			text: oldOp.text
		});
		return;
	}
	const newOp = ops[newLast];
	if (newOp !== void 0 && newOp.kind === "=" && afterNoEol && !(newLast === oldLast && beforeNoEol)) ops.splice(newLast, 1, {
		kind: "-",
		text: newOp.text
	}, {
		kind: "+",
		text: newOp.text
	});
}
/** Group an edit script into hunks of `context` lines around each change. */
function buildHunks(ops, context, beforeNoEol, afterNoEol) {
	/** Old-side line number just before op `i`. */
	const oldBefore = new Array(ops.length + 1).fill(0);
	/** New-side line number just before op `i`. */
	const newBefore = new Array(ops.length + 1).fill(0);
	let oldCount = 0;
	let newCount = 0;
	for (let index = 0; index < ops.length; index += 1) {
		oldBefore[index] = oldCount;
		newBefore[index] = newCount;
		const kind = ops[index]?.kind;
		if (kind !== "+") oldCount += 1;
		if (kind !== "-") newCount += 1;
	}
	oldBefore[ops.length] = oldCount;
	newBefore[ops.length] = newCount;
	const changes = [];
	for (let index = 0; index < ops.length; index += 1) if (ops[index]?.kind !== "=") changes.push(index);
	if (changes.length === 0) return {
		hunks: [],
		added: 0,
		deleted: 0
	};
	const groups = [];
	let groupStart = changes[0] ?? 0;
	let groupEnd = groupStart;
	for (let index = 1; index < changes.length; index += 1) {
		const next = changes[index] ?? groupEnd;
		if (next - groupEnd - 1 <= 2 * context) {
			groupEnd = next;
			continue;
		}
		groups.push([groupStart, groupEnd]);
		groupStart = next;
		groupEnd = next;
	}
	groups.push([groupStart, groupEnd]);
	const lastOldOp = lastIndexOfKind(ops, (kind) => kind !== "+");
	const lastNewOp = lastIndexOfKind(ops, (kind) => kind !== "-");
	const hunks = [];
	let added = 0;
	let deleted = 0;
	for (const [from, to] of groups) {
		const start = Math.max(0, from - context);
		const end = Math.min(ops.length - 1, to + context);
		const oldStartIndex = oldBefore[start] ?? 0;
		const newStartIndex = newBefore[start] ?? 0;
		const oldLines = (oldBefore[end + 1] ?? 0) - oldStartIndex;
		const newLines = (newBefore[end + 1] ?? 0) - newStartIndex;
		const lines = [];
		for (let index = start; index <= end; index += 1) {
			const op = ops[index];
			if (op === void 0) continue;
			lines.push((op.kind === "=" ? " " : op.kind) + op.text);
			if (op.kind === "+") added += 1;
			if (op.kind === "-") deleted += 1;
		}
		const hunk = {
			oldStart: oldLines === 0 ? oldStartIndex : oldStartIndex + 1,
			oldLines,
			newStart: newLines === 0 ? newStartIndex : newStartIndex + 1,
			newLines,
			lines
		};
		if (beforeNoEol && lastOldOp >= start && lastOldOp <= end) hunk.oldNoEol = true;
		if (afterNoEol && lastNewOp >= start && lastNewOp <= end) hunk.newNoEol = true;
		hunks.push(hunk);
	}
	return {
		hunks,
		added,
		deleted
	};
}
/** Index of the last op satisfying `predicate`, or -1. */
function lastIndexOfKind(ops, predicate) {
	for (let index = ops.length - 1; index >= 0; index -= 1) {
		const kind = ops[index]?.kind;
		if (kind !== void 0 && predicate(kind)) return index;
	}
	return -1;
}
/**
* Serialize one hunk as a patch `git apply` accepts (and `git apply -R` undoes).
*
* The `@@ -a,b +c,d @@` counts are always written out — git accepts the elided
* `,1` and `,-0` spellings, but a reviewer reading a log is better served by the
* explicit form, and one spelling means one code path to test.
*
* @param displayPath - repo-relative path, as the panel shows it.
* @param hunk - one hunk of {@link diffText}.
*/
function hunkPatch(displayPath, hunk) {
	const out = [
		`--- a/${displayPath}`,
		`+++ b/${displayPath}`,
		`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
	];
	const markers = /* @__PURE__ */ new Set();
	if (hunk.oldNoEol === true) {
		const at = lastLineOfSide(hunk.lines, "-");
		if (at >= 0) markers.add(at);
	}
	if (hunk.newNoEol === true) {
		const at = lastLineOfSide(hunk.lines, "+");
		if (at >= 0) markers.add(at);
	}
	for (let index = 0; index < hunk.lines.length; index += 1) {
		out.push(hunk.lines[index] ?? "");
		if (markers.has(index)) out.push("\\ No newline at end of file");
	}
	return `${out.join("\n")}\n`;
}
/**
* Index of the last line in `lines` that belongs to the old side (`tag` is `'-'`)
* or the new side (`tag` is `'+'`); context lines belong to both.
*/
function lastLineOfSide(lines, tag) {
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const head = lines[index]?.charAt(0);
		if (head === " " || head === tag) return index;
	}
	return -1;
}
/**
* Serialize a WHOLE file comparison as ONE patch (one header, every hunk).
*
* "Revert everything this session did to this file" is `git apply -R` of the
* file's complete diff, and that is a single write instead of one write per
* hunk. Concatenating `hunkPatch` output would also apply (git tolerates the
* repeated headers and re-anchors each block by offset), but it says the same
* file begins twice and depends on offset guessing — a real unified diff names
* the file once and lets git place every hunk against one picture.
*
* Verified against git 2.x: the result reverse-applies to a file whose content
* is `hunks`' new side, and leaves it byte-identical to the old side.
*
* @param displayPath - repo-relative path, as the panel shows it.
* @param hunks - every hunk of the comparison, in ascending order.
* @returns the patch, or '' when there is nothing to write (no hunks).
*/
function filePatch(displayPath, hunks) {
	if (hunks.length === 0) return "";
	const out = [`--- a/${displayPath}`, `+++ b/${displayPath}`];
	for (const hunk of hunks) {
		out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
		const markers = /* @__PURE__ */ new Set();
		if (hunk.oldNoEol === true) {
			const at = lastLineOfSide(hunk.lines, "-");
			if (at >= 0) markers.add(at);
		}
		if (hunk.newNoEol === true) {
			const at = lastLineOfSide(hunk.lines, "+");
			if (at >= 0) markers.add(at);
		}
		for (let index = 0; index < hunk.lines.length; index += 1) {
			out.push(hunk.lines[index] ?? "");
			if (markers.has(index)) out.push("\\ No newline at end of file");
		}
	}
	return `${out.join("\n")}\n`;
}
//#endregion
//#region src/changes/recorder.ts
/**
* Map a scan entry onto the panel's vocabulary.
*
* `?` means "git does not track this path yet", which for a review panel is
* exactly a new file — the same thing `A` says for a staged addition.
*/
function panelStatus(status) {
	return status === "?" ? "A" : status;
}
/** Text of one read result, with "nothing usable transferred" folded into null. */
function turnSideOf(read) {
	const binary = read.binary === true;
	const truncated = read.truncated === true;
	return {
		text: read.absent || binary || truncated ? null : read.text,
		binary,
		truncated,
		known: !binary && !truncated
	};
}
/** Grace added to an exec budget before the watchdog gives up on it. */
const WATCHDOG_GRACE_MS = 5e3;
/** Sentinel for "the host call never came back". */
const WATCHDOG_FIRED = "watchdog-fired";
/**
* Per-file budget for the ONE read a click asks for (`diff`).
*
* A scan compares hundreds of paths and stays at 256 KiB; a single file the user
* asked to review is a different trade — 2 MiB is enough for the large sources
* a monorepo carries while keeping the base64 reply (≈2.7 MB) inside what one
* exec comfortably returns.
*/
const DIFF_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** The single-file read budget, as `readPaths` wants it. */
const DIFF_LIMITS = {
	perFile: DIFF_MAX_FILE_BYTES,
	total: DIFF_MAX_FILE_BYTES
};
/**
* Budget for ONE completed turn's **per-file hunks and reverse patches**.
*
* What it counts (and what it deliberately does NOT): the sum of every served
* file patch plus the hunk line bodies. The two FULL texts per record (`before`
* and `after`) and the `turnAfter` snapshot are not counted — they are what the
* staleness proof compares against, and they are already bounded by the scan
* caps (≲256 KiB/file, 8 MiB/turn for `after` plus the same order for `before`
* and the snapshot). So the real resident cost is this budget PLUS those texts
* (worst case ≈ 16 MiB + 4 MiB per active session), which is why the copy says
* "patches and hunk text" rather than "the turn's contents".
*
* The turn view must keep a comparison per changed file until the next turn
* closes (that is what `turnDiff` serves without re-reading the remote). 4 MiB
* fits a large refactor's patches; crossing it disables per-turn hunks for the
* session (see {@link Ledger.turnDisabled}) rather than thrashing the budget.
*/
const MAX_TURN_PATCH_BYTES = 4 * 1024 * 1024;
/**
* Bounds of the self-heal window (see {@link selfHealMaxAge}).
*
* The floor is a measured small repository: `git status -uno` answers in ~0.1s
* there, so 5s of staleness is already a large win over the old flat 30s — and
* the probe has been observed to take 30–60s to surface a manual edit when only
* the turn boundary and the 3/15/30s client polls apply.
*
* The ceiling is the OLD fixed value on purpose: it is what keeps the panel from
* turning into a status loop on a huge checkout (the reference monorepo answers
* in ~1.7s, i.e. a 6.8s window — still 4x its own cost, never lower for bigger
* trees).
*/
const SELF_HEAL_MIN_MS = 5e3;
const SELF_HEAL_MAX_MS = 3e4;
/**
* How many scan durations the panel may wait before re-scanning.
*
* Self-heal is a POLL backstop, not a live watch: waiting the cost of about four
* `git status -uno` runs keeps the added load proportional to what the probe can
* afford, instead of one scan per client poll.
*/
const SELF_HEAL_FACTOR = 4;
/**
* How stale the ledger may get before a *poll* re-scans it.
*
* Self-tuning: the host has no idea whether this session sits in a 50-file
* repository or a monorepo, and the same 30s window is either 300x the scan cost
* (small tree: the user waits half a minute to see a manual edit) or about right
* (AOSP: still 17x). Four times the LAST tracked scan, clamped to
* [{@link SELF_HEAL_MIN_MS}, {@link SELF_HEAL_MAX_MS}].
*
* An unknown / failed measurement falls back to the old ceiling, so a Host that
* has not scanned anything yet behaves exactly as before.
*
* @param scanMs - Duration of the last successful tracked scan, in ms.
*/
function selfHealMaxAge(scanMs) {
	if (scanMs === void 0 || !Number.isFinite(scanMs) || scanMs < 0) return SELF_HEAL_MAX_MS;
	const scaled = Math.round(scanMs * SELF_HEAL_FACTOR);
	return Math.min(SELF_HEAL_MAX_MS, Math.max(SELF_HEAL_MIN_MS, scaled));
}
/** POSIX join — `node:path` would apply Windows semantics on the host. */
function posixJoin(base, rel) {
	if (rel.startsWith("/")) return rel;
	const left = base.endsWith("/") ? base.slice(0, -1) : base;
	const right = rel.startsWith("./") ? rel.slice(2) : rel;
	return right === "" ? left : `${left}/${right}`;
}
/** The inverse of {@link posixJoin} for a path under `root`; '' when it is not. */
function displayUnder(root, path) {
	const base = root.endsWith("/") ? root : `${root}/`;
	return path.startsWith(base) ? path.slice(base.length) : "";
}
/**
* Whether two reads prove the file did not move between them.
*
* The last resort for a path whose bytes never crossed the wire (over the size
* cap, or binary): mtime and size are all that is left, and requiring BOTH keeps
* the claim honest. mtime has one-second resolution, so an edit inside the same
* second as the read is invisible here — which is why this is only ever used
* where a content comparison is impossible.
*/
function sameStat(before, after) {
	if (before === void 0 || after === void 0) return false;
	if (before.mtime === void 0 || after.mtime === void 0) return false;
	if (before.size === void 0 || after.size === void 0) return false;
	return before.mtime === after.mtime && before.size === after.size;
}
var SessionChanges = class {
	ledgers = /* @__PURE__ */ new Map();
	deps;
	disposed = false;
	constructor(deps) {
		this.deps = deps;
	}
	/** Open (or reuse) the ledger for one session at the start of a turn. */
	beginTurn(target) {
		if (this.disposed) return;
		const ledger = this.ensure(target);
		if (ledger === void 0) return;
		if (!ledger.baselineTaken) this.schedule(ledger);
	}
	/** Refresh the ledger at the end of a turn. */
	endTurn(target, turn) {
		if (this.disposed) return;
		const ledger = this.ensure(target);
		if (ledger === void 0) return;
		const advanced = turn > ledger.turn;
		ledger.turn = Math.max(ledger.turn, turn);
		if (advanced) ledger.pendingClose = turn;
		this.schedule(ledger);
	}
	/** The current summary for one session, or null when it has no ledger. */
	summary(sessionId) {
		const ledger = this.ledgers.get(sessionId);
		if (ledger === void 0) return null;
		const unavailable = ledger.unavailable ?? (ledger.untrackedFailure === void 0 ? void 0 : `new-file scan unavailable: ${ledger.untrackedFailure} (use the refresh button to retry)`);
		const excludedDirs = this.excludedDirs();
		return {
			alias: ledger.alias,
			root: ledger.root,
			turn: ledger.turn,
			files: ledger.files,
			added: ledger.added,
			deleted: ledger.deleted,
			at: ledger.at,
			...excludedDirs.length === 0 ? {} : { excludedDirs },
			pending: ledger.untrackedJob !== void 0 || ledger.pending && ledger.files.length > 0,
			...ledger.truncated === true ? { truncated: true } : {},
			...unavailable === void 0 ? {} : { unavailable },
			...ledger.turnDelta === void 0 ? {} : { turnView: {
				turn: ledger.turnDelta.turn,
				files: ledger.turnDelta.files,
				added: ledger.turnDelta.added,
				deleted: ledger.turnDelta.deleted,
				at: ledger.turnDelta.at,
				cached: ledger.turnDelta.cached,
				...ledger.turnDelta.reason === void 0 ? {} : { reason: ledger.turnDelta.reason },
				...ledger.turnDelta.truncated === true ? { truncated: true } : {},
				...ledger.turnDelta.provisional ? { pending: true } : {}
			} }
		};
	}
	/**
	* Compare one listed file across the whole session.
	*
	* The `before` side comes from the session baseline, which never moves. The
	* `after` side is read from the host on every call rather than replayed from
	* the last scan: a revert, a save from the editor or a shell command all
	* change the file between scans, and replaying a cached copy against a fresh
	* buffer is exactly how the painted lines end up at the wrong places.
	*
	* This is the ONE read a user asks for by clicking a row, so it is allowed a
	* larger per-file budget than a scan (`DIFF_MAX_FILE_BYTES`): a file the list
	* had to withhold as "too large" can still be reviewed and reverted here,
	* while a scan stays cheap. A withheld HEAD side is retaken at that budget
	* (git has the bytes); a withheld BASELINE side is not — that snapshot
	* described the session's own starting point and cannot be reconstructed, so
	* the file stays display-only rather than guessing a wrong reverse.
	*
	* @param sessionId - live session owning the ledger.
	* @param path - the file's remote absolute path (as listed in the summary).
	* @returns hunks for decorations, or null when the session/file is unknown.
	*/
	async diff(sessionId, path) {
		const ledger = this.ledgers.get(sessionId);
		if (ledger === void 0) return null;
		const record = ledger.records.get(path);
		if (record === void 0) return null;
		const status = record.status;
		let afterText = record.after;
		let binary = record.binary;
		let truncated = record.truncated;
		const fresh = await this.readPaths(ledger, [record.display], "worktree", DIFF_LIMITS);
		if (ledger.disposed) return null;
		const side = fresh.get(record.display);
		if (side !== void 0) {
			binary = side.binary;
			truncated = side.truncated;
			afterText = side.absent ? null : side.text;
			if (afterText === null && !side.absent && !side.binary) afterText = record.after;
		}
		if (binary) return {
			kind: "binary",
			path,
			display: record.display,
			hunks: [],
			...status === void 0 ? {} : { status }
		};
		let beforeText = record.before;
		if (beforeText === null && record.beforeFrom === "head") {
			const head = await this.readPaths(ledger, [record.display], "head", DIFF_LIMITS);
			if (ledger.disposed) return null;
			beforeText = head.get(record.display)?.text ?? null;
		}
		const result = diffText(beforeText ?? "", afterText ?? "");
		/**
		* The reverse patch exists only when the comparison is complete and has an
		* old side. A whole-file creation has no old side: its reverse is "delete the
		* file", which a patch cannot express (the client uses
		* `RemoteChangedFile.revert` for that case instead). Withheld bytes are not
		* evidence either, so a truncated after side gets no patch — the client's
		* undo path then refuses (`changes.undoMissing`) instead of guessing.
		*/
		const reverse = beforeText !== null && !truncated ? filePatch(record.display, result.hunks) : "";
		const hunks = result.hunks.map((hunk) => ({
			oldStart: hunk.oldStart,
			oldCount: hunk.oldLines,
			newStart: hunk.newStart,
			newCount: hunk.newLines,
			heading: "",
			lines: hunk.lines,
			patch: reverse === "" ? "" : hunkPatch(record.display, hunk)
		}));
		if (hunks.length === 0) {
			/**
			* Both sides were READ and compared, so "no hunks" means the file is back
			* at its session baseline (the change was reverted, or an identical byte
			* round-trip). That is NOT "missing": the panel shows `missing` as "the
			* remote cannot read this file", and saying that about a file the host
			* just read is a lie that also hides "your change is gone". A withheld
			* side (null) keeps `missing` — there is genuinely nothing to compare.
			*/
			/**
			* 判定只看**改后那一侧读到了**：新建的空文件 before 是 null（不存在），after
			* 读到 `''`，零 hunk 是"读到了、只是没有内容"，不是"读不到"。老条件要求两侧
			* 都非 null，于是会话新建的空文件被报成 `missing`，面板显示「远端读不到」
			* （审核 NIT-1）。
			*/
			if (afterText !== null) return {
				kind: "text",
				path,
				display: record.display,
				hunks: [],
				...status === void 0 ? {} : { status }
			};
			return {
				kind: "missing",
				path,
				display: record.display,
				hunks: [],
				...status === void 0 ? {} : { status }
			};
		}
		return {
			kind: "text",
			path,
			display: record.display,
			hunks,
			...reverse === "" ? {} : { patch: reverse },
			...status === void 0 ? {} : { status },
			...truncated ? { truncated: true } : {}
		};
	}
	/**
	* One file's comparison for the most recent COMPLETED turn.
	*
	* Same shape as {@link diff} (the editor paints both the same way), but the
	* "before" side is the previous turn's close instead of the session baseline.
	* The hunks are served from the turn delta's cache, so this call costs NO
	* remote work in the common case — but a cached comparison is only worth
	* showing while it still describes the disk. That is why the `after` side is
	* read back here and compared with the cached text FIRST: if the file moved on
	* after the turn closed (a later save, a terminal command, an agent), the
	* answer is `stale` and the client falls back to the session view instead of
	* painting line numbers that no longer exist.
	*
	* @param sessionId - live session owning the ledger.
	* @param path - the file's remote absolute path (as listed in `turnView.files`).
	* @returns hunks for decorations, `unavailable`/`stale` with a reason, or null
	*   when the session itself is unknown.
	*/
	async turnDiff(sessionId, path) {
		const ledger = this.ledgers.get(sessionId);
		if (ledger === void 0) return null;
		const delta = ledger.turnDelta;
		const display = delta?.records.get(path)?.display ?? displayUnder(ledger.root, path);
		if (delta === void 0) return {
			kind: "unavailable",
			path,
			display,
			hunks: [],
			reason: "no turn has closed since this session started"
		};
		if (!delta.cached) return {
			kind: "unavailable",
			path,
			display,
			hunks: [],
			reason: delta.reason ?? "per-turn change contents are not cached for this session"
		};
		const record = delta.records.get(path);
		if (record === void 0) return {
			kind: "unavailable",
			path,
			display,
			hunks: [],
			reason: `this file is not part of turn ${delta.turn}'s change set`
		};
		const status = record.status;
		if (record.binary) return {
			kind: "binary",
			path,
			display: record.display,
			hunks: [],
			...status === void 0 ? {} : { status }
		};
		if (record.oversized) return {
			kind: "unavailable",
			path,
			display: record.display,
			hunks: [],
			reason: "the bytes of this file were withheld by the size cap, so there is no line-level comparison",
			...status === void 0 ? {} : { status }
		};
		/**
		* Verify the cache against the disk before serving it.
		*
		* A failed read is NOT "unchanged": without evidence the honest answer is
		* `unavailable` (no palatable guess). A binary or cap-truncated read proves
		* the bytes moved on after the turn closed, which is exactly `stale`.
		*/
		const fresh = await this.readPaths(ledger, [record.display], "worktree", DIFF_LIMITS);
		if (ledger.disposed) return null;
		const side = fresh.get(record.display);
		if (side === void 0) return {
			kind: "unavailable",
			path,
			display: record.display,
			hunks: [],
			reason: "the file could not be read back from the host, so the turn comparison cannot be verified",
			...status === void 0 ? {} : { status }
		};
		const current = turnSideOf(side);
		if (current.binary || current.truncated) return {
			kind: "stale",
			path,
			display: record.display,
			hunks: [],
			reason: current.binary ? "the file has become binary since the turn closed" : "the file has grown past the read budget since the turn closed",
			...status === void 0 ? {} : { status }
		};
		if (current.text !== record.after) return {
			kind: "stale",
			path,
			display: record.display,
			hunks: [],
			reason: "the file was modified after the turn closed",
			...status === void 0 ? {} : { status }
		};
		const hunks = record.hunks.map((hunk) => ({
			oldStart: hunk.oldStart,
			oldCount: hunk.oldLines,
			newStart: hunk.newStart,
			newCount: hunk.newLines,
			heading: "",
			lines: hunk.lines,
			patch: record.filePatch === "" ? "" : hunkPatch(record.display, hunk)
		}));
		return {
			kind: "text",
			path,
			display: record.display,
			hunks,
			...record.filePatch === "" ? {} : { patch: record.filePatch },
			...status === void 0 ? {} : { status }
		};
	}
	/** Resolve once every queued refresh has settled, including coalesced work. */
	async settled() {
		for (let guard = 0; guard < 100; guard += 1) {
			await Promise.all([...this.ledgers.values()].map((ledger) => ledger.queue));
			const jobs = [...this.ledgers.values()].map((ledger) => ledger.untrackedJob).filter((job) => job !== void 0);
			if (jobs.length > 0) await Promise.all(jobs);
			if (![...this.ledgers.values()].some((ledger) => ledger.pending || ledger.untrackedJob !== void 0)) return;
		}
	}
	/** Drop one session's ledger. */
	forget(sessionId) {
		const ledger = this.ledgers.get(sessionId);
		if (ledger === void 0) return;
		this.ledgers.delete(sessionId);
		ledger.disposed = true;
	}
	/** Release every ledger (plugin unmount). */
	dispose() {
		this.disposed = true;
		for (const sessionId of [...this.ledgers.keys()]) this.forget(sessionId);
	}
	/**
	* Force a fresh pass, ignoring the untracked cadence.
	*
	* The panel's refresh button calls this: the cadence exists so a slow scan
	* does not run on every turn, but "I clicked refresh" means the user wants
	* the truth now — including files that appeared seconds ago.
	*/
	rescan(sessionId) {
		const ledger = this.ledgers.get(sessionId);
		if (ledger === void 0 || ledger.disposed) return;
		if (ledger.untrackedGivenUp) {
			ledger.untrackedGivenUp = false;
			this.warn("manual refresh re-arms the untracked scan for this session");
		}
		ledger.untrackedAt = 0;
		ledger.untrackedMs = void 0;
		this.schedule(ledger);
	}
	/**
	* Self-heal a ledger whose data has gone stale.
	*
	* The panel polls `list`, and a poll is the one moment we know a human is
	* looking at the answer. If the data is older than the window, re-scan — so a
	* turn boundary this Host never delivered costs a few seconds of staleness
	* instead of a manual refresh.
	*
	* The window is ADAPTIVE ({@link selfHealMaxAge}): four times the last tracked
	* scan, clamped to 5–30s. A small repository therefore surfaces a manual edit
	* (one with no turn event behind it) within seconds instead of the old fixed
	* half minute, while a monorepo keeps the old ceiling. The two `false` paths —
	* a scan already running, and data that is still fresh — are unchanged.
	*
	* @param maxAgeMs - explicit window; callers that know better (and the checks)
	*   override the adaptive default and keep the old semantics exactly.
	* @returns whether a refresh was queued.
	*/
	touch(sessionId, maxAgeMs) {
		const ledger = this.ledgers.get(sessionId);
		if (ledger === void 0 || ledger.disposed || ledger.pending) return false;
		const windowMs = maxAgeMs ?? selfHealMaxAge(ledger.scanMs);
		if (ledger.at > 0 && Date.now() - ledger.at < windowMs) return false;
		this.schedule(ledger);
		return true;
	}
	/**
	* Point one ledger at a subdirectory of the session root.
	*
	* This is the Source Control panel's "repository directory": an explicit
	* choice by the user, and therefore the authority whenever it is set. The
	* automatic one-level probe is only a fallback for a container workspace that
	* holds exactly one repository.
	*
	* @param subdir - workspace-relative directory, or undefined for the session
	*   root itself. Absolute paths and `..` are refused: they would move the
	*   ledger outside the workspace it was created for.
	*/
	useRepoSubdir(sessionId, subdir) {
		const ledger = this.ledgers.get(sessionId);
		if (ledger === void 0 || ledger.disposed) return;
		const clean = normalizeRepoSubdir(subdir);
		if (clean === ledger.subdir) return;
		ledger.subdir = clean;
		ledger.root = clean === "" ? ledger.baseRoot : `${ledger.baseRoot}/${clean}`;
		this.resetObservation(ledger);
		this.schedule(ledger);
	}
	/**
	* Forget everything observed against the ledger's previous root.
	*
	* The root is the subject of every fact this ledger holds: the baseline
	* describes that tree, both scans name paths relative to it, and the flags
	* that gate them (`absorbed`, `untrackedGivenUp`) are verdicts about that
	* repository. Moving the root therefore makes the whole observation set
	* meaningless at once — resetting only the ones a caller happened to remember
	* is how the first cut of `useRepoSubdir` forgot `untracked` and `absorbed`,
	* which announced the newly selected repository's PRE-EXISTING untracked
	* files as this session's work (full-file additions, revertible — and a
	* revert of an untracked file destroys a copy git never had).
	*
	* One entry point on purpose: a field added later belongs here by default,
	* instead of needing every root-move path to be found again.
	*/
	resetObservation(ledger) {
		ledger.baseline = void 0;
		ledger.baselineTaken = false;
		ledger.absorbed = false;
		ledger.adoptedSubdir = false;
		ledger.tracked = [];
		ledger.untracked = void 0;
		ledger.untrackedAt = 0;
		ledger.untrackedMs = void 0;
		ledger.scanMs = void 0;
		ledger.untrackedGivenUp = false;
		ledger.untrackedFailure = void 0;
		ledger.files = [];
		ledger.records = /* @__PURE__ */ new Map();
		ledger.added = 0;
		ledger.deleted = 0;
		ledger.truncated = void 0;
		ledger.at = 0;
		ledger.unavailable = void 0;
		ledger.startedAt = Date.now();
		ledger.pendingClose = void 0;
		ledger.turnAfter = void 0;
		ledger.turnAfterTruncated = false;
		ledger.turnDelta = void 0;
		ledger.turnBefore = void 0;
		ledger.turnBeforeTruncated = false;
		ledger.turnProvisional = false;
	}
	/**
	* Resolve (or rebind) the ledger for one session from its CURRENT cwd.
	*
	* The cwd is re-resolved on every turn boundary instead of once per session: a
	* session can change its working directory mid-conversation (a workspace
	* switch, `working-directory.set`), and a ledger pinned to the first binding
	* then keeps answering "what did this session change" about a tree the session
	* is no longer working in — and points file-open and undo at it.
	*
	* Rebinding happens IN PLACE rather than forget+create: the panel keeps its
	* identity and `turn` counter (no null-summary flicker) and one
	* `resetObservation()` drops every fact that belonged to the previous root, so
	* the field list stays in that one method. C1's root-snapshot guards in
	* `refresh`/`publish`/`kickUntracked`/`absorbPreExisting` are exactly what makes
	* this safe while a scan of the old root is still in flight.
	*/
	ensure(target) {
		if (target.cwd.trim() === "") return void 0;
		let route;
		try {
			route = this.deps.worlds.routeDir(target.cwd);
		} catch {
			this.forget(target.sessionId);
			return;
		}
		if (route.kind !== "remote") {
			this.forget(target.sessionId);
			return;
		}
		const root = route.remotePath.length > 1 && route.remotePath.endsWith("/") ? route.remotePath.replace(/\/+$/, "") : route.remotePath;
		const existing = this.ledgers.get(target.sessionId);
		if (existing !== void 0 && !existing.disposed && existing.root !== "") {
			existing.cwd = target.cwd;
			if (existing.routeId === route.id) return existing;
			this.warn(`session working directory moved to ${route.alias}:${root}; re-observing the new binding`);
			existing.routeId = route.id;
			existing.alias = route.alias;
			existing.baseRoot = root;
			existing.subdir = "";
			existing.root = root;
			this.resetObservation(existing);
			return existing;
		}
		const ledger = {
			sessionId: target.sessionId,
			cwd: target.cwd,
			routeId: route.id,
			alias: route.alias,
			root,
			baseline: void 0,
			baselineTaken: false,
			untrackedGivenUp: false,
			untrackedFailure: void 0,
			startedAt: Date.now(),
			absorbed: false,
			adoptedSubdir: false,
			baseRoot: root,
			subdir: "",
			tracked: [],
			untracked: void 0,
			untrackedAt: 0,
			untrackedMs: void 0,
			scanMs: void 0,
			untrackedJob: void 0,
			turn: 0,
			files: [],
			records: /* @__PURE__ */ new Map(),
			added: 0,
			deleted: 0,
			truncated: void 0,
			at: 0,
			unavailable: void 0,
			pending: false,
			queue: Promise.resolve(),
			dirty: false,
			pendingClose: void 0,
			turnAfter: void 0,
			turnAfterTruncated: false,
			turnDelta: void 0,
			turnBefore: void 0,
			turnBeforeTruncated: false,
			turnProvisional: false,
			turnDisabled: void 0,
			publishSeq: 0,
			disposed: false
		};
		this.ledgers.set(target.sessionId, ledger);
		return ledger;
	}
	/** Queue a refresh, coalescing bursts (a turn can end while one is running). */
	schedule(ledger) {
		if (ledger.disposed) return;
		if (ledger.pending) {
			ledger.dirty = true;
			return;
		}
		ledger.pending = true;
		ledger.queue = ledger.queue.then(() => this.refresh(ledger)).catch((error) => this.warn(`refresh failed: ${messageOf(error)}`)).finally(() => {
			ledger.pending = false;
			if (ledger.dirty && !ledger.disposed) {
				ledger.dirty = false;
				this.schedule(ledger);
			}
		});
	}
	/**
	* One refresh: the cheap scan first, then the slow one in the background.
	*
	* The split is not cosmetic. On the reference monorepo `git status -uno`
	* answers in ~3s while `git ls-files --others` needs over a minute, so a
	* single sequential refresh would leave the panel empty for that whole
	* minute even though the tracked changes were known after three seconds.
	* Phase one publishes, phase two adds the new files when (and if) it lands.
	*/
	async refresh(ledger) {
		if (ledger.disposed || ledger.root === "") return;
		const scanStartedAt = Date.now();
		const scanned = await this.scanTracked(ledger);
		if (ledger.disposed || scanned === void 0) return;
		if (ledger.root !== scanned.root) return;
		ledger.scanMs = Math.max(0, Date.now() - scanStartedAt);
		ledger.tracked = scanned.entries;
		await this.publish(ledger);
		this.kickUntracked(ledger);
	}
	/**
	* Recompute the panel's list from the scans currently known.
	*
	* @param fromSlowScan - this publish was triggered by the `git ls-files
	*   --others` walk. A turn delta closed before that walk landed is still
	*   provisional: this flag is what lets it be re-derived once the turn's new
	*   files are known (see `correctTurn`).
	*/
	async publish(ledger, fromSlowScan = false) {
		if (ledger.disposed) return;
		const seq = ++ledger.publishSeq;
		const root = ledger.root;
		const merged = /* @__PURE__ */ new Map();
		for (const entry of ledger.tracked) merged.set(entry.path, entry);
		for (const entry of ledger.untracked ?? []) if (!merged.has(entry.path)) merged.set(entry.path, entry);
		const entries = [...merged.values()].sort((left, right) => left.path.localeCompare(right.path));
		const cap = this.deps.maxFiles ?? 500;
		const listed = entries.slice(0, cap);
		const truncated = entries.length > cap;
		if (!ledger.baselineTaken) {
			const first = await this.readPaths(ledger, listed.map((entry) => entry.path), "worktree");
			if (ledger.disposed || ledger.root !== root) return;
			if (ledger.publishSeq !== seq) return;
			ledger.baseline = first;
			ledger.baselineTaken = true;
			ledger.files = [];
			ledger.records = /* @__PURE__ */ new Map();
			ledger.added = 0;
			ledger.deleted = 0;
			ledger.truncated = truncated ? true : void 0;
			ledger.at = Date.now();
			return;
		}
		const baseline = ledger.baseline ?? /* @__PURE__ */ new Map();
		const fromHead = listed.filter((entry) => !baseline.has(entry.path)).map((entry) => entry.path);
		const head = fromHead.length === 0 ? /* @__PURE__ */ new Map() : await this.readPaths(ledger, fromHead, "head");
		const after = await this.readPaths(ledger, listed.map((entry) => entry.path), "worktree");
		if (ledger.disposed || ledger.root !== root) return;
		const records = /* @__PURE__ */ new Map();
		const files = [];
		let added = 0;
		let deleted = 0;
		for (const entry of listed) {
			const fromBaseline = baseline.get(entry.path);
			const fromHead = head.get(entry.path);
			const beforeSide = fromBaseline ?? fromHead;
			const afterSide = after.get(entry.path);
			const before = beforeSide?.text ?? null;
			const afterText = afterSide?.text ?? null;
			const binary = beforeSide?.binary === true || afterSide?.binary === true;
			const fileTruncated = beforeSide?.truncated === true || afterSide?.truncated === true;
			if (beforeSide?.absent === true && afterSide?.absent === true) continue;
			if (!binary && !fileTruncated && before === afterText) continue;
			if ((binary || fileTruncated) && sameStat(beforeSide, afterSide)) continue;
			const oversized = fileTruncated && !binary;
			const revert = !binary && !oversized && beforeSide !== void 0 && !(before === null) ? "patch" : entry.status === "A" ? "delete" : void 0;
			const diff = binary || oversized ? {
				added: 0,
				deleted: 0
			} : diffText(before ?? "", afterText ?? "");
			const status = panelStatus(entry.status);
			const absolute = posixJoin(ledger.root, entry.path);
			records.set(absolute, {
				display: entry.path,
				path: absolute,
				status,
				before,
				after: afterText,
				binary,
				truncated: fileTruncated,
				beforeFrom: fromBaseline !== void 0 ? "baseline" : fromHead !== void 0 ? "head" : "none"
			});
			added += diff.added;
			deleted += diff.deleted;
			files.push({
				path: absolute,
				display: entry.path,
				added: diff.added,
				deleted: diff.deleted,
				...binary ? { binary: true } : {},
				...oversized ? { oversized: true } : {},
				...status === void 0 ? {} : { status },
				...revert === void 0 ? {} : { revert }
			});
		}
		files.sort((left, right) => left.display.localeCompare(right.display));
		if (ledger.root !== root) return;
		if (ledger.publishSeq !== seq) return;
		ledger.records = records;
		ledger.files = files;
		ledger.added = added;
		ledger.deleted = deleted;
		ledger.truncated = truncated ? true : void 0;
		ledger.unavailable = listed.length > 0 && after.size === 0 ? "file contents could not be read from the host" : void 0;
		ledger.at = Date.now();
		if (ledger.pendingClose !== void 0) await this.closeTurn(ledger, root, seq, entries, listed, after, records, truncated);
		else if (fromSlowScan) await this.correctTurn(ledger, root, seq, entries, listed, after, records, truncated);
	}
	/**
	* Close one turn: compute "what did it change" and remember this close as the
	* next turn's starting point.
	*
	* The delta is defined against the PREVIOUS close, not the session baseline, so
	* a file the session changed in turn 1 and left alone in turn 2 must not appear
	* in turn 2's list — otherwise the view says the same work happened twice.
	* That is what `turnAfter` is for: it holds every listed path's text at the
	* moment the previous turn closed, and it is replaced (never merged) here.
	*
	* A failed `after` read leaves the boundary unconsumed, so the next publish
	* retries instead of recording a turn against "nothing".
	*/
	async closeTurn(ledger, root, seq, entries, listed, after, records, truncated) {
		const turn = ledger.pendingClose;
		if (turn === void 0 || ledger.disposed) return;
		ledger.pendingClose = void 0;
		if (ledger.turnDisabled !== void 0) return;
		const known = ledger.turnAfter;
		const collected = await this.collectTurnSides(ledger, root, seq, listed, after, known);
		if (collected.kind === "retry") {
			ledger.pendingClose = turn;
			return;
		}
		if (collected.kind === "superseded") return;
		/**
		* A previous snapshot cut by the file cap cannot prove that a path MISSING
		* from it was clean — it may simply have been past the cap. Entries that were
		* listed then are still exact, so only the "newcomer = changed this turn"
		* inference is dropped, and the view says it is partial (`truncated`).
		*/
		const partial = ledger.turnAfterTruncated;
		const previousUncorrected = ledger.turnProvisional;
		const built = this.buildTurnDelta(root, turn, collected.now, entries, records, known, partial, truncated);
		this.storeTurnDelta(ledger, built, previousUncorrected);
		if (built.overflow) return;
		ledger.turnBefore = known;
		ledger.turnBeforeTruncated = partial;
		ledger.turnProvisional = true;
		/**
		* This close becomes the next turn's starting point. Built from `listed`
		* ONLY: a path that left the dirty list is at its baseline, and the session
		* baseline is exactly what a re-appearance will be compared against — keeping
		* it here would cost a full re-read of every reverted file on every later
		* turn.
		*/
		ledger.turnAfter = this.turnSnapshotOf(listed, collected.now);
		ledger.turnAfterTruncated = truncated;
	}
	/**
	* Re-derive the CURRENT turn's delta once the slow scan behind it has landed.
	*
	* A turn's new files are discovered by `git ls-files --others`, which runs
	* after the tracked scan by design and can land seconds later. Rebuilding the
	* same turn from the SAME "before" snapshot (kept in `turnBefore`) is what
	* makes those files appear in the turn they belong to instead of in the next
	* one. Guarded against the two ways this could lie: a newer turn boundary
	* (which supersedes this delta) and a root move.
	*/
	async correctTurn(ledger, root, seq, entries, listed, after, records, truncated) {
		const delta = ledger.turnDelta;
		const before = ledger.turnBefore;
		if (!ledger.turnProvisional || delta === void 0) return;
		ledger.turnProvisional = false;
		if (ledger.turnDisabled !== void 0 || ledger.turn !== delta.turn) return;
		const collected = await this.collectTurnSides(ledger, root, seq, listed, after, before);
		if (collected.kind !== "ok") return;
		const partial = ledger.turnBeforeTruncated;
		const built = this.buildTurnDelta(root, delta.turn, collected.now, entries, records, before, partial, truncated);
		this.storeTurnDelta(ledger, built, false);
		if (built.overflow) return;
		const stored = ledger.turnDelta;
		if (stored !== void 0) stored.provisional = false;
		ledger.turnAfter = this.turnSnapshotOf(listed, collected.now);
	}
	/** Remember one close's sides for the next boundary (see `TurnSideText`). */
	turnSnapshotOf(listed, now) {
		const snapshot = /* @__PURE__ */ new Map();
		for (const entry of listed) {
			const side = now.get(entry.path);
			snapshot.set(entry.path, {
				text: side?.text ?? null,
				known: side?.known ?? false
			});
		}
		return snapshot;
	}
	/**
	* The "after" side of one turn close, in `display` space.
	*
	* Starts from the publish's own reads (every listed path), then reads the paths
	* the PREVIOUS close listed but this publish does not: those left the dirty
	* list (reverted to their baseline, deleted, restored), and without reading
	* them now the revert would be attributed to nobody — "the turn put the file
	* back" would look like "the turn changed nothing".
	*
	* @returns `ok` with the sides; `retry` when a read failed (the caller keeps
	*   the turn boundary for the next publish); `superseded` when a root move or
	*   a newer publish already owns the observation.
	*/
	async collectTurnSides(ledger, root, seq, listed, after, known) {
		if (listed.length > 0 && after.size === 0) return { kind: "retry" };
		const now = /* @__PURE__ */ new Map();
		for (const entry of listed) {
			const side = after.get(entry.path);
			if (side === void 0) return { kind: "retry" };
			now.set(entry.path, turnSideOf(side));
		}
		const vanished = known === void 0 ? [] : [...known.keys()].filter((display) => !now.has(display));
		if (vanished.length === 0) return {
			kind: "ok",
			now
		};
		const reads = await this.readPaths(ledger, vanished, "worktree");
		if (ledger.disposed) return { kind: "superseded" };
		if (ledger.root !== root || ledger.publishSeq !== seq) return { kind: "superseded" };
		if (reads.size === 0) return { kind: "retry" };
		for (const display of vanished) {
			const side = reads.get(display);
			if (side === void 0) return { kind: "retry" };
			now.set(display, turnSideOf(side));
		}
		return {
			kind: "ok",
			now
		};
	}
	/**
	* Compare one turn's before/after sides into panel rows plus cached hunks.
	*
	* The comparison rules are the ones the whole-session `publish` uses (binary
	* and cap-withheld bytes carry 0/0 counts, a creation has no reverse patch,
	* hunks come from the same Myers implementation), so a row means the same
	* thing in both views.
	*/
	buildTurnDelta(root, turn, now, entries, records, known, partial, capTruncated) {
		const statusOf = /* @__PURE__ */ new Map();
		for (const entry of entries) statusOf.set(entry.path, panelStatus(entry.status));
		const budget = this.deps.turnPatchBytes ?? MAX_TURN_PATCH_BYTES;
		const files = [];
		const turnRecords = /* @__PURE__ */ new Map();
		let added = 0;
		let deleted = 0;
		let bytes = 0;
		let incomplete = partial || capTruncated;
		for (const [display, side] of now) {
			const absolute = posixJoin(root, display);
			const record = records.get(absolute);
			const had = known !== void 0 && known.has(display);
			if (!had && (record === void 0 || partial)) continue;
			const previous = had ? known.get(display) : void 0;
			if (had && previous !== void 0 && previous.known === false) {
				incomplete = true;
				continue;
			}
			const before = had ? previous?.text ?? null : record?.before ?? null;
			if (had && before === side.text) continue;
			const binary = side.binary || record?.binary === true;
			const oversized = !binary && (side.truncated || record?.truncated === true);
			let fileAdded = 0;
			let fileDeleted = 0;
			let hunks = [];
			let patch = "";
			if (!binary && !oversized) {
				const result = diffText(before ?? "", side.text ?? "");
				fileAdded = result.added;
				fileDeleted = result.deleted;
				hunks = result.hunks;
				patch = before !== null && hunks.length > 0 ? filePatch(display, hunks) : "";
				if (patch !== "") bytes += Buffer.byteLength(patch, "utf8");
				for (const hunk of hunks) for (const line of hunk.lines) bytes += Buffer.byteLength(line, "utf8") + 1;
			}
			added += fileAdded;
			deleted += fileDeleted;
			const status = statusOf.get(display);
			const revert = patch === "" ? void 0 : "patch";
			files.push({
				path: absolute,
				display,
				added: fileAdded,
				deleted: fileDeleted,
				...binary ? { binary: true } : {},
				...oversized ? { oversized: true } : {},
				...status === void 0 ? {} : { status },
				...revert === void 0 ? {} : { revert }
			});
			turnRecords.set(absolute, {
				display,
				path: absolute,
				status,
				binary,
				oversized,
				hunks,
				before,
				after: side.text,
				filePatch: patch
			});
		}
		files.sort((left, right) => left.display.localeCompare(right.display));
		return {
			turn,
			files,
			added,
			deleted,
			records: turnRecords,
			bytes,
			overflow: bytes > budget,
			incomplete
		};
	}
	/**
	* Commit one built delta, degrading honestly when it blew the memory budget.
	*
	* Over budget the statistics are already computed and stay usable, but the
	* per-file hunks and patches are dropped and this session stops computing turn
	* views: keeping a half-filled snapshot would make the NEXT turn compare
	* against texts that belong to an older boundary.
	*/
	storeTurnDelta(ledger, built, uncorrectedPrevious) {
		const truncated = built.incomplete || uncorrectedPrevious;
		if (!built.overflow) {
			ledger.turnDelta = {
				turn: built.turn,
				files: built.files,
				added: built.added,
				deleted: built.deleted,
				at: Date.now(),
				cached: true,
				reason: void 0,
				truncated: truncated ? true : void 0,
				provisional: true,
				records: built.records,
				bytes: built.bytes
			};
			return;
		}
		const reason = `the per-turn patches and hunk text exceed the ${this.deps.turnPatchBytes ?? MAX_TURN_PATCH_BYTES} byte memory budget; turn totals stay available without per-file hunks`;
		ledger.turnDelta = {
			turn: built.turn,
			files: built.files.map((file) => {
				const { revert: _revert, ...rest } = file;
				return rest;
			}),
			added: built.added,
			deleted: built.deleted,
			at: Date.now(),
			cached: false,
			reason,
			truncated: truncated ? true : void 0,
			provisional: false,
			records: /* @__PURE__ */ new Map(),
			bytes: built.bytes
		};
		this.disableTurn(ledger, reason);
	}
	/** Stop computing turn views for this session, saying why (sticky). */
	disableTurn(ledger, reason) {
		if (ledger.turnDisabled !== void 0) return;
		ledger.turnDisabled = reason;
		ledger.turnAfter = void 0;
		ledger.turnAfterTruncated = false;
		ledger.turnBefore = void 0;
		ledger.turnBeforeTruncated = false;
		ledger.turnProvisional = false;
		this.warn(`per-turn view disabled: ${reason}`);
	}
	/**
	* The cheap scan: tracked files whose working-tree bytes differ from the
	* index (1.4s measured on the reference monorepo).
	*
	* A session working directory is often a CONTAINER for repositories rather
	* than one itself (a session root that holds another repository inside it),
	* and `git status` there answers exit 128 — "not a git
	* repository (or any parent up to mount point /)". When that happens the
	* ledger looks one level down once and adopts the repository it finds, which
	* is the same idea the SCM panel's `repoSubdir` expresses by hand.
	*
	* @returns the entries and the root they are relative to, or undefined when no
	*   repository could be found (the ledger then reports why).
	*/
	async scanTracked(ledger) {
		let root = ledger.root;
		const tracked = await this.run(ledger.alias, trackedStatusCommand(root));
		if (ledger.root !== root) return void 0;
		if (tracked.ok) {
			ledger.unavailable = void 0;
			return {
				root,
				entries: parseStatusZ(tracked.stdout)
			};
		}
		if (tracked.code === 90 && ledger.subdir !== "") {
			this.warn(`repository directory "${ledger.subdir}" is missing on the host; falling back to the session root`);
			ledger.subdir = "";
			ledger.root = ledger.baseRoot;
			this.resetObservation(ledger);
			root = ledger.root;
			const retry = await this.run(ledger.alias, trackedStatusCommand(root));
			if (retry.ok) {
				ledger.unavailable = void 0;
				return {
					root,
					entries: parseStatusZ(retry.stdout)
				};
			}
			ledger.unavailable = retry.reason;
			return;
		}
		if (!ledger.adoptedSubdir) {
			if (await this.adoptRepositoryBelow(ledger) !== void 0) {
				root = ledger.root;
				const retry = await this.run(ledger.alias, trackedStatusCommand(root));
				if (retry.ok) {
					ledger.unavailable = void 0;
					return {
						root,
						entries: parseStatusZ(retry.stdout)
					};
				}
				ledger.unavailable = retry.reason;
				return;
			}
		}
		ledger.unavailable = tracked.reason;
	}
	/**
	* Look for a repository in the session root's immediate subdirectories.
	*
	* **Only an unambiguous answer is adopted.** A workspace that holds several
	* repositories has no single right one, and silently picking the first would
	* report changes from a project the session never touched — worse than saying
	* "I don't know". The explicit repository directory the Source Control panel
	* stores is the real answer, and this fallback exists only to spare the user
	* from setting it when there is exactly one candidate.
	*
	* @returns the adopted root, or undefined when nothing (or too much) was found.
	*/
	async adoptRepositoryBelow(ledger) {
		ledger.adoptedSubdir = true;
		const probe = await this.run(ledger.alias, reposBelowCommand(ledger.root));
		if (!probe.ok) return void 0;
		const found = probe.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.includes("/") && line !== ".");
		if (found.length === 0) return void 0;
		if (found.length > 1) {
			ledger.unavailable = `no git repository at the workspace root, and ${found.length} candidates below it — set the repository directory in Source Control`;
			return;
		}
		const adopted = `${ledger.root}/${found[0]}`;
		this.resetObservation(ledger);
		ledger.root = adopted;
		ledger.adoptedSubdir = true;
		this.warn(`no repository at the session root; using ${ledger.root}`);
		return ledger.root;
	}
	/**
	* The slow scan: new files, in the background.
	*
	* The same command costs ~11s on a warm tree and over a minute on a cold one,
	* and on the reference AOSP monorepo it has been measured past 60s with no
	* answer at all. It therefore never runs inline with the tracked scan, never
	* runs twice at once, and only runs again after {@link untrackedCadence}. A
	* repository that cannot answer inside {@link untrackedBudget} is written off
	* for the session (`untrackedGivenUp`) rather than retried every turn.
	*/
	async kickUntracked(ledger) {
		if (ledger.disposed || ledger.untrackedGivenUp || ledger.untrackedJob !== void 0) return;
		if (ledger.untracked !== void 0 && Date.now() - ledger.untrackedAt < this.untrackedCadence(ledger)) return;
		const root = ledger.root;
		ledger.untrackedAt = Date.now();
		ledger.untrackedJob = (async () => {
			const started = Date.now();
			const scan = await this.run(ledger.alias, untrackedCommand(root, this.excludedDirs()), this.untrackedBudget());
			ledger.untrackedMs = Date.now() - started;
			if (ledger.disposed) return;
			if (ledger.root !== root) return;
			if (!scan.ok) {
				ledger.untrackedGivenUp = true;
				ledger.untrackedFailure = scan.reason;
				this.warn(`untracked scan unusable (${scan.reason}); new files will not be listed`);
				return;
			}
			ledger.untrackedFailure = void 0;
			ledger.untracked = parseUntrackedZ(scan.stdout);
			await this.absorbPreExisting(ledger);
			await this.publish(ledger, true);
		})().catch((error) => this.warn(`untracked scan failed: ${messageOf(error)}`)).finally(() => {
			ledger.untrackedJob = void 0;
		});
	}
	/**
	* How long before the untracked scan may run again.
	*
	* Self-tuning on purpose: the same command costs ~0.2s in a small repository
	* and over a minute in a monorepo, so a fixed cadence is either wasteful or
	* useless. Backing off to four times the last duration keeps small projects
	* near-real-time while a big one settles into a scan every couple of minutes
	* instead of one per turn.
	*/
	untrackedCadence(ledger) {
		const configured = this.deps.untrackedRefreshMs;
		if (configured !== void 0) return configured;
		const last = ledger.untrackedMs;
		if (last === void 0) return 0;
		return Math.max(5e3, Math.min(last * 2, 6e5));
	}
	/**
	* Fold files that already existed when the session began into the baseline.
	*
	* The untracked walk is slow enough (a minute on a monorepo) that the baseline
	* refresh publishes before it lands, so its first result arrives without a
	* "before" side. Without this, every file the checkout already had — the
	* user's own scratch files, a build's leftovers — would be announced as this
	* session's work, complete with a full-file addition count.
	*
	* mtime decides: strictly older than the ledger's own start means the session
	* cannot have created it, and its present content is therefore its baseline.
	*/
	async absorbPreExisting(ledger) {
		if (ledger.untracked === void 0 || ledger.absorbed) return;
		ledger.absorbed = true;
		const root = ledger.root;
		const baseline = ledger.baseline ?? /* @__PURE__ */ new Map();
		ledger.baseline = baseline;
		const unknown = ledger.untracked.map((entry) => entry.path).filter((path) => !baseline.has(path));
		if (unknown.length === 0) return;
		const reads = await this.readPaths(ledger, unknown, "worktree");
		if (ledger.disposed || ledger.root !== root) return;
		for (const [path, read] of reads) {
			if (read.mtime === void 0) continue;
			if (read.mtime * 1e3 < ledger.startedAt) baseline.set(path, read);
		}
	}
	/**
	* Race one host call against its own budget.
	*
	* A budget handed to `exec` is a request, not a guarantee: the transport may
	* keep the promise open long after the command should have been killed (the
	* remote process can even be gone while the channel stays). Awaiting such a
	* promise blocks the ledger's whole queue, so the panel shows "computing…"
	* for as long as the user is willing to stare at it. This bounds that wait.
	*/
	async withWatchdog(call, ms) {
		let timer;
		try {
			return await Promise.race([call, new Promise((resolve) => {
				timer = setTimeout(() => resolve(WATCHDOG_FIRED), ms);
			})]);
		} finally {
			if (timer !== void 0) clearTimeout(timer);
			call.catch(() => void 0);
		}
	}
	/** Read a batch of files, capped per file and in total. */
	async readPaths(ledger, paths, side, limits) {
		if (paths.length === 0) return /* @__PURE__ */ new Map();
		const perFile = limits?.perFile ?? this.deps.maxFileBytes ?? 256 * 1024;
		const total = limits?.total ?? this.deps.maxTotalBytes ?? 8 * 1024 * 1024;
		const command = side === "worktree" ? readWorktreeCommand(ledger.root, paths, perFile, total) : readHeadCommand(ledger.root, paths, perFile, total);
		const result = await this.run(ledger.alias, command);
		if (!result.ok) {
			this.warn(`read failed (${side}): ${result.reason}`);
			return /* @__PURE__ */ new Map();
		}
		return parseReads(result.stdout);
	}
	/** Run one command on the host, normalizing failure into a reason string. */
	async run(alias, command, budget = this.execBudget()) {
		try {
			const call = this.deps.pool.exec(alias, command, { timeoutMs: budget });
			const result = await this.withWatchdog(call, budget + Math.min(WATCHDOG_GRACE_MS, budget));
			if (result === WATCHDOG_FIRED) return {
				ok: false,
				reason: "git did not answer in time"
			};
			const stdout = typeof result.stdout === "string" ? result.stdout : "";
			if (result.success) return {
				ok: true,
				stdout
			};
			const stderr = typeof result.stderr === "string" ? result.stderr : "";
			return {
				ok: false,
				reason: this.reasonOf(result.exitCode, stderr),
				code: result.exitCode
			};
		} catch (error) {
			return {
				ok: false,
				reason: `host unreachable: ${messageOf(error)}`
			};
		}
	}
	/** Turn a failed scan into something a user can act on. */
	reasonOf(exitCode, stderr) {
		if (exitCode === 93 || exitCode === 128) return "not a git repository (change tracking needs git)";
		if (exitCode === 90) return "session directory is missing on the host";
		if (exitCode === 124 || exitCode === null || exitCode === void 0) return `git did not answer in time${stderr === "" ? "" : ` (${firstLine(stderr)})`}`;
		return `git failed (exit ${exitCode})${stderr === "" ? "" : ` (${firstLine(stderr)})`}`;
	}
	/** One exec's budget: the git setting, clamped so a hung host cannot pile up work. */
	execBudget() {
		const override = this.deps.execBudgetMs;
		if (override !== void 0 && Number.isFinite(override) && override > 0) return override;
		return this.budget(this.deps.timeouts().gitMs, 5e3, 6e4);
	}
	/** The untracked scan gets its own, more generous budget. */
	/**
	* The untracked scan gets its own, much more generous budget.
	*
	* Three minutes is a deliberate choice for a monorepo: the walk is proportional
	* to the whole checkout, not to the session, and the reference AOSP tree has
	* been measured past a minute cold. Waiting is acceptable here because the
	* scan runs in the background and the tracked changes are already on screen;
	* giving up early is not, because the files a session creates with a shell
	* command are visible ONLY through this scan.
	*/
	untrackedBudget() {
		return this.deps.untrackedBudgetMs ?? this.budget(this.deps.timeouts().gitMs, 1e4, 18e4);
	}
	/**
	* The exclusions this ledger scans with, normalized once per call.
	*
	* `??` and not `||`: an explicit empty array is a caller saying "count
	* everything", which must stay distinguishable from "not configured".
	*/
	excludedDirs() {
		return excludeDirNames(this.deps.excludeDirs ?? UNTRACKED_EXCLUDED_DIRECTORIES);
	}
	budget(configured, floor, ceiling) {
		return Math.max(floor, Math.min(Number.isFinite(configured) && configured > 0 ? configured : 3e4, ceiling));
	}
	warn(message) {
		try {
			this.deps.log?.("warn", message);
		} catch {}
	}
};
function firstLine(text) {
	return (text.split("\n").find((candidate) => candidate.trim() !== "") ?? "").trim().slice(0, 160);
}
/** Workspace-relative repository directory, or '' when the value is unusable. */
function normalizeRepoSubdir(value) {
	if (value === void 0) return "";
	const trimmed = value.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
	if (trimmed === "" || trimmed === ".") return "";
	if (trimmed.startsWith("/") || trimmed.includes("..")) return "";
	return trimmed;
}
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
//#region src/tools.ts
/**
* Agent tools: the model-facing counterpart of the remote GUI. Every tool
* talks to the same pool/files the web UI uses. Hosts must be configured in
* the GUI first (agents cannot create hosts).
*/
function text(value) {
	return [{
		type: "text",
		text: value
	}];
}
function toAgentHostRow(host) {
	return {
		alias: host.alias,
		host: host.host,
		port: host.port,
		user: host.user,
		auth: host.auth,
		keyReady: host.keyReady,
		managedKey: host.managedKey,
		...host.description !== void 0 ? { description: host.description } : {},
		tags: [...host.tags],
		createdAt: host.createdAt,
		updatedAt: host.updatedAt
	};
}
/**
* Render the host table.
*
* An empty list has TWO very different causes and they used to share one
* message: nothing is configured, or a query filtered everything out. The
* second one claimed "no remote hosts configured" while five were sitting
* there, which reads as "stop looking" to a caller that just searched.
*/
function renderHosts(hosts, query) {
	if (hosts.length === 0) return query === void 0 || query.trim() === "" ? "no remote hosts configured (add one in the Remote sidebar tab first)" : `no remote host matches "${query}" — hosts are configured, the query just filtered them all out`;
	return [
		"alias | host | port | user | auth | key | tags | description",
		"--- | --- | --- | --- | --- | --- | --- | ---",
		...hosts.map((h) => [
			h.alias,
			h.host,
			String(h.port),
			h.user,
			h.auth,
			h.auth === "key" ? h.keyReady ? "key-ok" : "key-missing" : "password",
			h.tags.length > 0 ? h.tags.join(",") : "-",
			h.description ?? ""
		].join(" | "))
	].join("\n");
}
/**
* `ls -l`-style type letter for one entry.
*
* A symlink is NOT a regular file, and rendering it as one made the two
* indistinguishable: `/bin`, `/lib`, `/lib64` and `/sbin` on an ordinary host
* are symlinks to directories, and they came out as `- 7 bin`, which reads as a
* seven-byte file. `isSymlink` is already in the entry, so the render simply has
* to use it. `.spike/tool-schema-check.mjs` now renders every tool and fails if
* these three kinds stop being distinguishable.
*/
function entryKind(entry) {
	if (entry.isDir) return "d";
	if (entry.isSymlink) return "l";
	return "-";
}
function renderExec(result) {
	const parts = [result.timedOut ? "[timed out]" : `[exit code: ${result.exitCode ?? "null"}]`];
	if (result.stdout !== "") parts.push("stdout:\n" + result.stdout);
	if (result.stderr !== "") parts.push("stderr:\n" + result.stderr);
	if (result.error !== void 0) parts.push("error: " + result.error);
	parts.push(`duration: ${result.durationMs} ms`);
	return parts.join("\n");
}
function remoteHostsTool(deps) {
	return defineTool({
		name: "remote_hosts",
		description: "List configured remote SSH hosts (alias, host, user, auth). Use remote_exec/remote_read/remote_write/remote_ls with the alias.",
		parameters: { query: {
			type: "string",
			description: "Optional fuzzy match against alias, host, and description."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { hosts: {
					type: "array",
					required: true,
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							alias: {
								type: "string",
								required: true
							},
							host: {
								type: "string",
								required: true
							},
							port: {
								type: "integer",
								required: true
							},
							user: {
								type: "string",
								required: true
							},
							auth: {
								type: "string",
								enum: ["key", "password"],
								required: true
							},
							keyReady: {
								type: "boolean",
								required: true
							},
							managedKey: {
								type: "boolean",
								required: true
							},
							description: { type: "string" },
							tags: {
								type: "array",
								items: { type: "string" },
								required: true
							},
							createdAt: {
								type: "integer",
								required: true
							},
							updatedAt: {
								type: "integer",
								required: true
							}
						}
					}
				} }
			},
			render: (args, value) => text(renderHosts(value.hosts ?? [], args.query))
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			const query = typeof args.query === "string" && args.query !== "" ? args.query.toLowerCase() : void 0;
			return { hosts: deps.store.list().map((h) => deps.store.summarize(h)).filter((h) => query === void 0 || h.alias.toLowerCase().includes(query) || h.host.toLowerCase().includes(query) || (h.description ?? "").toLowerCase().includes(query)).map(toAgentHostRow) };
		}
	});
}
function remoteExecTool(deps) {
	return defineTool({
		name: "remote_exec",
		description: "Run a non-interactive shell command on a remote SSH host. stdout/stderr are returned verbatim (may carry secrets).",
		parameters: {
			alias: {
				type: "string",
				description: "Host alias from remote_hosts."
			},
			command: {
				type: "string",
				description: "Shell command to run on the remote host."
			},
			timeoutMs: {
				type: "number",
				description: `Timeout in ms (default 60000, max ${MAX_TIMEOUT_MS}).`
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					success: {
						type: "boolean",
						required: true
					},
					exitCode: { type: "integer" },
					timedOut: {
						type: "boolean",
						required: true
					},
					stdout: {
						type: "string",
						required: true
					},
					stderr: {
						type: "string",
						required: true
					},
					durationMs: {
						type: "number",
						required: true
					},
					error: { type: "string" }
				}
			},
			render: (_args, value) => text(renderExec({
				...value,
				exitCode: value.exitCode ?? null
			}))
		},
		async execute(args) {
			const timeoutMs = clampExecTimeout(args.timeoutMs);
			const result = await deps.pool.exec(args.alias, args.command, timeoutMs === void 0 ? {} : { timeoutMs });
			return {
				success: result.success,
				timedOut: result.timedOut,
				stdout: result.stdout,
				stderr: result.stderr,
				durationMs: result.durationMs,
				...result.exitCode !== null ? { exitCode: result.exitCode } : {},
				...result.error !== void 0 ? { error: result.error } : {}
			};
		}
	});
}
function remoteLsTool(deps) {
	return defineTool({
		name: "remote_ls",
		description: "List one remote directory over SFTP (absolute POSIX path).",
		parameters: {
			alias: {
				type: "string",
				description: "Host alias from remote_hosts."
			},
			path: {
				type: "string",
				description: "Absolute remote directory path."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { entries: {
					type: "array",
					required: true,
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							name: {
								type: "string",
								required: true
							},
							path: {
								type: "string",
								required: true
							},
							isDir: {
								type: "boolean",
								required: true
							},
							size: {
								type: "integer",
								required: true
							},
							mtime: {
								type: "integer",
								required: true
							},
							mode: {
								type: "integer",
								required: true
							},
							isSymlink: {
								type: "boolean",
								required: true
							}
						}
					}
				} }
			},
			render: (_args, value) => text((value.entries ?? []).map((e) => `${entryKind(e)} ${e.size} ${e.name}`).join("\n") || "(empty directory)")
		},
		async execute(args) {
			return { entries: await new RemoteFiles(deps.pool).list(args.alias, args.path) };
		}
	});
}
function remoteReadTool(deps) {
	return defineTool({
		name: "remote_read",
		description: "Read a remote text file over SFTP (absolute POSIX path, first 8 MiB window). Refuses binary files.",
		parameters: {
			alias: {
				type: "string",
				description: "Host alias from remote_hosts."
			},
			path: {
				type: "string",
				description: "Absolute remote file path."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					size: {
						type: "integer",
						required: true
					},
					truncated: {
						type: "boolean",
						required: true
					},
					text: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => text((value.text ?? "") + (value.truncated === true ? "\n[... truncated: file exceeds 8 MiB ...]" : ""))
		},
		async execute(args) {
			const result = await new RemoteFiles(deps.pool).read(args.alias, args.path);
			if (result.binary) throw new Error("binary file: remote_read serves text only");
			return {
				size: result.size,
				truncated: result.truncated,
				text: result.text ?? ""
			};
		}
	});
}
function remoteWriteTool(deps) {
	return defineTool({
		name: "remote_write",
		description: "Write a remote text file over SFTP (absolute POSIX path, creates parent dirs). Overwrites without confirmation.",
		parameters: {
			alias: {
				type: "string",
				description: "Host alias from remote_hosts."
			},
			path: {
				type: "string",
				description: "Absolute remote file path."
			},
			content: {
				type: "string",
				description: "UTF-8 text content to write."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { size: {
					type: "integer",
					required: true
				} }
			},
			render: (_args, value) => text(`wrote ${value.size ?? 0} bytes`)
		},
		async execute(args) {
			/**
			* Exactly the declared shape. `write` also reports the version it left
			* behind (the editor's save guard reads it), but the model has no use for
			* a timestamp and this schema refuses undeclared keys — DSH rejects such a
			* result BEFORE the model ever sees it, which would make this tool
			* uncallable rather than merely verbose.
			*/
			return { size: (await new RemoteFiles(deps.pool).write(args.alias, args.path, args.content, "utf8")).size };
		}
	});
}
//#endregion
//#region src/index.ts
/** Stable cordis plugin name. */
const name = "remote-vs";
/**
* Services required before the remote surfaces can mount. MINIMAL ON PURPOSE
* (2026-10-13 deadlock lesson): our routers REPLACE fs/subprocess/spillStore
* at root, so anything downstream of them (workingDirectory, agents, …)
* transitively waits on us — declaring them here cycles the whole Host
* (remote-vs → workingDirectory → fs-router → remoteWorlds → remote-vs).
* Every other service is read SOFT via ctx.get() at call time (the
* tool-bash pattern: no startup wait, no throw, undefined when absent).
*/
const inject = [
	"webServer",
	"tools",
	"systemPrompt"
];
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
const Config = z.object({
	announceToAgent: z.boolean().default(false).volatile(),
	enabled: z.boolean().default(true).volatile(),
	routingMode: z.union([
		"off",
		"shadow",
		"enforce"
	]).default("enforce").volatile(),
	gitTimeoutMs: z.number().step(1).min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).default(DEFAULT_GIT_TIMEOUT_MS).volatile(),
	readTimeoutMs: z.number().step(1).min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).default(DEFAULT_READ_TIMEOUT_MS).volatile()
});
function readField(field, fallback) {
	if (field === void 0) return fallback;
	if (typeof field === "object" && field !== null && typeof field.get === "function") {
		const value = field.get();
		return value === void 0 ? fallback : value;
	}
	return field;
}
const TOOL_NAMES = [
	"remote_hosts",
	"remote_exec",
	"remote_ls",
	"remote_read",
	"remote_write"
];
const GUIDANCE = "本机已安装 dsh-remote-vs 插件（DSH 远程开发）：侧边栏「远程」tab 管理 SSH 主机与远端工作区。能力：主机配置存 $DSH_HOME/dsh-remote.json（证书/密码，与 dsh-ssh.json 独立）；remote_hosts 列出主机、remote_exec 执行远程命令、remote_ls/remote_read/remote_write 经 SFTP 读写远端文件；推送流水线做版本比对后推送 helper 可执行文件；Remote 预设提供远端 bash 工具集。限制：主机必须先在 GUI 里配好，agent 不可建主机；密码明文存于 0600 私有文件；远端输出原样返回，可能含敏感信息；只支持直连主机（跳板机/代理命令未排期）。";
/**
* Per-session remote mapping block (dynamic runtime context provider).
* Remote sessions under enforce get their alias→host→root mapping next to
* the cwd block; everything else (local route, off/shadow mode, tombstoned
* binding, missing host entry details) answers '' — empty text contributes
* nothing, so local sessions stay noise-free.
*
* Evaluated at every assembly: sync memory reads only (mode flag, route
* table scan, store maps — no I/O, no RPC), and it must never throw (an
* assembly provider throwing fails the model step — callers wrap in
* try/catch and treat any error as '').
*/
function workspaceMappingText(worlds, store, cwd) {
	if (worlds.mode !== "enforce") return "";
	let route;
	try {
		route = worlds.routeDir(cwd);
	} catch {
		return "";
	}
	if (route.kind !== "remote") return "";
	const entry = store.get(route.alias);
	const host = entry !== void 0 ? `${route.alias} (${entry.user}@${entry.host}:${entry.port})` : `${route.alias} (host entry missing)`;
	return [
		`Remote workspace (transparent execution ON): session cwd ${route.aliasPath} is an empty local alias; tools resolve here:`,
		`- host: ${host}`,
		`- remote root: ${route.remotePath}`,
		"Relative paths and POSIX absolutes run on the remote host; the alias dir holds no real files.",
		"- File paths in your reply: use the remote absolute path (e.g. /home/...) or a path relative to the remote root above — never a path relative to your current directory; a click resolves against the remote root."
	].join("\n");
}
function apply(ctx, config) {
	const store = new RemoteStore();
	const viewSettings = new RemoteViewSettingsStore();
	const pool = new RemotePool(store);
	const worlds = new RemoteWorlds(ctx, {
		store,
		pool,
		mode: () => readField(config?.routingMode, "enforce")
	});
	ctx.provide("remoteWorlds", worlds);
	ctx.effect(() => () => {
		pool.dispose();
	}, "dsh-remote-vs: pool");
	ctx.effect(() => () => {
		worlds.dispose().catch(() => void 0);
	}, "dsh-remote-vs: worlds");
	worlds.syncWorkspaces().catch((error) => {
		try {
			ctx.logger.warn(`[remote-vs] workspace sync failed: ${error instanceof Error ? error.message : String(error)}`);
		} catch {}
	});
	try {
		const seed = seedHelperCache();
		if (!seed.vendorMissing && (seed.seeded.length > 0 || seed.failed.length > 0)) try {
			ctx.logger.info(`[remote-vs] helper cache seeded: ${seed.seeded.length} copied, ${seed.skipped.length} kept${seed.failed.length > 0 ? `, FAILED: ${seed.failed.join(", ")}` : ""}`);
		} catch {}
	} catch {}
	ctx.effect(() => ctx.systemPrompt.context({
		name: "remote-vs:workspace-mapping",
		order: 105,
		required: true,
		interpolate: false,
		text: (context) => {
			try {
				const session = context.agent?.session;
				if (session === void 0) return "";
				const workingDirectory = ctx.get("workingDirectory");
				if (workingDirectory === void 0) return "";
				let cwd;
				try {
					cwd = workingDirectory.get(session);
				} catch {
					return "";
				}
				return workspaceMappingText(worlds, store, cwd);
			} catch {
				return "";
			}
		}
	}), "dsh-remote-vs: workspace mapping");
	const resolve = () => ({
		announceToAgent: readField(config?.announceToAgent, false),
		enabled: readField(config?.enabled, true)
	});
	const resolveTimeoutsNow = () => resolveTimeouts({
		gitTimeoutMs: readField(config?.gitTimeoutMs, DEFAULT_GIT_TIMEOUT_MS),
		readTimeoutMs: readField(config?.readTimeoutMs, DEFAULT_READ_TIMEOUT_MS)
	});
	/**
	* Which sessions get a ledger.
	*
	* Subagent sessions are skipped on purpose, the same policy DSH's own
	* recorder uses: a delegated session writes into the same workspace, so its
	* files show up in the parent session's diff anyway, while recording it
	* separately would run the scans once per subagent turn (a Team run fans out,
	* and the scan is the expensive part).
	*/
	const ledgerTarget = (session) => {
		const header = session.header;
		if (header?.origin === "subagent" || (header?.delegationDepth ?? 0) > 0) return void 0;
		let cwd = header?.cwd ?? "";
		try {
			const current = ctx.get("workingDirectory")?.get?.(session);
			if (typeof current === "string" && current !== "") cwd = current;
		} catch {}
		return cwd === "" ? void 0 : {
			sessionId: session.id,
			cwd
		};
	};
	const changes = new SessionChanges({
		pool,
		worlds,
		timeouts: resolveTimeoutsNow,
		log: (level, message) => {
			try {
				if (level === "warn") ctx.logger.warn(`[remote-vs] changes: ${message}`);
				else ctx.logger.info(`[remote-vs] changes: ${message}`);
			} catch {}
		}
	});
	ctx.on("session/event", (session, event) => {
		try {
			if (event.type !== "turn/start" && event.type !== "turn/end") return;
			const target = ledgerTarget(session);
			if (target === void 0) return;
			if (event.type === "turn/start") changes.beginTurn(target);
			else changes.endTurn(target, event.data.turn);
		} catch {}
	});
	ctx.on("session/disposed", (session) => {
		changes.forget(session.id);
	});
	ctx.on("agent/turn-stopping", (payload) => {
		try {
			const target = ledgerTarget(payload.agent.session);
			if (target !== void 0) changes.endTurn(target, payload.turn);
		} catch {}
	});
	ctx.effect(() => () => {
		changes.dispose();
	}, "dsh-remote-vs: changes ledger");
	/**
	* Local port forwards (`ssh -L`) — resident listeners with their own
	* lifecycle, on purpose.
	*
	* A forward's listener must survive `sync()` erasing and re-registering the
	* route table (a settings edit must not kill a tunnel), so the manager is not
	* created inside `makeRoutes`; the routes only see its CRUD face. Its effect
	* is registered BEFORE the routes effect, so unload closes routes first, then
	* the forwards (their channels still need a live pool), and the pool last.
	*/
	const forwards = new ForwardManager({
		pool,
		log: (level, message) => {
			try {
				if (level === "warn") ctx.logger.warn(`[remote-vs] forwards: ${message}`);
				else ctx.logger.info(`[remote-vs] forwards: ${message}`);
			} catch {}
		}
	});
	const { routes, upgrade, terminalSessions } = makeRoutes({
		store,
		pool,
		worlds,
		ctx,
		timeouts: resolveTimeoutsNow,
		changes,
		forwards,
		viewSettings
	});
	/**
	* PTY sessions own their own lifetime, separate from route registration.
	*
	* `sync()` rebuilds the route/tool registrations whenever a volatile config
	* value changes (`loader/volatile-update` fires for every settings edit), and a
	* cleanup that also closed terminals made "change one setting" kill every live
	* remote shell. So the registry gets a fiber-scoped effect of its own: it is
	* disposed exactly once — when the plugin is actually unloaded — and never by
	* the route re-registration in `sync()`.
	*
	* Cleanup order is load-bearing: this effect is registered AFTER the pool
	* effect but BEFORE the routes effect created in `sync()`, and cordis starts a
	* fiber's effect cleanups in reverse registration order (these cleanups are
	* synchronous) — so on unload the routes are unregistered first (no new shell
	* can be opened), then the terminals close (a channel close still has a live
	* pool), and the pool is disposed last.
	*/
	ctx.effect(() => () => {
		terminalSessions.dispose();
	}, "dsh-remote-vs: terminal sessions");
	/**
	* Forwards close after routes (no new local connection can arrive once the
	* route table is gone) and BEFORE the pool is disposed (a channel close still
	* needs a live connection). Registered before `sync()` creates the routes
	* effect, so the reverse-order cleanup above holds.
	*/
	ctx.effect(() => () => {
		forwards.dispose();
	}, "dsh-remote-vs: port forwards");
	let disposeRoutes;
	const tools = [
		remoteHostsTool({
			store,
			pool
		}),
		remoteExecTool({
			store,
			pool
		}),
		remoteLsTool({
			store,
			pool
		}),
		remoteReadTool({
			store,
			pool
		}),
		remoteWriteTool({
			store,
			pool
		})
	];
	let disposeTools;
	let disposeSection;
	const sync = () => {
		if (disposeSection !== void 0) {
			disposeSection();
			disposeSection = void 0;
		}
		if (disposeRoutes !== void 0) {
			disposeRoutes();
			disposeRoutes = void 0;
		}
		if (disposeTools !== void 0) {
			disposeTools();
			disposeTools = void 0;
		}
		const value = resolve();
		if (!value.enabled) {
			forwards.stopAll();
			return;
		}
		if (value.announceToAgent) disposeSection = ctx.systemPrompt.section({
			name: "plugin:dsh-remote-vs",
			order: 60,
			text: () => {
				if (TOOL_NAMES.filter((n) => ctx.tools.get(n) !== void 0).length === 0) return "";
				return GUIDANCE;
			}
		});
		disposeRoutes = ctx.effect(() => {
			const disposers = routes.map((route) => ctx.webServer.register(route));
			const upgradeDisposer = ctx.webServer.registerUpgrade(upgrade);
			return () => {
				for (const dispose of disposers) dispose();
				upgradeDisposer();
			};
		}, "dsh-remote-vs: routes");
		disposeTools = ctx.effect(() => {
			const disposers = tools.map((tool) => ctx.tools.register(tool));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "dsh-remote-vs: tools");
	};
	ctx.on("loader/volatile-update", () => {
		sync();
	});
	/**
	* Preset auto-switch for a new session born in a remote workspace (Phase 4b).
	*
	* 2026-11-10, bug "sometimes no Remote preset ~3 s after creating a session":
	*
	* - The Web client does not always MINT a session. `createInWorkspace` reuses
	*   the first listed BLANK session of the workspace by passing its id, and the
	*   Host answers that through `agents.resume` → `agent/created` with source
	*   `'resume'`. The old `source !== 'startup'` guard silently skipped exactly
	*   those sessions. Blankness (no turn started) is the precondition the preset
	*   registry itself enforces, so it is what we check now — a resumed session
	*   with history is excluded by it.
	* - One 2.5 s shot also lost every transient state: the preset may not be
	*   composed yet, the working directory may be unreadable, or the workspace
	*   binding may not be listed. `runPresetSwitchAttempts` retries those for a
	*   bounded time and stops on terminal reasons (routing off, history, user's
	*   own preset, local directory).
	*
	* The listener still DETACHES: it returns immediately, so session creation
	* never waits for a switch (the original 2026-10-13 race: selecting during
	* creation while both preset trees register tools could kill the session).
	* Failure modes are logged, never thrown; manual selection stays the fallback.
	*/
	const attemptPresetSwitch = async (agent) => {
		const presets = ctx.get("agentPresets");
		const agents = ctx.get("agents");
		const workingDirectory = ctx.get("workingDirectory");
		let boundary;
		try {
			boundary = agents?.turnBoundaryOf?.(agent.session);
		} catch {
			boundary = void 0;
		}
		let cwd = "";
		try {
			const current = workingDirectory?.get?.(agent.session);
			if (typeof current === "string") cwd = current;
		} catch {}
		let remote;
		let tombstoned = false;
		if (cwd !== "") try {
			remote = worlds.routeDir(cwd).kind === "remote";
		} catch (error) {
			if (error instanceof TombstonedError) tombstoned = true;
		}
		let currentPreset;
		let defaultPreset;
		try {
			currentPreset = presets?.composedPreset(agent.ctx);
			defaultPreset = presets?.defaultId;
		} catch {
			currentPreset = void 0;
			defaultPreset = void 0;
		}
		const facts = {
			mode: worlds.mode,
			hasPresets: presets !== void 0,
			blank: boundary !== void 0 && boundary.openTurnStartSeq === null && boundary.lastTurn === 0,
			cwd,
			remote,
			tombstoned,
			currentPreset,
			defaultPreset
		};
		const step = decidePresetSwitch(facts);
		if (step.action !== "switch") return {
			step,
			facts
		};
		if (presets === void 0) return {
			step: {
				action: "stop",
				reason: "presets-absent"
			},
			facts
		};
		try {
			await presets.select(agent, REMOTE_PRESET_ID);
			return {
				step: {
					action: "stop",
					reason: "switched"
				},
				facts
			};
		} catch (error) {
			const locked = error instanceof Error && /locked|already started/i.test(error.message);
			return {
				step: {
					action: locked ? "stop" : "retry",
					reason: locked ? "locked" : "select-failed"
				},
				facts
			};
		}
	};
	ctx.on("agent/created", (payload) => {
		(async () => {
			try {
				const { step, facts, attempts } = await runPresetSwitchAttempts(() => attemptPresetSwitch(payload.agent));
				try {
					if (step.reason === "switched" && facts?.remote === true) ctx.logger.info(`[remote-vs] remote session ${facts.cwd}: preset switched to ${REMOTE_PRESET_ID} after ${attempts} attempt(s)`);
					else if (step.action === "retry") ctx.logger.warn(`[remote-vs] preset auto-switch gave up after ${attempts} attempt(s): ${step.reason}`);
					else if (facts?.remote === true) ctx.logger.info(`[remote-vs] preset auto-switch skipped for ${facts.cwd}: ${step.reason}`);
				} catch {}
			} catch (error) {
				try {
					ctx.logger.warn(`[remote-vs] preset auto-switch skipped: ${error instanceof Error ? error.message : String(error)}`);
				} catch {}
			}
		})();
	});
	sync();
}
//#endregion
export { Config, apply, inject, name };
