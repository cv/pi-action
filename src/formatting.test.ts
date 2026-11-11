import { describe, expect, it } from "vitest";
import { formatErrorComment, formatSuccessComment } from "./formatting.js";

const FOOTER_42 =
	"\n\n---\n<sub>🧵 Thread state: `refs/pi/threads/42` (`git fetch origin refs/pi/threads/42`)</sub>";

describe("formatSuccessComment", () => {
	it("formats response with pi emoji header", () => {
		const result = formatSuccessComment("Here is the answer");
		expect(result).toBe("### 🤖 pi Response\n\nHere is the answer");
	});

	it("adds a footer with the thread ref", () => {
		const result = formatSuccessComment("Here is the answer", {
			ref: "refs/pi/threads/42",
		});
		expect(result).toBe(`### 🤖 pi Response\n\nHere is the answer${FOOTER_42}`);
	});

	it("lists who it answers when there are several", () => {
		expect(formatSuccessComment("ok", { replyTo: ["alice", "bob"] })).toBe(
			"### 🤖 pi Response\n\nok\n\n---\n<sub>↩️ Answers @alice, @bob</sub>",
		);
		expect(formatSuccessComment("ok", { replyTo: ["alice"] })).toBe(
			"### 🤖 pi Response\n\nok",
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

describe("formatErrorComment", () => {
	it("formats error with error emoji header", () => {
		const result = formatErrorComment("Something went wrong");
		expect(result).toBe(
			"### ❌ pi Error\n\nFailed to process request: Something went wrong",
		);
	});

	it("adds a footer with the thread ref", () => {
		const result = formatErrorComment("Something went wrong", {
			ref: "refs/pi/threads/42",
		});
		expect(result).toBe(
			`### ❌ pi Error\n\nFailed to process request: Something went wrong${FOOTER_42}`,
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
