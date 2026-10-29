import { a as pushPipeline, c as require_lib, d as ensurePrivateDir, f as keysDir, i as probe, l as aliasRoot, o as seedHelperCache, p as storePath, r as helperAvailability, s as RemoteFiles, t as RemoteWorlds, u as dshHome } from "./worlds-a8nqW9mi.js";
import z from "@deepseek-ai/schemastery";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
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
function sameStamp(left, right) {
	if (left === null || right === null) return left === right;
	return left.mtimeMs === right.mtimeMs && left.size === right.size;
}
/** Alias grammar: 1-64 chars of letters/digits/._- */
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function assertAlias(alias) {
	if (typeof alias !== "string" || !ALIAS_RE.test(alias)) throw new Error("alias must match [A-Za-z0-9._-]{1,64} and start with an alphanumeric");
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
		if (stamp !== void 0 && this.stamp !== void 0 && sameStamp(stamp, this.stamp)) return;
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
		const tmp = `${this.file}.${process.pid}.tmp`;
		const fd = openSync(tmp, "w", 384);
		try {
			writeSync(fd, payload);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, this.file);
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
		if (this.get(payload.alias) !== void 0) throw new Error(`alias already exists: ${payload.alias}`);
		const entry = this.normalize(payload, void 0);
		this.doc.hosts.push(entry);
		this.save();
		return entry;
	}
	update(alias, patch) {
		const current = this.require(alias);
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
		const index = this.doc.hosts.findIndex((h) => h.alias === alias);
		this.doc.hosts[index] = next;
		this.save();
		return next;
	}
	remove(alias) {
		const before = this.doc.hosts.length;
		this.doc.hosts = this.doc.hosts.filter((h) => h.alias !== alias);
		this.doc.workspaces = this.doc.workspaces.filter((w) => w.alias !== alias);
		if (this.doc.hosts.length === before) return false;
		this.save();
		return true;
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
		const entry = this.require(alias);
		entry.deploy = state;
		entry.updatedAt = Date.now();
		this.save();
	}
	listWorkspaces() {
		this.reload();
		return [...this.doc.workspaces];
	}
	createWorkspace(payload) {
		if (typeof payload.name !== "string" || payload.name.trim() === "") throw new Error("name must be a non-empty string");
		this.require(payload.alias);
		if (typeof payload.remotePath !== "string" || !payload.remotePath.startsWith("/")) throw new Error("remotePath must be an absolute POSIX path");
		const binding = {
			id: randomUUID().slice(0, 8),
			name: payload.name.trim(),
			alias: payload.alias,
			remotePath: payload.remotePath,
			createdAt: Date.now()
		};
		this.doc.workspaces.push(binding);
		this.save();
		return binding;
	}
	removeWorkspace(id) {
		this.reload();
		if (this.doc.workspaces.find((w) => w.id === id) === void 0) return false;
		this.addTombstone(join(aliasRoot(), id));
		this.doc.workspaces = this.doc.workspaces.filter((w) => w.id !== id);
		this.save();
		return true;
	}
	/** Record a removed alias path (idempotent). */
	addTombstone(aliasPath) {
		if (!this.doc.tombstones.includes(aliasPath)) {
			this.doc.tombstones.push(aliasPath);
			this.save();
		}
	}
	listTombstones() {
		this.reload();
		return [...this.doc.tombstones];
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
/** Per-stream output cap (stdout/stderr each); overflow truncates with a marker. */
const OUTPUT_CAP = 2 * 1024 * 1024;
/**
* Wall-clock cap for one SFTP callback body. SSH gives no request timeout of
* its own, so a server that never answers would hold the session (and the
* pooled connection's hold count) open forever — the leak that eventually
* exhausts the server's channel budget. The timeout rejects so the caller's
* `finally` still ends the session and releases the connection.
*/
const SFTP_OP_TIMEOUT_MS = 6e4;
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
var RemotePool = class {
	store;
	conns = /* @__PURE__ */ new Map();
	/** TOFU fingerprints observed this process (alias -> sha256). */
	hostKeys = /* @__PURE__ */ new Map();
	/** Per-alias `setsid --wait` capability, probed once (see supportsSetsid). */
	setsidProbes = /* @__PURE__ */ new Map();
	/** Per-alias channel slots and the queue waiting for one (see acquireSlot). */
	slots = /* @__PURE__ */ new Map();
	constructor(store) {
		this.store = store;
	}
	/** Drop one pooled connection (call after host update/delete). */
	drop(alias) {
		const pooled = this.conns.get(alias);
		this.setsidProbes.delete(alias);
		if (pooled === void 0) return;
		this.conns.delete(alias);
		if (pooled.timer !== void 0) clearTimeout(pooled.timer);
		try {
			pooled.conn.end();
		} catch {}
	}
	/** Close every pooled connection. */
	dispose() {
		for (const alias of [...this.conns.keys()]) this.drop(alias);
	}
	/** Test a connection without disturbing the pool. */
	async test(alias) {
		const started = Date.now();
		try {
			await this.acquire(alias);
			this.hold(alias);
			this.release(alias);
			return {
				ok: true,
				durationMs: Date.now() - started
			};
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - started
			};
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
			return await this.runExec(alias, command, opts);
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
		const conn = await this.acquire(alias);
		this.hold(alias);
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
			channel.once("close", () => this.release(alias));
			return channel;
		} catch (error) {
			this.release(alias);
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
			return channel;
		} catch (error) {
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
			const sftp = await withDeadline(new Promise((resolve, reject) => {
				conn.sftp((error, session) => {
					if (error !== void 0 && error !== null) reject(error);
					else resolve(session);
				});
			}), SFTP_OP_TIMEOUT_MS, `SFTP session open timed out after ${SFTP_OP_TIMEOUT_MS / 1e3}s`);
			try {
				const limit = opts.timeoutMs ?? SFTP_OP_TIMEOUT_MS;
				if (limit <= 0) return await fn(sftp);
				return await withDeadline(fn(sftp), limit, `SFTP operation timed out after ${limit / 1e3}s`);
			} finally {
				try {
					sftp.end();
				} catch {}
			}
		} finally {
			this.release(alias);
			this.releaseSlot(alias);
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
				sftp.fastPut(localPath, remotePath, { step: () => {
					arm();
				} }, (error) => {
					finish(error === void 0 || error === null ? void 0 : new Error(error.message));
				});
			});
		}, { timeoutMs: 0 });
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
		const pooled = this.conns.get(alias);
		if (pooled === void 0) return;
		pooled.held += 1;
		pooled.lastUse = Date.now();
		if (pooled.timer !== void 0) {
			clearTimeout(pooled.timer);
			pooled.timer = void 0;
		}
	}
	release(alias) {
		const pooled = this.conns.get(alias);
		if (pooled === void 0) return;
		if (pooled.held > 0) pooled.held -= 1;
		pooled.lastUse = Date.now();
		if (pooled.held > 0) return;
		if (pooled.timer !== void 0) clearTimeout(pooled.timer);
		pooled.timer = setTimeout(() => this.drop(alias), IDLE_MS);
		if (typeof pooled.timer === "object" && "unref" in pooled.timer) pooled.timer.unref();
	}
	async acquire(alias) {
		const pooled = this.conns.get(alias);
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
		this.conns.set(alias, entry);
		entry.connecting = this.dial(alias).then((conn) => {
			entry.conn = conn;
			entry.connecting = void 0;
			conn.on("close", () => {
				if (this.conns.get(alias) === entry) this.drop(alias);
			});
			conn.on("error", () => {
				if (this.conns.get(alias) === entry) this.drop(alias);
			});
			this.release(alias);
			return conn;
		}, (error) => {
			this.conns.delete(alias);
			throw error;
		});
		return entry.connecting;
	}
	dial(alias) {
		const host = this.store.require(alias);
		return new Promise((resolve, reject) => {
			const conn = new import_lib.Client();
			let settled = false;
			const fail = (error) => {
				if (settled) return;
				settled = true;
				try {
					conn.end();
				} catch {}
				reject(explainAuthError(host, error));
			};
			conn.on("ready", () => {
				if (settled) return;
				settled = true;
				resolve(conn);
			});
			conn.on("error", (error) => fail(error));
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
		const timer = setTimeout(() => reject(new Error(message)), ms);
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
//#endregion
//#region src/http.ts
const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"referrer-policy": "no-referrer"
};
/**
* Lenient bounded body reader: parse a request body as JSON, or null on an
* empty body, invalid JSON, or a body past maxBytes (default 64 KiB).
*/
async function readJsonBody(req, opts = {}) {
	const maxBytes = opts.maxBytes ?? 64 * 1024;
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > maxBytes) {
			req.destroy();
			return null;
		}
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text === "") return null;
	try {
		const parsed = JSON.parse(text);
		if (opts.objectOnly && !isJsonObject(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}
function isJsonObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Write one JSON response. */
function writeJson(res, status, body, headers = {}) {
	res.writeHead(status, {
		...JSON_HEADERS,
		...headers
	});
	res.end(JSON.stringify(body));
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
	keygen: "/api/dsh-remote/keygen",
	exec: "/api/dsh-remote/exec",
	/** Streaming exec (server-sent events) for the long network verbs. */
	execStream: "/api/dsh-remote/exec-stream",
	files: "/api/dsh-remote/files",
	/** Streaming binary upload: raw request body, host and path in the query. */
	upload: "/api/dsh-remote/upload",
	workspaces: "/api/dsh-remote/workspaces",
	deploy: "/api/dsh-remote/deploy",
	importSshConfig: "/api/dsh-remote/import-ssh-config",
	importDshSsh: "/api/dsh-remote/import-dsh-ssh",
	terminal: "/api/dsh-remote/terminal",
	terminalClose: "/api/dsh-remote/terminal-close",
	routing: "/api/dsh-remote/routing",
	/** Current working directory of one live session (click resolution helper). */
	sessionCwd: "/api/dsh-remote/session-cwd",
	/** What one live session changed on its remote host (the review panel). */
	changes: "/api/dsh-remote/changes"
};
//#endregion
//#region src/keygen.ts
/**
* Password -> key bootstrap (Q2 decision): a password host gets a dedicated
* ed25519 keypair generated locally (ssh-keygen), the public half is appended
* to the remote ~/.ssh/authorized_keys over the password connection, and the
* store entry flips to key auth with the managed keyPath.
*/
const execFileAsync = promisify(execFile);
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
	const publicKey = readFileSync(publicPath, "utf8").trim();
	if (!publicKey.startsWith("ssh-ed25519 ")) throw new Error(`unexpected public key format in ${publicPath}`);
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
		`grep -qxF '${publicKey}' ~/.ssh/authorized_keys 2>/dev/null || echo '${publicKey}' >> ~/.ssh/authorized_keys`
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
		} else if (current !== void 0 && !current.fields.has(key)) current.fields.set(key, value);
	}
	for (const block of blocks) {
		const alias = block.patterns[0];
		if (alias === void 0 || alias.includes("*") || alias.includes("?") || alias.includes("!")) {
			skipped.push({
				alias: block.patterns.join(" ") || "(empty)",
				reason: "wildcard patterns are not imported"
			});
			continue;
		}
		if (block.fields.has("proxyjump") || block.fields.has("proxycommand")) {
			skipped.push({
				alias,
				reason: "proxyJump/proxyCommand needs P1 (direct hosts only in P0)"
			});
			continue;
		}
		const identityFile = block.fields.get("identityfile")?.split(/\s+/)[0];
		payloads.push({
			alias,
			host: block.fields.get("hostname") ?? alias,
			port: block.fields.get("port") !== void 0 ? Number(block.fields.get("port")) : 22,
			user: block.fields.get("user") ?? "",
			auth: identityFile !== void 0 ? {
				kind: "key",
				keyPath: expandHome(identityFile)
			} : {
				kind: "password",
				password: ""
			},
			tags: ["imported:ssh-config"]
		});
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
		const proxyJump = raw.proxyJump ?? [];
		const proxyCommand = raw.proxyCommand;
		if (kind !== "key" && kind !== "password") {
			skipped.push({
				alias,
				reason: `auth kind '${String(kind)}' needs P1 (key/password only in P0)`
			});
			continue;
		}
		if (proxyJump.length > 0 || typeof proxyCommand === "string" && proxyCommand !== "") {
			skipped.push({
				alias,
				reason: "proxyJump/proxyCommand needs P1 (direct hosts only in P0)"
			});
			continue;
		}
		if (kind === "key" && typeof auth.keyPath !== "string") {
			skipped.push({
				alias,
				reason: "key auth without keyPath"
			});
			continue;
		}
		if (kind === "password" && typeof auth.password !== "string") {
			skipped.push({
				alias,
				reason: "password auth without stored password (enter it manually)"
			});
			continue;
		}
		payloads.push({
			alias,
			host: typeof raw.host === "string" ? raw.host : "",
			port: typeof raw.port === "number" ? raw.port : 22,
			user: typeof raw.user === "string" ? raw.user : "",
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
* The counter is per session, not per socket: one lagging socket pauses the
* channel for every socket attached to that shell. That is deliberate — the
* alternative is letting the slowest consumer grow the host process.
*/
const OUT_HIGH_WATER = 4 * 1024 * 1024;
const OUT_LOW_WATER = 1 * 1024 * 1024;
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
var TerminalSessionRegistry = class {
	pool;
	sessions = /* @__PURE__ */ new Map();
	constructor(pool) {
		this.pool = pool;
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
			reap: void 0
		};
		this.sessions.set(id, session);
		channel.on("data", (chunk) => {
			this.broadcast(session, {
				t: "out",
				d: chunk.toString("utf8")
			});
		});
		channel.stderr.on("data", (chunk) => {
			this.broadcast(session, {
				t: "out",
				d: chunk.toString("utf8")
			});
		});
		channel.on("close", (code) => {
			session.alive = false;
			session.exitCode = code;
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
		try {
			session.channel.close();
		} catch {}
		for (const socket of session.sockets) try {
			socket.close(1e3);
		} catch {}
		session.sockets.clear();
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
			session.sockets.delete(ws);
			if (session.sockets.size > 0) return;
			session.pending = 0;
			this.setPaused(session, false);
			this.armReap(session);
		};
		ws.on("close", detach);
		ws.on("error", detach);
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
		const size = Buffer.byteLength(text, "utf8");
		for (const socket of session.sockets) {
			let settled = false;
			const done = () => {
				if (settled) return;
				settled = true;
				session.pending = Math.max(0, session.pending - size);
				if (session.pending <= OUT_LOW_WATER) this.setPaused(session, false);
			};
			session.pending += size;
			try {
				socket.send(text, done);
			} catch {
				done();
			}
		}
		if (session.pending > OUT_HIGH_WATER) this.setPaused(session, true);
	}
};
//#endregion
//#region src/timeouts.ts
/** Smallest accepted timeout: below this, local work would start failing. */
const MIN_TIMEOUT_MS = 1e3;
/**
* Largest accepted timeout — the exec route clamps to the same ceiling.
*
* Raised from 10 to 30 minutes when the SCM push gained a live output panel:
* a Gerrit push on a large repo waits for server-side hooks and can outlast
* the old ceiling with nothing wrong on either side.
*/
const MAX_TIMEOUT_MS = 18e5;
/**
* Default for one git command (status/log/branches/diff over exec).
*
* 120 s was the old internal value and 45 s the old client deadline; both were
* routinely exceeded by a cold `git status` on a large monorepo. Five minutes
* still fails eventually (a wedged host must not spin forever) but outlasts any
* plausible cold index walk.
*/
const DEFAULT_GIT_TIMEOUT_MS = 3e5;
/** Default for one SFTP file read (editor, diff sides, document preview). */
const DEFAULT_READ_TIMEOUT_MS = 12e4;
/** The pair every half starts from before any Host answer arrives. */
const DEFAULT_TIMEOUTS = {
	gitMs: DEFAULT_GIT_TIMEOUT_MS,
	readMs: DEFAULT_READ_TIMEOUT_MS
};
/**
* Clamp one untrusted timeout into the accepted range.
*
* @param value - raw value (plugin config, JSON body, anything).
* @param fallback - used when the value is not a usable number.
* @returns a whole number of milliseconds within [MIN, MAX].
*/
function clampTimeout(value, fallback) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const whole = Math.floor(value);
	if (whole < 1e3) return MIN_TIMEOUT_MS;
	if (whole > 18e5) return MAX_TIMEOUT_MS;
	return whole;
}
/**
* Clamp an optional request timeout: absent/invalid stays absent, which is what
* the exec route forwards as "use the pool default".
*
* @param value - raw `timeoutMs` from a request body.
* @returns the clamped timeout, or undefined when the caller named none.
*/
function clampExecTimeout(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return void 0;
	return clampTimeout(value, DEFAULT_GIT_TIMEOUT_MS);
}
/** Resolve the effective pair from raw config values. */
function resolveTimeouts(config) {
	return {
		gitMs: clampTimeout(config?.gitTimeoutMs, DEFAULT_GIT_TIMEOUT_MS),
		readMs: clampTimeout(config?.readTimeoutMs, DEFAULT_READ_TIMEOUT_MS)
	};
}
//#endregion
//#region src/routes.ts
/** One noServer WebSocket server for terminal upgrades (RFC 6455). */
const terminalWss = new WebSocketServer({
	noServer: true,
	maxPayload: TERMINAL_MAX_FRAME_BYTES
});
function queryParam(url, name) {
	const value = url.searchParams.get(name);
	return value === null ? void 0 : value;
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
	return {
		routes: [
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
						writeJson(res, 200, { hosts: store.list().map((h) => store.summarize(h)) });
						return;
					}
					if (method === "POST") {
						const body = await readJsonBody(req, { objectOnly: true });
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
						pool.drop(alias);
						worlds.dropHost(alias).catch(() => void 0);
						if (!store.remove(alias)) {
							writeJson(res, 404, { error: `unknown host alias: ${alias}` });
							return;
						}
						worlds.syncWorkspaces().catch(() => void 0);
						writeJson(res, 200, { ok: true });
						return;
					}
					const body = await readJsonBody(req, { objectOnly: true });
					if (body === null) {
						writeJson(res, 400, { error: "invalid JSON body" });
						return;
					}
					try {
						pool.drop(alias);
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
					const body = await readJsonBody(req, { objectOnly: true });
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
					const body = await readJsonBody(req, { objectOnly: true });
					if (body === null || typeof body.alias !== "string") {
						writeJson(res, 400, { error: "alias is required" });
						return;
					}
					try {
						writeJson(res, 200, await bootstrap(pool, store, body.alias));
					} catch (error) {
						writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
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
					const body = await readJsonBody(req, { objectOnly: true });
					if (body === null || typeof body.alias !== "string" || typeof body.command !== "string" || body.command === "") {
						writeJson(res, 400, { error: "alias and a non-empty command are required" });
						return;
					}
					const timeoutMs = clampExecTimeout(body.timeoutMs);
					writeJson(res, 200, await pool.exec(body.alias, body.command, timeoutMs === void 0 ? {} : { timeoutMs }));
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
					const body = await readJsonBody(req, { objectOnly: true });
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
					const body = await readJsonBody(req, {
						objectOnly: true,
						maxBytes: 10 * 1024 * 1024
					});
					if (body === null || typeof body.op !== "string" || typeof body.alias !== "string") {
						writeJson(res, 400, { error: "op and alias are required" });
						return;
					}
					const alias = body.alias;
					try {
						switch (body.op) {
							case "list":
								if (typeof body.path !== "string") throw new Error("path is required");
								writeJson(res, 200, { entries: await files.list(alias, body.path) });
								return;
							case "stat":
								if (typeof body.path !== "string") throw new Error("path is required");
								writeJson(res, 200, { entry: await files.stat(alias, body.path) });
								return;
							case "read":
								if (typeof body.path !== "string") throw new Error("path is required");
								writeJson(res, 200, await files.read(alias, body.path));
								return;
							case "write": {
								if (typeof body.path !== "string" || typeof body.content !== "string") throw new Error("path and content are required");
								const encoding = body.encoding === "base64" ? "base64" : "utf8";
								writeJson(res, 200, await files.write(alias, body.path, body.content, encoding));
								return;
							}
							case "mkdir":
								if (typeof body.path !== "string") throw new Error("path is required");
								await files.mkdir(alias, body.path);
								writeJson(res, 200, { ok: true });
								return;
							case "rm":
								if (typeof body.path !== "string") throw new Error("path is required");
								await files.remove(alias, body.path, body.recursive === true);
								writeJson(res, 200, { ok: true });
								return;
							case "rename":
								if (typeof body.from !== "string" || typeof body.to !== "string") throw new Error("from and to are required");
								await files.rename(alias, body.from, body.to);
								writeJson(res, 200, { ok: true });
								return;
							default: writeJson(res, 400, { error: `unknown op: ${body.op}` });
						}
					} catch (error) {
						writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
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
						writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
					}
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
						return;
					}
					if (method === "POST") {
						const body = await readJsonBody(req, { objectOnly: true });
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
					const body = await readJsonBody(req, { objectOnly: true });
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
					const body = await readJsonBody(req, { objectOnly: true });
					const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
					const op = typeof body?.op === "string" ? body.op : "";
					if (sessionId === "" || op !== "list" && op !== "diff") {
						writeJson(res, 400, { error: "op (list|diff) and a non-empty sessionId are required" });
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
						else ledger.touch(sessionId);
						writeJson(res, 200, { summary: ledger.summary(sessionId) });
						return;
					}
					const path = typeof body?.path === "string" ? body.path : "";
					if (path === "") {
						writeJson(res, 400, { error: "path is required for op=diff" });
						return;
					}
					try {
						writeJson(res, 200, { diff: await ledger.diff(sessionId, path) });
					} catch (error) {
						writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
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
					const mode = (await readJsonBody(req, { objectOnly: true }))?.mode;
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
						writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
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
								writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
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
								writeJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
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
					const body = await readJsonBody(req, { objectOnly: true });
					if (body === null || typeof body.alias !== "string") {
						writeJson(res, 400, { error: "alias is required" });
						return;
					}
					try {
						writeJson(res, 200, await pushPipeline(pool, store, body.alias, typeof body.version === "string" ? { version: body.version } : {}));
					} catch (error) {
						writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
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
					const body = await readJsonBody(req, { maxBytes: 1024 * 1024 });
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
					const body = await readJsonBody(req, { objectOnly: true });
					if (body === null || typeof body.id !== "string" || body.id === "") {
						writeJson(res, 400, { error: "id is required" });
						return;
					}
					writeJson(res, 200, { ok: terminalSessions.close(body.id) });
				}
			}
		],
		upgrade: {
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
		},
		terminalSessions
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
* New files git is not tracking yet (the ones a session usually creates).
*
* @param root - remote absolute POSIX directory (the session cwd).
* @returns a `sh` script printing NUL-separated paths.
*/
function untrackedCommand(root) {
	return [cdLine(root), "git ls-files --others --exclude-standard -z -- ."].join("\n");
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
		results.set(path, {
			text: bytes.toString("utf8"),
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
/** Grace added to an exec budget before the watchdog gives up on it. */
const WATCHDOG_GRACE_MS = 5e3;
/** Sentinel for "the host call never came back". */
const WATCHDOG_FIRED = "watchdog-fired";
/** POSIX join — `node:path` would apply Windows semantics on the host. */
function posixJoin(base, rel) {
	if (rel.startsWith("/")) return rel;
	const left = base.endsWith("/") ? base.slice(0, -1) : base;
	const right = rel.startsWith("./") ? rel.slice(2) : rel;
	return right === "" ? left : `${left}/${right}`;
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
		ledger.turn = Math.max(ledger.turn, turn);
		this.schedule(ledger);
	}
	/** The current summary for one session, or null when it has no ledger. */
	summary(sessionId) {
		const ledger = this.ledgers.get(sessionId);
		if (ledger === void 0) return null;
		return {
			alias: ledger.alias,
			root: ledger.root,
			turn: ledger.turn,
			files: ledger.files,
			added: ledger.added,
			deleted: ledger.deleted,
			at: ledger.at,
			pending: ledger.untrackedJob !== void 0 || ledger.pending && ledger.files.length > 0,
			...ledger.truncated === true ? { truncated: true } : {},
			...ledger.unavailable === void 0 ? {} : { unavailable: ledger.unavailable }
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
		const fresh = await this.readPaths(ledger, [record.display], "worktree");
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
		const hunks = diffText(record.before ?? "", afterText ?? "").hunks.map((hunk) => ({
			oldStart: hunk.oldStart,
			oldCount: hunk.oldLines,
			newStart: hunk.newStart,
			newCount: hunk.newLines,
			heading: "",
			lines: hunk.lines,
			patch: hunkPatch(record.display, hunk)
		}));
		if (hunks.length === 0) return {
			kind: "missing",
			path,
			display: record.display,
			hunks: [],
			...status === void 0 ? {} : { status }
		};
		return {
			kind: "text",
			path,
			display: record.display,
			hunks,
			...status === void 0 ? {} : { status },
			...truncated ? { truncated: true } : {}
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
		ledger.untrackedAt = 0;
		this.schedule(ledger);
	}
	/**
	* Self-heal a ledger whose data has gone stale.
	*
	* The panel polls `list`, and a poll is the one moment we know a human is
	* looking at the answer. If the data is older than `maxAgeMs`, re-scan — so a
	* turn boundary this Host never delivered costs a few seconds of staleness
	* instead of a manual refresh.
	*
	* @returns whether a refresh was queued.
	*/
	touch(sessionId, maxAgeMs = 3e4) {
		const ledger = this.ledgers.get(sessionId);
		if (ledger === void 0 || ledger.disposed || ledger.pending) return false;
		if (ledger.at > 0 && Date.now() - ledger.at < maxAgeMs) return false;
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
		ledger.baseline = void 0;
		ledger.baselineTaken = false;
		ledger.adoptedSubdir = false;
		ledger.files = [];
		ledger.records = /* @__PURE__ */ new Map();
		ledger.added = 0;
		ledger.deleted = 0;
		ledger.at = 0;
		this.schedule(ledger);
	}
	/** Resolve the routing target once per session, caching the ledger. */
	ensure(target) {
		if (target.cwd.trim() === "") return void 0;
		const existing = this.ledgers.get(target.sessionId);
		if (existing !== void 0 && !existing.disposed && existing.root !== "") return existing;
		let route;
		try {
			route = this.deps.worlds.routeDir(target.cwd);
		} catch {
			return;
		}
		if (route.kind !== "remote") {
			this.ledgers.delete(target.sessionId);
			return;
		}
		const root = route.remotePath.length > 1 && route.remotePath.endsWith("/") ? route.remotePath.replace(/\/+$/, "") : route.remotePath;
		const ledger = {
			sessionId: target.sessionId,
			alias: route.alias,
			root,
			baseline: void 0,
			baselineTaken: false,
			untrackedGivenUp: false,
			startedAt: Date.now(),
			absorbed: false,
			adoptedSubdir: false,
			baseRoot: root,
			subdir: "",
			tracked: [],
			untracked: void 0,
			untrackedAt: 0,
			untrackedMs: void 0,
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
		const tracked = await this.scanTracked(ledger);
		if (ledger.disposed || tracked === void 0) return;
		ledger.tracked = tracked;
		await this.publish(ledger);
		this.kickUntracked(ledger);
	}
	/** Recompute the panel's list from the scans currently known. */
	async publish(ledger) {
		if (ledger.disposed) return;
		const merged = /* @__PURE__ */ new Map();
		for (const entry of ledger.tracked) merged.set(entry.path, entry);
		for (const entry of ledger.untracked ?? []) if (!merged.has(entry.path)) merged.set(entry.path, entry);
		const entries = [...merged.values()].sort((left, right) => left.path.localeCompare(right.path));
		const cap = this.deps.maxFiles ?? 500;
		const listed = entries.slice(0, cap);
		const truncated = entries.length > cap;
		if (!ledger.baselineTaken) {
			ledger.baseline = await this.readPaths(ledger, listed.map((entry) => entry.path), "worktree");
			if (ledger.disposed) return;
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
		if (ledger.disposed) return;
		const records = /* @__PURE__ */ new Map();
		const files = [];
		let added = 0;
		let deleted = 0;
		for (const entry of listed) {
			const beforeSide = baseline.get(entry.path) ?? head.get(entry.path);
			const afterSide = after.get(entry.path);
			const before = beforeSide?.text ?? null;
			const afterText = afterSide?.text ?? null;
			const binary = beforeSide?.binary === true || afterSide?.binary === true;
			const fileTruncated = beforeSide?.truncated === true || afterSide?.truncated === true;
			if (beforeSide?.absent === true && afterSide?.absent === true) continue;
			if (!binary && !fileTruncated && before === afterText) continue;
			if ((binary || fileTruncated) && sameStat(beforeSide, afterSide)) continue;
			const oversized = fileTruncated && !binary;
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
				truncated: fileTruncated
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
				...status === void 0 ? {} : { status }
			});
		}
		files.sort((left, right) => left.display.localeCompare(right.display));
		ledger.records = records;
		ledger.files = files;
		ledger.added = added;
		ledger.deleted = deleted;
		ledger.truncated = truncated ? true : void 0;
		ledger.unavailable = listed.length > 0 && after.size === 0 ? "file contents could not be read from the host" : void 0;
		ledger.at = Date.now();
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
	* @returns entries relative to the ledger's root, or undefined when no
	*   repository could be found (the ledger then reports why).
	*/
	async scanTracked(ledger) {
		const tracked = await this.run(ledger.alias, trackedStatusCommand(ledger.root));
		if (tracked.ok) {
			ledger.unavailable = void 0;
			return parseStatusZ(tracked.stdout);
		}
		if (tracked.code === 90 && ledger.subdir !== "") {
			this.warn(`repository directory "${ledger.subdir}" is missing on the host; falling back to the session root`);
			ledger.subdir = "";
			ledger.root = ledger.baseRoot;
			ledger.baseline = void 0;
			ledger.baselineTaken = false;
			const retry = await this.run(ledger.alias, trackedStatusCommand(ledger.root));
			if (retry.ok) {
				ledger.unavailable = void 0;
				return parseStatusZ(retry.stdout);
			}
			ledger.unavailable = retry.reason;
			return;
		}
		if (!ledger.adoptedSubdir) {
			if (await this.adoptRepositoryBelow(ledger) !== void 0) {
				const retry = await this.run(ledger.alias, trackedStatusCommand(ledger.root));
				if (retry.ok) {
					ledger.unavailable = void 0;
					return parseStatusZ(retry.stdout);
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
		ledger.root = `${ledger.root}/${found[0]}`;
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
		ledger.untrackedAt = Date.now();
		ledger.untrackedJob = (async () => {
			const started = Date.now();
			const scan = await this.run(ledger.alias, untrackedCommand(ledger.root), this.untrackedBudget());
			ledger.untrackedMs = Date.now() - started;
			if (ledger.disposed) return;
			if (!scan.ok) {
				ledger.untrackedGivenUp = true;
				this.warn(`untracked scan unusable (${scan.reason}); new files will not be listed`);
				return;
			}
			ledger.untracked = parseUntrackedZ(scan.stdout);
			await this.absorbPreExisting(ledger);
			await this.publish(ledger);
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
		const baseline = ledger.baseline ?? /* @__PURE__ */ new Map();
		ledger.baseline = baseline;
		const unknown = ledger.untracked.map((entry) => entry.path).filter((path) => !baseline.has(path));
		if (unknown.length === 0) return;
		const reads = await this.readPaths(ledger, unknown, "worktree");
		if (ledger.disposed) return;
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
	async readPaths(ledger, paths, side) {
		if (paths.length === 0) return /* @__PURE__ */ new Map();
		const perFile = this.deps.maxFileBytes ?? 256 * 1024;
		const total = this.deps.maxTotalBytes ?? 8 * 1024 * 1024;
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
				description: "Timeout in ms (default 60000, max 600000)."
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
			const timeoutMs = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) ? Math.min(Math.max(Math.floor(args.timeoutMs), 1e3), 6e5) : void 0;
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
			return new RemoteFiles(deps.pool).write(args.alias, args.path, args.content, "utf8");
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
	const { routes, upgrade, terminalSessions } = makeRoutes({
		store,
		pool,
		worlds,
		ctx,
		timeouts: resolveTimeoutsNow,
		changes
	});
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
		if (!value.enabled) return;
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
				terminalSessions.dispose();
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
	ctx.on("agent/created", (payload) => {
		if (payload.source !== "startup") return void 0;
		setTimeout(() => {
			(async () => {
				try {
					const presets = ctx.get("agentPresets");
					if (presets === void 0) return;
					if (worlds.mode !== "enforce") return;
					const current = presets.composedPreset(payload.agent.ctx);
					if (current !== presets.defaultId || current === "remote") return;
					const workingDirectory = ctx.get("workingDirectory");
					if (workingDirectory === void 0) return;
					let cwd;
					try {
						cwd = workingDirectory.get(payload.agent.session);
					} catch {
						return;
					}
					let remote = false;
					try {
						remote = worlds.routeDir(cwd).kind === "remote";
					} catch {
						return;
					}
					if (!remote) return;
					await presets.select(payload.agent, "remote");
					try {
						ctx.logger.info(`[remote-vs] new remote session entered ${cwd}; preset switched to remote`);
					} catch {}
				} catch (error) {
					if (error instanceof Error && /locked|already started/i.test(error.message)) return;
					try {
						ctx.logger.warn(`[remote-vs] preset auto-switch skipped: ${error instanceof Error ? error.message : String(error)}`);
					} catch {}
				}
			})();
		}, 2500).unref?.();
	});
	sync();
}
//#endregion
export { Config, apply, inject, name };
