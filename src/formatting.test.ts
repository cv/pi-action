import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
	formatErrorComment,
	formatReviewComments,
	formatSuccessComment,
	formatThreadLog,
	formatThreadSummary,
} from "./formatting.ts";
import { createComment } from "./test-helpers.ts";

describe("formatSuccessComment / formatErrorComment", () => {
	it("puts a header over the text", () => {
		expect(formatSuccessComment("Line 1\nLine 2")).toBe(
			"### 🤖 pi Response\n\nLine 1\nLine 2",
		);
		expect(formatSuccessComment("")).toBe("### 🤖 pi Response\n\n");
		expect(formatErrorComment("Something went wrong")).toBe(
			"### ❌ pi Error\n\nFailed to process request: Something went wrong",
		);
	});

	it("adds the thread ref as a footer", () => {
		expect(formatSuccessComment("ok", "refs/pi/threads/42")).toBe(
			"### 🤖 pi Response\n\nok\n\n---\n🧵 Thread state: `refs/pi/threads/42` (`git fetch origin refs/pi/threads/42`)",
		);
		expect(formatErrorComment("no", "refs/pi/threads/7")).toBe(
			"### ❌ pi Error\n\nFailed to process request: no\n\n---\n🧵 Thread state: `refs/pi/threads/7` (`git fetch origin refs/pi/threads/7`)",
		);
	});
});

describe("formatThreadLog / formatThreadSummary", () => {
	const commands = [
		"git fetch upstream 'refs/pi/threads/42:refs/pi/threads/42'",
		"git log --oneline refs/pi/threads/42            # one commit for each stored step",
		"git show refs/pi/threads/42:batch.json | jq .   # the records of the newest step",
	];

	it("gives the commands of docs/threads.md for the ref and the remote", () => {
		expect(formatThreadLog("refs/pi/threads/42", "upstream")).toBe(
			[
				"This conversation is stored in git on refs/pi/threads/42. To read it:",
				...commands.map((command) => `  ${command}`),
				"See https://github.com/cv/pi-action/blob/main/docs/threads.md#read-a-thread",
			].join("\n"),
		);
		expect(formatThreadSummary("refs/pi/threads/42", "upstream")).toBe(
			[
				"### 🧵 pi thread",
				"",
				"This conversation is stored in git on `refs/pi/threads/42`. To read it ([more](https://github.com/cv/pi-action/blob/main/docs/threads.md#read-a-thread)):",
				"",
				"```bash",
				...commands,
				"```",
				"",
			].join("\n"),
		);
	});

	it("uses the same commands as docs/threads.md", () => {
		const docs = readFileSync(
			new URL("../docs/threads.md", import.meta.url),
			"utf8",
		);
		const sample = formatThreadSummary("refs/pi/threads/42", "origin");
		const block = /```bash\n(.*?)```/su.exec(sample)?.[1];
		expect(block).toBeDefined();
		expect(docs).toContain(block);
	});
});

describe("formatReviewComments", () => {
	it("returns empty string when there are no comments", () => {
		expect(formatReviewComments([])).toBe("");
	});

	it("formats PR review comments for prompt context", () => {
		const result = formatReviewComments([
			createComment({
				body: "Please simplify this",
				user: { login: "reviewer", type: "User" },
				path: "src/file.ts",
				line: 12,
				created_at: "2026-04-29T00:00:00Z",
			}),
			createComment({ body: null, user: null, path: "src/a.ts", line: null }),
		]);
		expect(result).toBe(
			[
				"## Existing PR Review Comments",
				"",
				"These comments were already present on the PR. Do not re-fetch them unless you need newer comments.",
				"",
				"**reviewer** on 2026-04-29 (src/file.ts:12):",
				"Please simplify this",
				"",
				"**ghost** on 2026-01-01:",
				"",
				"",
			].join("\n"),
		);
	});
});
