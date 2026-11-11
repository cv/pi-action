import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	appendIssueReference,
	issueNumberFromBranch,
} from "./prepare-commit-msg.js";

async function createRepository() {
	const directory = await mkdtemp(
		join(tmpdir(), "pi-action-prepare-commit-msg-"),
	);
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

		await expect(
			appendIssueReference(messageFile, "fix/123-bug"),
		).resolves.toBe(true);
		await expect(readFile(messageFile, "utf8")).resolves.toBe(
			"fix: correct bug\n\nRefs #123\n",
		);
		await expect(
			appendIssueReference(messageFile, "fix/123-bug"),
		).resolves.toBe(false);
	});

	it("ignores non-regular commits", async () => {
		const directory = await createRepository();
		const messageFile = join(directory, "message");
		await writeFile(messageFile, "Merge branch main\n");

		await expect(
			appendIssueReference(messageFile, "fix/123-bug", "merge"),
		).resolves.toBe(false);
		await expect(readFile(messageFile, "utf8")).resolves.toBe(
			"Merge branch main\n",
		);
	});
});
