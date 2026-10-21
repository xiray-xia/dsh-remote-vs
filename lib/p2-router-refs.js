import { FileReferenceService } from "@deepseek-ai/dsh-file-reference";
/** Mirrored stock exclusion list (order kept for diffability). */
const REMOTE_FILE_SEARCH_EXCLUDED_DIRECTORIES = [
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
/** Byte ceiling for one rg listing transfer (50k lines worst case). */
const RG_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
var RemoteFileSearch = class {
	deps;
	excluded;
	settled;
	pending;
	pendingAbort;
	/** Invalidation generation the pending scan belongs to (-1: none). */
	pendingGeneration = -1;
	disposed = false;
	/** Monotonic invalidation counter; a scan started below it is stale. */
	invalidations = 0;
	constructor(deps) {
		this.deps = deps;
		this.excluded = new Set(REMOTE_FILE_SEARCH_EXCLUDED_DIRECTORIES);
	}
	/**
	* Drop the cached index (tool activity); the next bare query rebuilds.
	*
	* Dropping — rather than keeping the entries and revalidating behind the
	* caret the way the stock local service does — is deliberate: nothing local
	* can tell whether a remote tree moved, so an index that could predate a
	* change must cost a rebuild instead of answering. For the same reason a
	* minimum rebuild interval is not used to coalesce a burst; the burst is
	* damped where it is generated, by invalidating for write-capable tools in
	* router-refs.ts.
	*
	* Aborting an in-flight scan is part of that: its result can no longer be
	* published, and a query arriving after this call must not join it.
	*/
	invalidate() {
		this.invalidations += 1;
		this.settled = void 0;
		if (this.pendingAbort !== void 0) {
			try {
				this.pendingAbort.abort(/* @__PURE__ */ new Error("file search index invalidated"));
			} catch {}
			this.pending = void 0;
			this.pendingAbort = void 0;
		}
	}
	dispose() {
		this.disposed = true;
		this.invalidate();
	}
	/** Ranked candidates for one @ token (mirrors WorkspaceFileSearch.list). */
	async list(rawQuery, signal) {
		signal.throwIfAborted();
		if (this.disposed) return [];
		const query = rawQuery.replaceAll("\\", "/");
		const slash = query.lastIndexOf("/");
		if (query === "" || slash >= 0) {
			const directory = slash < 0 ? "" : query.slice(0, slash + 1);
			const fragment = slash < 0 ? "" : query.slice(slash + 1);
			return this.listDirectory(directory, fragment, signal);
		}
		return rankCandidates((await this.indexFor(signal)).filter((c) => visibleForGlobalQuery(c.path, query)), query, 20);
	}
	/** Live single-level listing (one RPC; mirrors listDirectory exactly). */
	async listDirectory(displayDirectory, fragment, signal) {
		if (displayDirectory.split("/").some((segment) => this.excluded.has(segment))) return [];
		const absolute = joinRemote(this.deps.remoteRoot, displayDirectory);
		if (absolute === void 0) return [];
		let entries;
		try {
			const target = await this.deps.fs.resolve(absolute, {});
			entries = await this.deps.fs.listDir(target, signal);
		} catch {
			return [];
		}
		const candidates = [];
		for (const entry of entries) {
			if (entry.name.startsWith(".") && !fragment.startsWith(".")) continue;
			if (entry.type === "directory") {
				if (this.excluded.has(entry.name)) continue;
				candidates.push({
					path: `${displayDirectory}${entry.name}`,
					kind: "directory"
				});
			} else if (entry.type === "file") candidates.push({
				path: `${displayDirectory}${entry.name}`,
				kind: "file"
			});
		}
		return rankCandidates(candidates, fragment, 20);
	}
	/** Cached full listing; concurrent callers share one in-flight build. */
	async indexFor(signal) {
		if (this.settled !== void 0) return this.settled;
		if (this.pending === void 0 || this.pendingGeneration !== this.invalidations) {
			const controller = new AbortController();
			const startedAt = this.invalidations;
			this.pendingGeneration = startedAt;
			this.pendingAbort = controller;
			this.pending = this.buildIndex(controller.signal).then((entries) => {
				if (this.pendingAbort === controller) {
					this.pending = void 0;
					this.pendingAbort = void 0;
				}
				if (!this.disposed && this.invalidations === startedAt) this.settled = entries;
				return entries;
			}, (error) => {
				if (this.pendingAbort === controller) {
					this.pending = void 0;
					this.pendingAbort = void 0;
				}
				throw error;
			});
		}
		signal.throwIfAborted();
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				signal.removeEventListener("abort", onAbort);
				reject(signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("file search aborted"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			this.pending.then((entries) => {
				signal.removeEventListener("abort", onAbort);
				resolve(entries);
			}, (error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			});
		});
	}
	/** One remote `rg --files` run, head-capped, sorted for determinism. */
	async buildIndex(signal) {
		const globs = [];
		for (const name of this.excluded) globs.push(`--glob=!**/${name}`, `--glob=!**/${name}/**`);
		const argv = [
			"rg",
			"--no-config",
			"--files",
			"--no-ignore",
			"--hidden",
			...globs,
			"--",
			"."
		];
		let handle;
		try {
			handle = this.deps.spawn({
				argv,
				cwd: this.deps.remoteRoot,
				stdio: {
					stdin: "ignore",
					stdout: "pipe",
					stderr: { maxBytes: 4096 }
				},
				graceMs: 3e3,
				signal
			});
		} catch (error) {
			this.warn(`remote file index spawn failed: ${messageOf(error)}`);
			return [];
		}
		const lines = [];
		let bytes = 0;
		let truncated = false;
		try {
			const stdout = handle.stdout;
			if (stdout === void 0) handle.terminate();
			else {
				let carry = "";
				const onAbort = () => {
					try {
						handle.terminate();
					} catch {}
				};
				signal.addEventListener("abort", onAbort, { once: true });
				try {
					for await (const chunk of stdout) {
						const parts = (carry + (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))).split("\n");
						carry = parts.pop() ?? "";
						for (const line of parts) {
							const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
							if (clean === "") continue;
							bytes += Buffer.byteLength(clean, "utf8") + 1;
							if (lines.length >= 5e4 || bytes > RG_OUTPUT_MAX_BYTES) {
								truncated = true;
								break;
							}
							lines.push(clean);
						}
						if (truncated) break;
					}
					if (!truncated && carry !== "") {
						if (lines.length < 5e4 && bytes <= RG_OUTPUT_MAX_BYTES) lines.push(carry.endsWith("\r") ? carry.slice(0, -1) : carry);
					}
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
				signal.throwIfAborted();
				handle.terminate();
			}
			const outcome = await handle.done.catch(() => void 0);
			if (outcome !== void 0 && outcome.exitCode !== 0 && outcome.exitCode !== 1) {
				this.warn(`remote file index rg exited ${outcome.exitCode ?? outcome.signal}`);
				return [];
			}
		} catch (error) {
			try {
				handle.terminate();
			} catch {}
			if (signal.aborted) throw error;
			this.warn(`remote file index failed: ${messageOf(error)}`);
			return [];
		}
		const files = /* @__PURE__ */ new Set();
		for (let line of lines) {
			if (line.startsWith("./")) line = line.slice(2);
			if (line === "" || line === "." || line.startsWith("/")) continue;
			if (line.split("/").some((segment) => segment === "" || segment === "." || segment === ".." || this.excluded.has(segment))) continue;
			files.add(line);
		}
		const dirs = /* @__PURE__ */ new Set();
		for (const file of files) {
			const segments = file.split("/");
			for (let depth = 1; depth < segments.length; depth += 1) {
				const prefix = segments.slice(0, depth).join("/");
				const base = segments[depth - 1];
				if (!this.excluded.has(base)) dirs.add(prefix);
			}
		}
		const indexed = [...[...dirs].map((path) => ({
			path,
			kind: "directory"
		})), ...[...files].map((path) => ({
			path,
			kind: "file"
		}))];
		indexed.sort((a, b) => compareText(a.path, b.path));
		return indexed;
	}
	warn(message) {
		try {
			this.deps.warn?.(`[remote-refs] ${message}`);
		} catch {}
	}
};
/** Join a display dir under the remote root; undefined on jail escape. */
function joinRemote(root, display) {
	const out = [];
	for (const segment of display.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (out.length === 0) return void 0;
			out.pop();
			continue;
		}
		if (out.length === 0 && /^[A-Za-z]:/.test(segment)) return void 0;
		out.push(segment);
	}
	const base = root.endsWith("/") && root !== "/" ? root.slice(0, -1) : root;
	return out.length === 0 ? base : `${base}/${out.join("/")}`;
}
/** Ported scoring (dsh-file-reference-local rankCandidates family, exact). */
function rankCandidates(candidates, query, limit) {
	const ranked = [];
	for (const candidate of candidates) {
		const score = scoreCandidate(candidate, query);
		if (score !== void 0) ranked.push({
			candidate,
			score
		});
	}
	ranked.sort((left, right) => right.score - left.score || kindRank(left.candidate.kind) - kindRank(right.candidate.kind) || (query === "" ? 0 : left.candidate.path.length - right.candidate.path.length) || compareText(left.candidate.path, right.candidate.path));
	return ranked.slice(0, limit).map((entry) => entry.candidate);
}
function scoreCandidate(candidate, query) {
	if (query === "") return 0;
	const path = candidate.path.toLowerCase();
	const name = path.slice(path.lastIndexOf("/") + 1);
	const needle = query.toLowerCase();
	const directoryBonus = candidate.kind === "directory" ? 25 : 0;
	if (name === needle) return 1e3 + directoryBonus;
	if (name.startsWith(needle)) return 900 + directoryBonus;
	if (name.includes(needle)) return 700 + directoryBonus;
	if (path.includes(needle)) return 500 + directoryBonus;
	const subsequence = subsequenceScore(path, needle);
	return subsequence === void 0 ? void 0 : 300 + subsequence + directoryBonus;
}
function subsequenceScore(target, query) {
	let targetIndex = 0;
	let gap = 0;
	for (const character of query) {
		const found = target.indexOf(character, targetIndex);
		if (found < 0) return void 0;
		gap += found - targetIndex;
		targetIndex = found + 1;
	}
	return Math.max(0, 100 - gap);
}
function kindRank(kind) {
	return kind === "directory" ? 0 : 1;
}
function compareText(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}
function visibleForGlobalQuery(path, query) {
	if (query.startsWith(".") || query.includes("/.")) return true;
	return !path.split("/").some((segment) => segment.startsWith("."));
}
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
//#region src/p2/router-refs.ts
/**
* Transparent file-reference router: agent-world-keyed delegation between the
* stock local implementation (private realm) and per-host remote search. The
* stock row is prompt-complete (it installs the @ guidance section for every
* agent it sees), so this router only routes list() and never touches prompts.
*
* Reads are soft (ctx.get): declaring downstream services in inject would
* cycle startup (see the remote-vs inject comment). A missing workingDirectory
* degrades to the local implementation (which fails its own way if the
* composition is truly broken); tombstoned sessions throw fail-closed.
*/
/**
* Tools that only read the tree, so their result cannot have changed it.
*
* Deliberately a list of exemptions rather than a list of writers: a tool this
* build has never heard of keeps the stock behaviour and invalidates, which is
* what makes the narrowing safe — a bare query can never answer from an index
* that predates a possible change.
*/
const READ_ONLY_TOOLS = /* @__PURE__ */ new Set([
	"read",
	"read_image",
	"glob",
	"grep",
	"remote_ls",
	"remote_read"
]);
/** Ceiling for in-flight call bookkeeping; a settled call releases its slot. */
const PENDING_CALL_CAP = 256;
var TransparentFileReferences = class extends FileReferenceService {
	static inject = ["localFileReferences", "remoteWorlds"];
	/** Agent-scoped remote searchers (auto-released with their agents). */
	remoteSearches = /* @__PURE__ */ new WeakMap();
	/** `session + call id` -> tool name, for calls whose result is still to come. */
	pendingCalls = /* @__PURE__ */ new Map();
	constructor(ctx) {
		super(ctx);
		ctx.on("session/event", (session, event) => {
			try {
				if (event.type === "tool/call") {
					this.rememberCall(session.id, event.data.callId, event.data.name);
					return;
				}
				if (event.type !== "tool/result") return;
				if (this.isReadOnlyResult(session.id, event.data.message.toolCallId)) return;
				const agent = ctx.get("agents")?.get(session.id);
				if (agent === void 0) return;
				this.remoteSearches.get(agent)?.search.invalidate();
			} catch {}
		});
	}
	/**
	* Whether this result is positively known to come from a tree reader. A call
	* we never saw start, an unrecognized tool, or a payload that does not even
	* parse all answer "no": skipping the invalidation is only safe on proof, and
	* everything else must keep the guarantee that a bare query cannot answer
	* from an index older than the last possible change.
	*/
	isReadOnlyResult(sessionId, callId) {
		try {
			const tool = this.takeCall(sessionId, callId);
			return tool !== void 0 && READ_ONLY_TOOLS.has(tool);
		} catch {
			return false;
		}
	}
	/**
	* Remember which tool a call id belongs to. Keyed by session as well, because
	* a call id is only unique within the session that issued it — two sessions
	* (an agent and its teammate) can otherwise cross-talk and mask a write.
	*/
	rememberCall(sessionId, callId, tool) {
		if (this.pendingCalls.size >= PENDING_CALL_CAP) {
			const oldest = this.pendingCalls.keys().next().value;
			if (oldest !== void 0) this.pendingCalls.delete(oldest);
		}
		this.pendingCalls.set(`${sessionId}\u0000${callId}`, tool);
	}
	/** Name of the tool whose result this is (consume it: results arrive once). */
	takeCall(sessionId, callId) {
		const key = `${sessionId}\u0000${callId}`;
		const tool = this.pendingCalls.get(key);
		this.pendingCalls.delete(key);
		return tool;
	}
	get local() {
		return this.ctx.localFileReferences;
	}
	get remote() {
		return this.ctx.remoteWorlds;
	}
	effective(route, what) {
		const mode = this.remote.mode;
		if (mode === "off") return { kind: "local" };
		if (mode === "shadow") {
			this.remote.note(route, what);
			return { kind: "local" };
		}
		return route;
	}
	async list(agent, query, signal) {
		const workingDirectory = this.ctx.get("workingDirectory");
		if (workingDirectory === void 0) return this.local.list(agent, query, signal);
		let cwd;
		try {
			cwd = workingDirectory.get(agent.session);
		} catch {
			return this.local.list(agent, query, signal);
		}
		const route = this.effective(this.remote.routeDir(cwd), `@refs @ ${cwd}`);
		if (route.kind === "local") return this.local.list(agent, query, signal);
		return (await this.searchFor(agent, route)).list(query, signal);
	}
	/** Per-agent remote searcher, rebuilt when the binding changes. */
	async searchFor(agent, route) {
		const cached = this.remoteSearches.get(agent);
		if (cached !== void 0 && cached.routeId === route.id) return cached.search;
		cached?.search.dispose();
		const runtime = this.remote.procFor(route.alias);
		const search = new RemoteFileSearch({
			fs: await this.remote.fsFor(route.alias),
			spawn: (spec) => runtime.spawn(spec),
			remoteRoot: route.remotePath,
			warn: (message) => {
				try {
					this.ctx.logger.warn(message);
				} catch {}
			}
		});
		this.remoteSearches.set(agent, {
			routeId: route.id,
			search
		});
		return search;
	}
};
//#endregion
export { TransparentFileReferences as default };
