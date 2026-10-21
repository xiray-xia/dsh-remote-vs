import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
//#region src/p2/shell-bash.ts
/**
* Routed bash executor: the stock local bash executor with world-aware
* dispatch. Local worlds run unchanged; remote worlds strip host-local
* DSH_* facts and spawn through the (routed) subprocess service, which
* carries the call to the right host by workdir.
*
* Mounted inside preset-remote's isolated shell group alongside tool-bash;
* the stock root shell rows are untouched.
*/
var RoutedBashExecutor = class extends LocalBashExecutor {
	static inject = ["subprocess", "remoteWorlds"];
	get remote() {
		return this.ctx.remoteWorlds;
	}
	async execute(spec) {
		if (this.remote.routeDir(spec.workdir).kind === "local") return super.execute(spec);
		const { dshEnv: _dropped, ...rest } = spec;
		return super.execute(rest);
	}
};
//#endregion
export { RoutedBashExecutor as default };
