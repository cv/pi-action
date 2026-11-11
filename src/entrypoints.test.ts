import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

// Vitest resolves "./x.js" to x.ts, but the action runs these files with plain Node (type stripping), which
// doesn't. Load every module the entrypoints reach the way the action does.
describe("entrypoints", () => {
	it("load under plain Node", () => {
		const output = execFileSync(
			process.execPath,
			[
				"--disable-warning=ExperimentalWarning",
				"--input-type=module",
				"-e",
				'await import("./src/action-inputs.ts"); await import("./src/run.ts"); await import("./src/push.ts"); console.log("ok");',
			],
			{ encoding: "utf8" },
		);
		expect(output.trim()).toBe("ok");
	});
});
