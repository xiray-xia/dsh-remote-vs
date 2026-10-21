import { n as remoteCommand } from "./ssh-proc-arI5lm4W.js";
import { SubprocessExecutableNotFoundError, SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
//#region src/p2/router-subprocess.ts
/**
* Transparent subprocess router: cwd-keyed delegation between the local
* runtime (private realm) and per-host ssh runtimes. Handles are created by
* the chosen backend, so no handle mapping is needed; pwsh argv in a remote
* world fails closed with guidance instead of exit-127 confusion.
*/
/** True when argv selects PowerShell (remote worlds are POSIX-only). */
function isPwshArgv(argv) {
	if (argv.length === 0) return false;
	const base = argv[0].replace(/\\/g, "/").split("/").pop() ?? "";
	return /^pwsh(\.exe)?$/i.test(base);
}
var TransparentSubprocessRuntime = class extends SubprocessRuntime {
	static inject = ["localSubprocess", "remoteWorlds"];
	get local() {
		return this.ctx.localSubprocess;
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
	/**
	* Executable lookup stays local (the seam carries no cwd): a remote spawn
	* re-resolves in its own world. Mirrors the Yan-Zero rule.
	*/
	async resolveExecutable(command, env, signal) {
		return this.local.resolveExecutable(command, env, signal);
	}
	/** Provider environment facts stay local (used by local UI shell selection). */
	async terminalEnvironment(signal) {
		return this.local.terminalEnvironment(signal);
	}
	spawn(spec) {
		const route = this.effective(this.remote.routeDir(spec.cwd), `spawn ${spec.argv[0] ?? ""} @ ${spec.cwd}`);
		if (route.kind === "local") return this.local.spawn(spec);
		if (isPwshArgv(spec.argv)) throw new SubprocessExecutableNotFoundError(`remote worlds are POSIX-only: '${spec.argv[0]}' cannot run on ${route.alias}; use the bash tool (Remote preset) instead`);
		const runtime = this.remote.procFor(route.alias);
		const argv0 = spec.argv[0];
		const remoteArgv0 = argv0.startsWith("/") ? argv0 : /^[A-Za-z]:[\\/]/.test(argv0) || argv0.includes("\\") ? remoteCommand(argv0) : argv0;
		const cwd = this.remote.toRemotePath(route, spec.cwd);
		return runtime.spawn({
			...spec,
			argv: [remoteArgv0, ...spec.argv.slice(1)],
			cwd
		});
	}
	async spawnTerminal(spec) {
		if (this.effective(this.remote.routeDir(spec.cwd), `spawnTerminal @ ${spec.cwd}`).kind === "local") return this.local.spawnTerminal(spec);
		throw new Error("remote agent terminals are not implemented in P2-v1 (interactive remote shells live in the Remote tab); file/shell/subprocess routing is unaffected");
	}
};
//#endregion
export { TransparentSubprocessRuntime as default };
