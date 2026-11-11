import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installAgentHooks } from "./install-agent-hooks.js";
import {
	appendIssueReference,
	issueNumberFromBranch,
} from "./prepare-commit-msg.js";

async function createRepository() {
	const directory = await mkdtemp(join(tmpdir(), "pi-action-hooks-"));
	execFileSync("git", ["init", "--quiet"], { cwd: directory });
	return directory;
}

describe("prepare-commit-msg", () => {
	it("extracts the first issue number", () => {
		expect(issueNumberFromBranch("fix/123-bug-456")).toBe("123");
		expect(issueNumberFromBranch("feature/no-issue")).toBeUndefined();
	});

	it("appends a missing issue reference", async () => {
		const directory = await createRepository();
		const messageFile = join(directory, "message");
		await writeFile(messageFile, "fix: correct bug\n");

		expect(await appendIssueReference(messageFile, "fix/123-bug")).toBe(true);
		expect(await readFile(messageFile, "utf8")).toBe(
			"fix: correct bug\n\nRefs #123\n",
		);
		expect(await appendIssueReference(messageFile, "fix/123-bug")).toBe(false);
	});

	it("ignores non-regular commits", async () => {
		const directory = await createRepository();
		const messageFile = join(directory, "message");
		await writeFile(messageFile, "Merge branch main\n");

		expect(
			await appendIssueReference(messageFile, "fix/123-bug", "merge"),
		).toBe(false);
		expect(await readFile(messageFile, "utf8")).toBe("Merge branch main\n");
	});
});

describe("install-agent-hooks", () => {
	it("installs executable hooks without replacing existing hooks", async () => {
		const directory = await createRepository();
		const installed = await installAgentHooks(directory);
		expect(installed).toHaveLength(2);

		const hooksDirectory = join(directory, ".git", "hooks");
		const commitHook = join(hooksDirectory, "commit-msg");
		const prepareHook = join(hooksDirectory, "prepare-commit-msg");
		expect((await stat(commitHook)).mode % 0o1000).toBeGreaterThanOrEqual(
			0o100,
		);

		const validMessage = join(directory, "valid-message");
		await writeFile(validMessage, "feat: add feature\n");
		expect(
			spawnSync(commitHook, [validMessage], { cwd: directory }).status,
		).toBe(0);

		const invalidMessage = join(directory, "invalid-message");
		await writeFile(invalidMessage, "not conventional\n");
		expect(
			spawnSync(commitHook, [invalidMessage], { cwd: directory }).status,
		).toBe(1);

		execFileSync("git", ["checkout", "-b", "fix/456-hook-test"], {
			cwd: directory,
		});
		await writeFile(validMessage, "fix: update hook\n");
		expect(
			spawnSync(prepareHook, [validMessage], { cwd: directory }).status,
		).toBe(0);
		expect(await readFile(validMessage, "utf8")).toContain("Refs #456");

		await installAgentHooks(directory);
		expect(await readFile(commitHook, "utf8")).toContain(
			"Conventional Commits",
		);
	});
});
