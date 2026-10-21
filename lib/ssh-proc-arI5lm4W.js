import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough, Writable } from "node:stream";
import { SubprocessExecutableNotFoundError } from "@deepseek-ai/dsh-subprocess";
//#region src/p2/ssh-proc.ts
/**
* Remote subprocess runtime over ssh2 exec channels: stdout/stderr separation,
* collect-mode offset readers, stdin dispositions, TERM→KILL escalation and
* exit facts. No PTY, no control channel, no spill files in P2-v1 (honest
* limits, documented at each seam).
*
* Wrapper design (proven by .spike/dbg6 + dbg7 against util-linux 2.37.2):
*
* - `setsid --wait sh -c 'echo RV_PID=$$; exec "$@"' _ <argv...>` puts the
*   target in its own session/process group AND propagates its exit code.
*   Plain `setsid` (no --wait) double-forks: the outer shell exits at once
*   (target reparented to PPID=1) and the channel reports the outer shell's
*   exit 0 instead of the target's code — exit facts would be fiction.
* - Group kill (`kill -TERM -- -<pgid>`) is the ONLY reliable termination:
*   `channel.signal()` addresses the outer shell, which is useless once the
*   wrapper detaches. When the pgid is not learned yet, terminate() waits for
*   the marker (bounded) instead of signalling blindly.
* - Platforms without a compatible setsid fall back to a leader-only line
*   (`cd … && env … exec <argv...>`, no new session): channel.signal hits the
*   exec'd target directly. First failure auto-retries inside the same spawn;
*   later spawns skip setsid (self-healing, no caller-visible error).
*
* Managed range = the exec channel lifetime plus the target's process group.
* Double-fork daemons that escape the group survive termination (documented,
* same as Yan-Zero); waitForExit observes channel close.
*/
/** Single-quote one argv/env word for POSIX sh. */
function shq(word) {
	if (word.includes("\0")) throw new Error("NUL byte in spawn argument");
	return `'${word.replace(/'/g, `'\\''`)}'`;
}
/** Strip a Windows absolute executable to a remote-resolvable bare name. */
function remoteCommand(input) {
	return (input.replace(/\\/g, "/").split("/").pop() ?? input).replace(/\.exe$/i, "");
}
/** How long terminate() waits for the RV_PID marker before last-resort kill. */
const MARKER_TIMEOUT_MS = 8e3;
/** Safety net after KILL: force local channel close if sshd stays silent. */
const SAFETY_CLOSE_MS = 5e3;
/** Host-side spill dir for over-cap collected output (seam-internal, transient). */
function spillDir() {
	const dir = join(tmpdir(), "dsh-remote-spills");
	mkdirSync(dir, { recursive: true });
	return dir;
}
/** Best-effort TTL sweep: spills older than a day are dead (crashed owner). */
function sweepSpills(now) {
	let dir;
	try {
		dir = spillDir();
	} catch {
		return;
	}
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.startsWith("dsh-remote-spill-")) continue;
		try {
			if (now - statSync(join(dir, name)).mtimeMs > 24 * 3600 * 1e3) rmSync(join(dir, name), { force: true });
		} catch {}
	}
}
/**
* One collected stream: tail window + offset readers + optional full-stream
* spill file (Host disk). Mirrors the stock local runtime's contract
* (dsh-subprocess SubprocessCollect): with `spill` configured, overflow
* appends to the spill file; readFrom ALWAYS returns the tail window (with
* honest lossy flags) and attaches spillPath when the spill is intact — the
* complete stream lives in the FILE (read by model/tool via fs), never
* inline. Past spill.maxBytes the incomplete spill is discarded (tail only).
* Without `spill`, tail-only, no path (diagnostic-tail shape).
*/
var CollectStream = class {
	buffers = [];
	bufferedBytes = 0;
	totalBytes = 0;
	maxBytes;
	spillCap;
	streamName;
	spillPath;
	spillFd;
	spilledBytes = 0;
	spillDead = false;
	spillWarned = false;
	constructor(collect, streamName) {
		this.maxBytes = Math.max(1, Math.floor(collect.maxBytes));
		this.spillCap = collect.spill === void 0 ? void 0 : Math.max(1, Math.floor(collect.spill.maxBytes));
		this.streamName = streamName;
	}
	push(chunk) {
		if (this.spillCap !== void 0 && !this.spillDead) if (this.totalBytes + chunk.length > this.spillCap) this.discardSpill();
		else {
			if (this.spillPath === void 0 && this.bufferedBytes + chunk.length > this.maxBytes) {
				this.spillCreate();
				if (!this.spillDead) for (const b of this.buffers) this.spillWrite(b);
			}
			if (!this.spillDead) this.spillWrite(chunk);
		}
		this.totalBytes += chunk.length;
		this.buffers.push(chunk);
		this.bufferedBytes += chunk.length;
		while (this.bufferedBytes > this.maxBytes && this.buffers.length > 1) {
			const head = this.buffers.shift();
			this.bufferedBytes -= head.length;
		}
		if (this.bufferedBytes > this.maxBytes) {
			const only = this.buffers[0];
			this.buffers = [only.subarray(only.length - this.maxBytes)];
			this.bufferedBytes = this.buffers[0]?.length ?? 0;
		}
	}
	reader() {
		return { readFrom: (fromByte) => {
			const spill = this.spillPathNow();
			const windowStart = this.totalBytes - this.bufferedBytes;
			if (fromByte < windowStart) return {
				text: Buffer.concat(this.buffers).toString("utf8"),
				nextOffset: this.totalBytes,
				lossy: true,
				...spill === void 0 ? {} : { spillPath: spill }
			};
			return {
				text: Buffer.concat(this.buffers).subarray(Math.max(0, fromByte - windowStart)).toString("utf8"),
				nextOffset: this.totalBytes,
				lossy: false,
				...spill === void 0 ? {} : { spillPath: spill }
			};
		} };
	}
	/** Release the spill fd (the FILE persists for model readback; TTL-swept). */
	dispose() {
		if (this.spillFd !== void 0) {
			try {
				closeSync(this.spillFd);
			} catch {}
			this.spillFd = void 0;
		}
	}
	spillCreate() {
		try {
			sweepSpills(Date.now());
			const path = join(spillDir(), `dsh-remote-spill-${this.streamName}-${randomUUID()}.bin`);
			this.spillFd = openSync(path, "w");
			this.spillPath = path;
		} catch {
			this.warnSpill("cannot create spill file; degrading to tail-only");
			this.spillDead = true;
		}
	}
	spillWrite(chunk) {
		if (this.spillFd === void 0) return;
		try {
			writeSync(this.spillFd, chunk);
			this.spilledBytes += chunk.length;
		} catch {
			this.warnSpill("cannot append spill file; degrading to tail-only");
			this.discardSpill();
		}
	}
	discardSpill() {
		if (this.spillFd !== void 0) {
			try {
				closeSync(this.spillFd);
			} catch {}
			this.spillFd = void 0;
		}
		if (this.spillPath !== void 0) {
			try {
				rmSync(this.spillPath, { force: true });
			} catch {}
			this.spillPath = void 0;
		}
		this.spillDead = true;
	}
	/** Intact spill path, or undefined (discarded, unconfigured, or desynced). */
	spillPathNow() {
		if (this.spillPath === void 0 || this.spillDead) return void 0;
		if (this.spilledBytes !== this.totalBytes) return void 0;
		return this.spillPath;
	}
	warnSpill(message) {
		if (this.spillWarned) return;
		this.spillWarned = true;
		console.warn(`[dsh-remote-vs] ${message}`);
	}
};
function isCollect(mode) {
	return typeof mode === "object";
}
/** Build the remote shell line: cd + env + setsid --wait wrapper + argv. */
function buildCommand(spec) {
	const parts = [`cd ${shq(spec.cwd)}`, "&&"];
	const env = spec.env ?? {};
	const unsets = Object.entries(env).filter(([, value]) => value === void 0).map(([key]) => key);
	const sets = Object.entries(env).filter(([, value]) => value !== void 0);
	const inner = [];
	if (unsets.length > 0 || sets.length > 0) {
		inner.push("env");
		for (const key of unsets) inner.push("-u", key);
		for (const [key, value] of sets) inner.push(`${key}=${shq(value)}`);
	}
	inner.push(...spec.argv.map(shq));
	parts.push(`setsid --wait sh -c ${shq("echo RV_PID=$$; exec \"$@\"")} _ ${inner.join(" ")}`);
	if (spec.stdio.stdin === "ignore") parts.push("< /dev/null");
	return parts.join(" ");
}
/**
* Same line without setsid (platforms lacking it; leader-only range). `exec`
* replaces the outer shell so channel.signal addresses the target itself.
*/
function buildCommandNoSetsid(spec) {
	const parts = [`cd ${shq(spec.cwd)}`, "&&"];
	const env = spec.env ?? {};
	const unsets = Object.entries(env).filter(([, value]) => value === void 0).map(([key]) => key);
	const sets = Object.entries(env).filter(([, value]) => value !== void 0);
	if (unsets.length > 0 || sets.length > 0) {
		parts.push("env");
		for (const key of unsets) parts.push("-u", key);
		for (const [key, value] of sets) parts.push(`${key}=${shq(value)}`);
	}
	parts.push("exec", ...spec.argv.map(shq));
	if (spec.stdio.stdin === "ignore") parts.push("< /dev/null");
	return parts.join(" ");
}
var SshProcRuntime = class {
	pool;
	alias;
	live = /* @__PURE__ */ new Set();
	/** Whether the remote offers a compatible setsid(1); optimistic until disproven. */
	setsid;
	constructor(pool, alias) {
		this.pool = pool;
		this.alias = alias;
	}
	/** Resolve via remote `command -v` (Windows paths reduce to bare names). */
	async resolveExecutable(command) {
		const name = /^[A-Za-z]:[\\/]/.test(command) || command.includes("\\") ? remoteCommand(command) : command;
		const result = await this.pool.exec(this.alias, `command -v -- ${shq(name)}`, { timeoutMs: 15e3 });
		const resolved = result.stdout.trim().split("\n")[0]?.trim() ?? "";
		if (!result.success || resolved === "") throw new SubprocessExecutableNotFoundError(`remote executable not found: ${command}`);
		return resolved;
	}
	terminalEnvironment() {
		return {
			platform: "posix",
			defaultShell: "/bin/bash"
		};
	}
	/** Spawn one managed remote process. Throws synchronously on invalid spec. */
	spawn(spec) {
		if (spec.argv.length === 0 || typeof spec.argv[0] !== "string" || spec.argv[0] === "") throw new Error("spawn requires a non-empty argv[0]");
		if (typeof spec.cwd !== "string" || !spec.cwd.startsWith("/")) throw new Error(`remote spawn needs an absolute POSIX cwd, got: ${spec.cwd}`);
		if (!Number.isFinite(spec.graceMs) || spec.graceMs < 0) throw new Error(`remote spawn needs a non-negative graceMs, got: ${spec.graceMs}`);
		if (spec.stdio.control === "pipe") throw new Error("remote control channels are not implemented in P2-v1");
		if (spec.signal?.aborted === true) throw new Error("spawn aborted before start");
		const useSetsid = this.setsid ?? true;
		return new SshProcHandle(this.pool, this.alias, spec, useSetsid, () => {
			this.setsid = false;
		}, this.live);
	}
	/** Terminate every live remote process (service disposal). */
	async dispose() {
		const pending = [...this.live];
		this.live.clear();
		await Promise.allSettled(pending.map(async (terminate) => {
			try {
				terminate();
			} catch {}
		}));
	}
};
var SshProcHandle = class {
	pool;
	alias;
	spec;
	onSetsidMissing;
	stdin;
	stdout;
	stderr;
	control = void 0;
	collected;
	done;
	channel;
	settled = false;
	killRequested = false;
	terminating = false;
	killedSignal;
	termFired = false;
	useSetsid = true;
	retriedNoSetsid = false;
	pgid;
	pgidWaiters = [];
	markerPending = true;
	markerBuf = Buffer.alloc(0);
	stderrHead = "";
	outCollect;
	errCollect;
	outPipe;
	errPipe;
	stdoutStripped = new PassThrough();
	stdinFlush = () => {};
	abortListener;
	resolveDone;
	rejectDone;
	finish;
	constructor(pool, alias, spec, useSetsid, onSetsidMissing, live) {
		this.pool = pool;
		this.alias = alias;
		this.spec = spec;
		this.onSetsidMissing = onSetsidMissing;
		this.useSetsid = useSetsid;
		this.markerPending = useSetsid;
		const terminate = () => {
			this.terminate();
		};
		live.add(terminate);
		this.finish = () => {
			live.delete(terminate);
		};
		if (isCollect(spec.stdio.stdout)) this.outCollect = new CollectStream(spec.stdio.stdout, "stdout");
		else if (spec.stdio.stdout === "pipe") this.outPipe = new PassThrough();
		if (isCollect(spec.stdio.stderr)) this.errCollect = new CollectStream(spec.stdio.stderr, "stderr");
		else if (spec.stdio.stderr === "pipe") this.errPipe = new PassThrough();
		this.collected = {
			...this.outCollect !== void 0 ? { stdout: this.outCollect.reader() } : {},
			...this.errCollect !== void 0 ? { stderr: this.errCollect.reader() } : {}
		};
		let resolveDone;
		let rejectDone;
		this.done = new Promise((resolve, reject) => {
			resolveDone = resolve;
			rejectDone = reject;
		});
		this.resolveDone = resolveDone;
		this.rejectDone = rejectDone;
		this.done.catch(() => {});
		if (spec.signal !== void 0) {
			const onAbort = () => {
				this.terminate();
			};
			spec.signal.addEventListener("abort", onAbort, { once: true });
			this.abortListener = () => spec.signal?.removeEventListener("abort", onAbort);
		}
		if (spec.stdio.stdin === "pipe") {
			const pending = [];
			let ended = false;
			let bound;
			const flush = () => {
				const channel = bound ?? this.channel;
				if (channel === void 0) return;
				bound = channel;
				while (pending.length > 0) {
					const chunk = pending.shift();
					try {
						channel.write(chunk);
					} catch {}
				}
				if (ended) try {
					channel.end();
				} catch {}
			};
			this.stdinFlush = flush;
			this.stdin = new Writable({
				write(chunk, _encoding, callback) {
					pending.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
					flush();
					callback();
				},
				final(callback) {
					ended = true;
					flush();
					callback();
				}
			});
		} else this.stdin = void 0;
		this.stdout = this.outPipe;
		this.stderr = this.errPipe;
		const forward = (stream, mode, collect, pipe, host) => {
			stream.on("data", (chunk) => {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				if (collect !== void 0) collect.push(buffer);
				if (pipe !== void 0) pipe.write(buffer);
				if (mode === "inherit") try {
					host.write(buffer);
				} catch {}
			});
		};
		forward(this.stdoutStripped, spec.stdio.stdout, this.outCollect, this.outPipe, process.stdout);
		this.open();
	}
	/** Open the exec channel (once; setsid-incompatible remotes retry internally). */
	async open() {
		const { spec } = this;
		const stdinMode = spec.stdio.stdin;
		try {
			const channel = await this.pool.execChannel(this.alias, this.useSetsid ? buildCommand(spec) : buildCommandNoSetsid(spec));
			if (this.settled) {
				channel.close();
				return;
			}
			this.channel = channel;
			channel.on("data", (chunk) => {
				this.stripMarker(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			});
			channel.stderr.on("data", (chunk) => {
				if (this.stderrHead.length < 2048) this.stderrHead += chunk.toString("utf8").slice(0, 2048 - this.stderrHead.length);
			});
			const forwardErr = (chunk) => {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				if (this.errCollect !== void 0) this.errCollect.push(buffer);
				if (this.errPipe !== void 0) this.errPipe.write(buffer);
				if (spec.stdio.stderr === "inherit") try {
					process.stderr.write(buffer);
				} catch {}
			};
			channel.stderr.on("data", forwardErr);
			channel.on("close", (code, signalName) => {
				this.onClose(code, signalName);
			});
			channel.on("error", (error) => {
				this.fail(error);
			});
			if (this.killRequested) {
				this.terminate();
				return;
			}
			if (stdinMode === "ignore") try {
				channel.end();
			} catch {}
			else if (typeof stdinMode === "object") {
				try {
					channel.write(stdinMode.data);
				} catch {}
				try {
					channel.end();
				} catch {}
			} else this.stdinFlush();
		} catch (error) {
			this.fail(error);
		}
	}
	onClose(code, signalName) {
		if (this.useSetsid && this.pgid === void 0 && !this.retriedNoSetsid && /setsid/i.test(this.stderrHead)) {
			this.retriedNoSetsid = true;
			this.useSetsid = false;
			this.markerPending = false;
			this.onSetsidMissing();
			this.channel = void 0;
			this.stderrHead = "";
			this.open();
			return;
		}
		this.flushMarker();
		if (this.killedSignal !== void 0) {
			this.settle({
				exitCode: null,
				signal: this.killedSignal
			});
			return;
		}
		this.settle({
			exitCode: signalName !== void 0 && signalName !== null ? null : code ?? 0,
			signal: signalName !== void 0 && signalName !== null ? `SIG${signalName}` : null
		});
	}
	terminate() {
		this.killRequested = true;
		if (this.settled || this.terminating) return;
		if (this.channel === void 0) return;
		this.terminating = true;
		this.killedSignal = "SIGTERM";
		if (!this.useSetsid) {
			this.signalLeader("TERM");
			this.scheduleEscalation();
			return;
		}
		this.onPgidKnown(() => this.fireTerm());
		setTimeout(() => {
			if (!this.termFired && !this.settled) this.fallbackKill();
		}, MARKER_TIMEOUT_MS).unref?.();
		this.scheduleEscalation();
	}
	scheduleEscalation() {
		const grace = Math.min(Math.max(0, this.spec.graceMs), 2147483647);
		setTimeout(() => {
			if (this.settled) return;
			this.killedSignal = "SIGKILL";
			if (this.useSetsid) this.onPgidKnown(() => this.groupKill("KILL"));
			else this.signalLeader("KILL");
			setTimeout(() => {
				if (this.settled) return;
				try {
					this.channel?.close();
				} catch {}
			}, SAFETY_CLOSE_MS).unref?.();
		}, grace).unref?.();
	}
	fireTerm() {
		if (this.termFired || this.settled) return;
		this.termFired = true;
		this.groupKill("TERM");
	}
	/** Marker never arrived: last resort (channel signal + warn about orphans). */
	fallbackKill() {
		if (this.settled) return;
		this.termFired = true;
		try {
			this.channel?.signal("TERM");
		} catch {}
		console.warn(`[dsh-remote-vs] remote kill without pgid for ${this.alias} (marker missing): the wrapper chain was signalled but detached descendants may survive`);
	}
	groupKill(signal) {
		const pgid = this.pgid;
		if (pgid === void 0 || this.settled) return;
		this.pool.exec(this.alias, `kill -${signal} -- -${pgid}`, { timeoutMs: 15e3 }).catch(() => void 0);
	}
	signalLeader(signal) {
		try {
			this.channel?.signal(signal);
		} catch {}
	}
	/** Run cb now if the pgid is known, else when the marker lands. */
	onPgidKnown(cb) {
		if (this.pgid !== void 0) {
			cb();
			return;
		}
		this.pgidWaiters.push(cb);
	}
	/** Consume a leading `RV_PID=<pgid>` line; forward everything else. */
	stripMarker(chunk) {
		const out = this.stdoutStripped;
		if (!this.markerPending) {
			out.write(chunk);
			return;
		}
		this.markerBuf = Buffer.concat([this.markerBuf, chunk]);
		const newline = this.markerBuf.indexOf(10);
		if (newline === -1) {
			if (this.markerBuf.length > 1024) {
				this.markerPending = false;
				out.write(this.markerBuf);
				this.markerBuf = Buffer.alloc(0);
			}
			return;
		}
		const line = this.markerBuf.subarray(0, newline).toString("utf8").trim();
		const rest = this.markerBuf.subarray(newline + 1);
		this.markerBuf = Buffer.alloc(0);
		this.markerPending = false;
		const match = /^RV_PID=(\d+)$/.exec(line);
		if (match?.[1] !== void 0) {
			this.pgid = Number(match[1]);
			const waiters = this.pgidWaiters;
			this.pgidWaiters = [];
			for (const waiter of waiters) try {
				waiter();
			} catch {}
		} else {
			out.write(Buffer.concat([Buffer.from(`${line}\n`, "utf8"), rest]));
			return;
		}
		if (rest.length > 0) out.write(rest);
	}
	/** Flush a partial marker buffer at close (no pgid learned). */
	flushMarker() {
		if (this.markerBuf.length > 0) {
			this.stdoutStripped.write(this.markerBuf);
			this.markerBuf = Buffer.alloc(0);
		}
		this.markerPending = false;
	}
	async waitForExit(signal) {
		if (this.settled) return true;
		if (signal?.aborted === true) return false;
		return new Promise((resolve) => {
			const cleanup = () => {
				signal?.removeEventListener("abort", onAbort);
			};
			const onAbort = () => {
				cleanup();
				resolve(false);
			};
			this.done.then(() => {
				cleanup();
				resolve(true);
			}, () => {
				cleanup();
				resolve(true);
			});
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
	settle(outcome) {
		if (this.settled) return;
		this.settled = true;
		this.outPipe?.end();
		this.errPipe?.end();
		this.outCollect?.dispose();
		this.errCollect?.dispose();
		this.abortListener?.();
		this.resolveDone(outcome);
		this.finish();
	}
	fail(error) {
		if (this.settled) return;
		this.settled = true;
		this.outPipe?.destroy();
		this.errPipe?.destroy();
		this.outCollect?.dispose();
		this.errCollect?.dispose();
		try {
			this.channel?.close();
		} catch {}
		this.abortListener?.();
		this.rejectDone(error);
		this.finish();
	}
};
//#endregion
export { remoteCommand as n, SshProcRuntime as t };
