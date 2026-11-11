import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

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
				'await import("./src/inputs.ts"); await import("./src/run.ts"); await import("./src/push.ts"); console.log("ok");',
			],
			{ encoding: "utf8" },
		);
		expect(output.trim()).toBe("ok");
	});
});

// The target repository owns its commit conventions: no step may write to its .git/hooks or core.hooksPath.
describe("action.yml", () => {
	const action = readFileSync("action.yml", "utf8");
	const steps = action
		.split("\n")
		.filter((line) => line.trimStart().startsWith("run:"));
	const scripts = steps.flatMap((line) =>
		[...line.matchAll(/\$\{\{ github\.action_path \}\}\/(\S+)/gu)].flatMap(
			(match) => (match[1] ? [match[1]] : []),
		),
	);

	it("runs only scripts that exist", () => {
		expect(scripts).toStrictEqual(["src/index.ts", "src/push.ts"]);
		for (const script of scripts) {
			expect(existsSync(script)).toBe(true);
		}
	});

	it("installs no git hooks in the target repository", () => {
		const runs = action.slice(action.indexOf("\nruns:"));
		expect(runs).toContain("steps:");
		expect(runs).not.toMatch(/hook|core\.hooksPath|--git-path/iu);
	});
});
