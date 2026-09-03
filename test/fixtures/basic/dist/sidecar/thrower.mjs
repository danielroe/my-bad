//#region src/thrower.ts
var Widget = class {
	name;
	constructor(name) {
		this.name = name;
		if (!name) throw new TypeError("Widget needs a name");
	}
};
function makeWidget(name) {
	return new Widget(name);
}
async function loadWidget(name) {
	await Promise.resolve();
	return makeWidget(name);
}
async function withCause() {
	try {
		await loadWidget("");
	} catch (error) {
		throw new Error("Failed to load widget", { cause: error });
	}
	throw new Error("unreachable");
}
//#endregion
export { Widget, loadWidget, makeWidget, withCause };

//# sourceMappingURL=thrower.mjs.map