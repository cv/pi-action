import { describe, expect, it } from "vitest";

import {
	formatErrorComment,
	formatReviewComments,
	formatSuccessComment,
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
