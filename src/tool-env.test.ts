import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { tempDir, tempRepo } from "./test-helpers.ts";
import { ACTIONS_BOT, toolEnv } from "./tool-env.ts";

const BOT_IDENTITY = {
	GIT_AUTHOR_NAME: ACTIONS_BOT.name,
	GIT_AUTHOR_EMAIL: ACTIONS_BOT.email,
	GIT_COMMITTER_NAME: ACTIONS_BOT.name,
	GIT_COMMITTER_EMAIL: ACTIONS_BOT.email,
};

/** An environment whose git sees no global or system config (a runner's). */
function bareEnv(extra: Record<string, string> = {}) {
	const home = tempDir();
	const global = join(home, "gitconfig");
	writeFileSync(global, "");
	return {
		PATH: process.env["PATH"],
		HOME: home,
		GIT_CONFIG_GLOBAL: global,
		GIT_CONFIG_NOSYSTEM: "1",
		...extra,
	};
}

const noConfig = async () => undefined;

describe("toolEnv", () => {
	it("gives the tools GH_TOKEN and the github-actions[bot] identity on a bare runner", async () => {
		const { dir } = tempRepo();
		await expect(
			toolEnv({ token: "ghs_x", cwd: dir, env: bareEnv() }),
		).resolves.toStrictEqual({ GH_TOKEN: "ghs_x", ...BOT_IDENTITY });
	});

	it.each([
		{ env: { GH_TOKEN: "mine" }, token: "ghs_x", expected: undefined },
		{ env: { GITHUB_TOKEN: "mine" }, token: "ghs_x", expected: undefined },
		{ env: {}, token: undefined, expected: undefined },
		{ env: { GH_TOKEN: "" }, token: "ghs_x", expected: "ghs_x" },
	])(
		"keeps a token the workflow set, and needs one ($env, $token)",
		async ({ env, token, expected }) => {
			const vars = await toolEnv({
				token,
				cwd: "/",
				env,
				readConfig: noConfig,
			});
			expect(vars["GH_TOKEN"]).toBe(expected);
		},
	);

	it("keeps each identity variable the workflow set", async () => {
		await expect(
			toolEnv({
				token: undefined,
				cwd: "/",
				env: { GIT_AUTHOR_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" },
				readConfig: noConfig,
			}),
		).resolves.toStrictEqual({
			GIT_AUTHOR_EMAIL: ACTIONS_BOT.email,
			GIT_COMMITTER_NAME: ACTIONS_BOT.name,
		});
	});

	it("keeps the identity git is configured with", async () => {
		const repo = tempRepo();
		repo.git("config", "user.name", "Ada");
		const env = bareEnv();
		await expect(
			toolEnv({ token: undefined, cwd: repo.dir, env }),
		).resolves.toStrictEqual({
			GIT_AUTHOR_EMAIL: ACTIONS_BOT.email,
			GIT_COMMITTER_EMAIL: ACTIONS_BOT.email,
		});
		repo.git("config", "user.email", "ada@example.com");
		await expect(
			toolEnv({ token: undefined, cwd: repo.dir, env }),
		).resolves.toStrictEqual({});
	});

	it("works outside a git repository", async () => {
		const cwd = join(tempDir(), "missing");
		await expect(
			toolEnv({ token: undefined, cwd, env: bareEnv() }),
		).resolves.toStrictEqual(BOT_IDENTITY);
	});
});
