import { execFileSync, spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { claimRun, nestedRun, RUNNING_ENV } from "./nested-run.ts";

describe("claimRun", () => {
	it("marks the environment of a run, which its tools inherit", () => {
		const env: Record<string, string | undefined> = {};
		expect(claimRun(env, 123)).toBeUndefined();
		expect(env[RUNNING_ENV]).toBe("123");
		expect(nestedRun(env)).toContain(`${RUNNING_ENV}=123`);
	});

	it("refuses a run inside a run, and keeps the outer run's mark", () => {
		const env: Record<string, string | undefined> = { [RUNNING_ENV]: "7" };
		expect(claimRun(env, 123)).toBe(
			"pi-action is already running in this job (PI_ACTION_RUNNING=7). A run started from the agent's tools would change the thread of the run around it, so this one does nothing",
		);
		expect(env[RUNNING_ENV]).toBe("7");
	});

	it("ignores an empty mark", () => {
		expect(nestedRun({ [RUNNING_ENV]: "" })).toBeUndefined();
	});
});

// Only PATH and the mark: if the guard failed, the child would find no event, token, or inputs to act on.
const nestedEnv = { PATH: process.env["PATH"], [RUNNING_ENV]: "42" };
const node = (script: string) =>
	spawnSync(
		process.execPath,
		["--disable-warning=ExperimentalWarning", script],
		{ encoding: "utf8", env: nestedEnv, timeout: 20_000 },
	);

describe("the entry points inside a run", () => {
	it("src/index.ts fails at once and does nothing", () => {
		const result = node("src/index.ts");
		expect(result.status).toBe(1);
		expect(result.stdout).toContain(
			"::error::pi-action is already running in this job (PI_ACTION_RUNNING=42)",
		);
		expect(result.stdout).not.toContain("::group::");
	});

	it("src/push.ts pushes nothing", () => {
		const result = node("src/push.ts");
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			"::warning::Not saving the thread: pi-action is already running in this job (PI_ACTION_RUNNING=42)",
		);
	});

	it("leaves a run outside one alone", () => {
		const output = execFileSync(
			process.execPath,
			[
				"--disable-warning=ExperimentalWarning",
				"--input-type=module",
				"-e",
				'const { claimRun } = await import("./src/nested-run.ts"); console.log(String(claimRun(process.env)));',
			],
			{ encoding: "utf8", env: { PATH: process.env["PATH"] } },
		);
		expect(output.trim()).toBe("undefined");
	});
});
