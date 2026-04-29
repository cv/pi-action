import { describe, expect, it } from "vitest";
import {
	formatErrorComment,
	formatReviewComments,
	formatSuccessComment,
} from "./formatting.js";

describe("formatSuccessComment", () => {
	it("formats response with pi emoji header", () => {
		const result = formatSuccessComment("Here is the answer");
		expect(result).toBe("### 🤖 pi Response\n\nHere is the answer");
	});

	it("formats response with session link", () => {
		const result = formatSuccessComment(
			"Here is the answer",
			"https://github.com/cv/pi-action/actions/runs/1",
		);
		expect(result).toBe(
			"### 🤖 pi Response\n\nHere is the answer\n\n---\n📎 [Download session artifact](https://github.com/cv/pi-action/actions/runs/1)",
		);
	});

	it("handles multiline responses", () => {
		const result = formatSuccessComment("Line 1\nLine 2\nLine 3");
		expect(result).toBe("### 🤖 pi Response\n\nLine 1\nLine 2\nLine 3");
	});

	it("handles empty response", () => {
		const result = formatSuccessComment("");
		expect(result).toBe("### 🤖 pi Response\n\n");
	});
});

describe("formatReviewComments", () => {
	it("returns empty string when there are no comments", () => {
		expect(formatReviewComments([])).toBe("");
	});

	it("formats PR review comments for prompt context", () => {
		const result = formatReviewComments([
			{
				id: 1,
				body: "Please simplify this",
				user: { login: "reviewer", type: "User" },
				path: "src/file.ts",
				line: 12,
				created_at: "2026-04-29T00:00:00Z",
			},
		]);

		expect(result).toContain("## Existing PR Review Comments");
		expect(result).toContain("Do not re-fetch them");
		expect(result).toContain("**reviewer** on 2026-04-29 (src/file.ts:12):");
		expect(result).toContain("Please simplify this");
	});
});

describe("formatErrorComment", () => {
	it("formats error with error emoji header", () => {
		const result = formatErrorComment("Something went wrong");
		expect(result).toBe(
			"### ❌ pi Error\n\nFailed to process request: Something went wrong",
		);
	});

	it("formats error with session link", () => {
		const result = formatErrorComment(
			"Something went wrong",
			"https://github.com/cv/pi-action/actions/runs/1",
		);
		expect(result).toBe(
			"### ❌ pi Error\n\nFailed to process request: Something went wrong\n\n---\n📎 [Download session artifact](https://github.com/cv/pi-action/actions/runs/1)",
		);
	});

	it("handles multiline errors", () => {
		const result = formatErrorComment("Error line 1\nError line 2");
		expect(result).toBe(
			"### ❌ pi Error\n\nFailed to process request: Error line 1\nError line 2",
		);
	});

	it("handles empty error", () => {
		const result = formatErrorComment("");
		expect(result).toBe("### ❌ pi Error\n\nFailed to process request: ");
	});
});
