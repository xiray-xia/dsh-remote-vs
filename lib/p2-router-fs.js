import { l as aliasRoot, n as isWindowsAbsolute } from "./worlds-PUumRIh7.js";
import { FileSystem, FsError } from "@deepseek-ai/dsh-fs";
//#region src/p2/router-fs.ts
/**
* Transparent filesystem router: cwd/path-keyed delegation between the local
* backend (private realm) and per-host helper fs views. Targets are tracked
* in a WeakMap (never mutated — the helper's strict schemas would reject
* extra fields); unknown targets fail closed.
*/
var TransparentFileSystem = class extends FileSystem {
	static inject = ["localFs", "remoteWorlds"];
	/** Target identity -> owning world (full route for policy rewrites). */
	worlds = /* @__PURE__ */ new WeakMap();
	/**
	* Hint for a target that was deliberately routed local from a remote session.
	*
	* The read tool observes absence through stat, which only ever receives the
	* resolved target — the original path and cwd are gone by then. So the note is
	* computed once, at resolve time, and carried on the target itself.
	*/
	missNotes = /* @__PURE__ */ new WeakMap();
	get localFs() {
		return this.ctx.localFs;
	}
	get remote() {
		return this.ctx.remoteWorlds;
	}
	get sandboxMode() {
		return this.localFs.sandboxMode;
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
	/**
	* True when the path sits under the alias root — the only place a remote
	* binding or a tombstone can live (every alias dir is `join(aliasRoot(), id)`,
	* and `store.removeWorkspace` tombstones the same way), so it is exactly the
	* input set whose route is not trivially local.
	*/
	underAliasRoot(path) {
		return path !== void 0 && this.remote.underAlias(aliasRoot(), path);
	}
	/**
	* Mode-gated route for one call. `off` discards the route anyway (see
	* `effective`), so computing it first — the argument-first idiom this used to
	* have — was pure waste on the root fs path. Only an alias-root cwd or path
	* can name a remote world, or a tombstoned one, and a tombstone must keep
	* failing closed (`worlds.routePath` throws), so that case still resolves;
	* everything else is local without touching the store. `enforce`/`shadow`
	* take the exact path they took before.
	*/
	routeFor(path, cwd, what) {
		if (this.remote.mode === "off" && !this.underAliasRoot(path) && !this.underAliasRoot(cwd)) return { kind: "local" };
		return this.effective(this.remote.routePath(path, cwd), what);
	}
	async backendOf(target) {
		const world = this.worlds.get(target);
		if (world === void 0) throw new FsError("unknown target world (not resolved through this router)", "FS_IO_ERROR");
		if (world.kind === "local") return {
			fs: this.localFs,
			world
		};
		return {
			fs: await this.remote.fsFor(world.alias),
			world
		};
	}
	/** Translate call cwd into the routed world (alias -> remote, else drop). */
	routeOpts(route, opts) {
		if (route.kind === "local" || opts?.cwd === void 0) return opts;
		const remoteCwd = this.cwdToRemote(route, opts.cwd);
		if (remoteCwd === void 0) {
			const { signal } = opts;
			return signal === void 0 ? void 0 : { signal };
		}
		return {
			...opts,
			cwd: remoteCwd
		};
	}
	cwdToRemote(route, cwd) {
		try {
			const check = this.remote.routeDir(cwd);
			if (check.kind === "remote" && check.id === route.id) return this.remote.toRemotePath(route, cwd);
			return;
		} catch {
			return;
		}
	}
	/**
	* Translate the call path into the routed world: alias-contained paths map
	* to remote absolutes; already-remote absolutes and relatives (resolved
	* against the translated cwd) pass through.
	*/
	routePathFor(route, path) {
		if (route.kind !== "local" && this.remote.underAlias(route.aliasPath, path)) return this.remote.toRemotePath(route, path);
		return path;
	}
	async resolve(path, opts) {
		const route = this.routeFor(path, opts?.cwd, `resolve ${path}`);
		const fs = route.kind === "local" ? this.localFs : await this.remote.fsFor(route.alias);
		try {
			const target = await fs.resolve(this.routePathFor(route, path), this.routeOpts(route, opts));
			this.worlds.set(target, route);
			const note = this.localMissNote(path, route, opts?.cwd);
			if (note !== void 0) this.missNotes.set(target, note);
			return target;
		} catch (error) {
			const note = this.localMissNote(path, route, opts?.cwd);
			if (note === void 0) throw error;
			const detail = error instanceof Error ? error.message : String(error);
			const original = error?.code;
			throw new FsError(`${detail}${note}`, original ?? "FS_IO_ERROR");
		}
	}
	/**
	* The explanatory suffix for the one genuinely confusing miss.
	*
	* `routePath` sends a Windows-absolute path outside the alias to the LOCAL
	* world deliberately: a `C:\…` path can never name a remote file, and the tool
	* seam's spill files genuinely live on the Host. But in a REMOTE session the
	* likely mistake is that the caller wrote the remote path with a drive letter
	* — `C:\opt\x` when it meant `/opt/x` — and a bare "not found" hides it.
	* Naming both working forms is the difference between a guess and a fix.
	*
	* Returns undefined when nothing about this call is confusing, so callers can
	* keep their normal behaviour untouched.
	*/
	localMissNote(path, route, cwd) {
		if (route.kind !== "local") return void 0;
		if (!isWindowsAbsolute(path)) return void 0;
		if (cwd === void 0 || cwd.trim() === "") return void 0;
		let remote;
		try {
			const byCwd = this.remote.routeDir(cwd);
			if (byCwd.kind !== "remote") return void 0;
			remote = byCwd;
		} catch {
			return;
		}
		const posix = `/${path.replace(/^[A-Za-z]:[\\/]/, "").split("\\").join("/")}`;
		return ` — this session works in the remote workspace "${remote.remotePath}", and "${path}" is a Windows-absolute path outside that workspace's local alias, so it was looked up on the Host. If you meant the remote file, pass "${posix}" or a path relative to the workspace.`;
	}
	processPath(target) {
		const world = this.worlds.get(target);
		if (world === void 0) throw new FsError("unknown target world (not resolved through this router)", "FS_IO_ERROR");
		if (world.kind === "local") return this.localFs.processPath(target);
		const fs = this.remote.cachedFs(world.alias);
		if (fs === void 0) throw new FsError(`remote fs view for ${world.alias} is not ready (resolve first)`, "FS_IO_ERROR");
		return this.remote.toSessionPath(world, fs.processPath(target));
	}
	processPathFromHostPath(hostPath) {
		try {
			if (this.remote.routeDir(hostPath).kind !== "local") return void 0;
		} catch {
			return;
		}
		return this.localFs.processPathFromHostPath(hostPath);
	}
	fileUrl(target) {
		const world = this.worlds.get(target);
		if (world === void 0) throw new FsError("unknown target world (not resolved through this router)", "FS_IO_ERROR");
		if (world.kind === "local") return this.localFs.fileUrl(target);
		const fs = this.remote.cachedFs(world.alias);
		if (fs === void 0) throw new FsError(`remote fs view for ${world.alias} is not ready (resolve first)`, "FS_IO_ERROR");
		return fs.fileUrl(target);
	}
	contains(parent, child) {
		const pw = this.worlds.get(parent);
		const cw = this.worlds.get(child);
		if (pw === void 0 || cw === void 0) return false;
		if (pw.kind !== cw.kind) return false;
		if (pw.kind === "local") return this.localFs.contains(parent, child);
		if (pw.id !== cw.id) return false;
		try {
			const left = this.processPath(parent);
			const right = this.processPath(child);
			return right === left || right.startsWith(left.endsWith("/") ? left : `${left}/`);
		} catch {
			return false;
		}
	}
	async stat(target, signal) {
		const { fs } = await this.backendOf(target);
		const info = await fs.stat(target, signal);
		if (info === void 0) {
			const note = this.missNotes.get(target);
			if (note !== void 0) throw new FsError(`not found${note}`, "FS_NOT_FOUND");
		}
		return info;
	}
	async lstat(path, opts, signal) {
		const route = this.routeFor(path, opts?.cwd, `lstat ${path}`);
		const fs = route.kind === "local" ? this.localFs : await this.remote.fsFor(route.alias);
		const routed = route.kind === "local" ? opts : this.routeOpts(route, opts);
		try {
			const info = await fs.lstat(this.routePathFor(route, path), routed, signal);
			if (info === void 0) {
				const note = this.localMissNote(path, route, opts?.cwd);
				if (note !== void 0) throw new FsError(`not found${note}`, "FS_NOT_FOUND");
			}
			return info;
		} catch (error) {
			if (error instanceof FsError) throw error;
			const note = this.localMissNote(path, route, opts?.cwd);
			if (note === void 0) throw error;
			throw new FsError(`${error instanceof Error ? error.message : String(error)}${note}`, "FS_IO_ERROR");
		}
	}
	async readText(target, signal) {
		const { fs } = await this.backendOf(target);
		return fs.readText(target, signal);
	}
	async streamText(target, signal) {
		const { fs } = await this.backendOf(target);
		return fs.streamText(target, signal);
	}
	async readBytes(target, signal, maxBytes) {
		const { fs } = await this.backendOf(target);
		return fs.readBytes(target, signal, maxBytes);
	}
	async readByteRange(target, range, signal) {
		const { fs } = await this.backendOf(target);
		return fs.readByteRange(target, range, signal);
	}
	async listDir(target, signal) {
		const { fs, world } = await this.backendOf(target);
		const entries = await fs.listDir(target, signal);
		for (const entry of entries) this.worlds.set(entry.target, world);
		return entries;
	}
	async writeText(target, content, expected, signal, sandboxPolicy) {
		const { fs, world } = await this.backendOf(target);
		return fs.writeText(target, content, expected, signal, this.remote.rewritePolicy(sandboxPolicy, world));
	}
	async editText(target, edit, expected, signal, sandboxPolicy) {
		const { fs, world } = await this.backendOf(target);
		return fs.editText(target, edit, expected, signal, this.remote.rewritePolicy(sandboxPolicy, world));
	}
	async watch(target, changed, signal) {
		const { fs } = await this.backendOf(target);
		return fs.watch(target, changed, signal);
	}
};
//#endregion
export { TransparentFileSystem as default };
