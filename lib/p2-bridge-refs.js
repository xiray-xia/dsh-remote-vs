//#region src/p2/bridge-refs.ts
/** Stable cordis plugin name. */
const name = "dsh-remote-vs-p2-bridge-refs";
const inject = ["fileReferences"];
/** Publish the isolated local file-reference provider. */
function apply(ctx) {
	ctx.provide("localFileReferences", ctx.fileReferences);
}
//#endregion
export { apply, inject, name };
