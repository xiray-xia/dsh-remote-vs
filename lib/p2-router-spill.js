import { randomUUID } from "node:crypto";
import { SpillLocator, SpillStore } from "@deepseek-ai/dsh-spill";
//#region src/p2/router-spill.ts
/**
* Transparent spill router: session-world-keyed delegation between the local
* spill backend (private realm) and per-host remote spill dirs. Unknown
* sessions stay local (system callers); tombstoned sessions fail closed and
* the caller keeps its inline result.
*/
/** Sanitize a suggested name to one safe segment (backend owns the rest). */
function safeName(suggested) {
	const base = suggested.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
	return `${base === "" ? "spill" : base}-${randomUUID().slice(0, 8)}.txt`;
}
var TransparentSpillStore = class extends SpillStore {
	static inject = ["localSpillStore", "remoteWorlds"];
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
		const dir = `${await this.remote.homeFor(route.alias)}/.dsh-helpers/spills/session-${input.owner.sessionId}`;
		await this.remote.mkdirRemote(route.alias, dir);
		const fullPath = `${dir}/${safeName(input.suggestedName ?? "spill.txt")}`;
		const target = await fs.resolve(fullPath, {});
		await fs.writeText(target, input.content, { kind: "createIfAbsent" }, void 0, this.policyFor(dir));
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
};
//#endregion
export { TransparentSpillStore as default };
