//#region src/p2/bridge.ts
/** Stable cordis plugin name. */
const name = "dsh-remote-vs-p2-bridge";
const inject = [
	"fs",
	"subprocess",
	"spillStore"
];
/** Publish isolated local providers without changing their implementation. */
function apply(ctx) {
	ctx.provide("localFs", ctx.fs);
	ctx.provide("localSpillStore", ctx.spillStore);
	ctx.provide("localSubprocess", ctx.subprocess);
}
//#endregion
export { apply, inject, name };
