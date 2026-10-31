import { a as spillTtlDays, n as sessionSpillDir, t as runBestEffort } from "./spill-retention-BwKEWrl5.js";
import { randomUUID } from "node:crypto";
import { SpillLocator, SpillStore } from "@deepseek-ai/dsh-spill";
//#region src/p2/router-spill.ts
/**
* Transparent spill router: session-world-keyed delegation between the local
* spill backend (private realm) and per-host remote spill dirs. Unknown
* sessions stay local (system callers); tombstoned sessions fail closed and
* the caller keeps its inline result.
*
* Retention: the remote artifacts used to live forever (one file per oversized
* tool result, under `$HOME/.dsh-helpers/spills/session-<id>/`). They now get a
* TTL sweep once per host per process, plus a per-session check when the session
* is disposed — both best-effort, both outside the write's critical path (see
* `spill-retention.ts` for the commands and why they are safe to aim).
*/
/** Ceiling on tracked sessions, so a long-lived Host cannot grow this map forever. */
const TRACKED_SESSIONS_CAP = 200;
/** Sanitize a suggested name to one safe segment (backend owns the rest). */
function safeName(suggested) {
	const base = suggested.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
	return `${base === "" ? "spill" : base}-${randomUUID().slice(0, 8)}.txt`;
}
var TransparentSpillStore = class extends SpillStore {
	static inject = ["localSpillStore", "remoteWorlds"];
	/** Hosts already TTL-swept by THIS process (one `find` per host, not per spill). */
	sweptAliases = /* @__PURE__ */ new Set();
	/** session id -> directories written for it, for the best-effort dispose prune. */
	sessionDirs = /* @__PURE__ */ new Map();
	constructor(ctx) {
		super(ctx);
		/**
		* Session end is the one moment a spill directory is provably dead for the
		* session that wrote it. The check still requires the DIRECTORY to be older
		* than the TTL (`spillDirSweepCommand`), because `dsh-spill` states that a
		* forked session inherits its parent's locators without copying them — a
		* young directory may still be read by a live child.
		*/
		ctx.on("session/disposed", (session) => {
			this.pruneSession(String(session.id));
		});
	}
	get local() {
		return this.ctx.localSpillStore;
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
	async saveText(input) {
		const route = this.effective(this.remote.sessionWorld(input.owner.sessionId), `spill ${input.suggestedName ?? ""}`);
		if (route.kind === "local") return this.local.saveText(input);
		const fs = await this.remote.fsFor(route.alias);
		const home = await this.remote.homeFor(route.alias);
		await this.sweepOnce(route.alias, home);
		const dir = sessionSpillDir(home, input.owner.sessionId);
		await this.remote.mkdirRemote(route.alias, dir);
		const fullPath = `${dir}/${safeName(input.suggestedName ?? "spill.txt")}`;
		const target = await fs.resolve(fullPath, {});
		await fs.writeText(target, input.content, { kind: "createIfAbsent" }, void 0, this.policyFor(dir));
		this.remember(String(input.owner.sessionId), route.alias, dir);
		const bytes = Buffer.byteLength(input.content, "utf8");
		return {
			locator: SpillLocator(`remote:${route.alias}:${fullPath}`),
			bytes,
			retrievalHint: `remote spill on ${route.alias} (${bytes} bytes); read ${fullPath} with the read tool in this session`
		};
	}
	/** Explicit remote policy: mirrored mode, spill dir as the fence root. */
	policyFor(dir) {
		let mode = "danger-full-access";
		try {
			const resolved = this.ctx.get("sandboxPolicy")?.resolve?.()?.mode;
			if (resolved === "read-only" || resolved === "workspace-write" || resolved === "danger-full-access") mode = resolved;
		} catch {}
		return {
			mode,
			workspaceRoot: dir
		};
	}
	/**
	* Sweep one host's spill root once per process.
	*
	* The marker is set BEFORE awaiting so two concurrent first spills on the same
	* host cannot both issue the sweep; a failed sweep still leaves the host marked
	* (retention is a nicety, retrying it on every spill would be a tax).
	*/
	async sweepOnce(alias, home) {
		if (this.sweptAliases.has(alias)) return;
		this.sweptAliases.add(alias);
		await runBestEffort(`ttl sweep on ${alias}`, () => this.remote.sweepSpillRoot(alias, home, spillTtlDays()), (message) => this.warn(message));
	}
	/** Remember one written directory for the dispose prune (bounded, oldest first). */
	remember(sessionId, alias, dir) {
		const existing = this.sessionDirs.get(sessionId);
		if (existing === void 0) {
			if (this.sessionDirs.size >= TRACKED_SESSIONS_CAP) {
				const oldest = this.sessionDirs.keys().next().value;
				if (oldest !== void 0) this.sessionDirs.delete(oldest);
			}
			this.sessionDirs.set(sessionId, [{
				alias,
				dir
			}]);
			return;
		}
		if (!existing.some((record) => record.alias === alias && record.dir === dir)) existing.push({
			alias,
			dir
		});
	}
	/** Best-effort TTL check for the directories one session wrote. Never throws. */
	pruneSession(sessionId) {
		const records = this.sessionDirs.get(sessionId);
		if (records === void 0) return;
		this.sessionDirs.delete(sessionId);
		for (const record of records) runBestEffort(`session prune of ${record.dir}`, () => this.remote.sweepSpillDir(record.alias, record.dir, spillTtlDays()), (message) => this.warn(message));
	}
	warn(message) {
		try {
			this.ctx.logger.warn(`[remote-vs] ${message}`);
		} catch {}
	}
};
//#endregion
export { TransparentSpillStore as default };
