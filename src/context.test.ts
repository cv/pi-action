import { describe, expect, it } from "vitest";
import {
	buildPrompt,
	extractTask,
	hasTrigger,
	renderTemplate,
} from "./context.js";

describe("hasTrigger", () => {
	it("detects @pi at start", () => {
		expect(hasTrigger("@pi please help", "@pi")).toBe(true);
	});

	it("detects @pi in middle", () => {
		expect(hasTrigger("Hey @pi can you help?", "@pi")).toBe(true);
	});

	it("is case insensitive", () => {
		expect(hasTrigger("Hey @PI help me", "@pi")).toBe(true);
		expect(hasTrigger("Hey @Pi help me", "@pi")).toBe(true);
	});

	it("returns false when no trigger", () => {
		expect(hasTrigger("Hello world", "@pi")).toBe(false);
	});

	it("works with custom triggers", () => {
		expect(hasTrigger("Hey @assistant help", "@assistant")).toBe(true);
	});
});

describe("extractTask", () => {
	it("extracts text after trigger", () => {
		expect(extractTask("@pi please review this code", "@pi")).toBe(
			"please review this code",
		);
	});

	it("handles trigger at end", () => {
		expect(extractTask("Hey @pi", "@pi")).toBe("");
	});

	it("is case insensitive", () => {
		expect(extractTask("@PI do something", "@pi")).toBe("do something");
	});

	it("returns full text if no trigger", () => {
		expect(extractTask("no trigger here", "@pi")).toBe("no trigger here");
	});

	it("handles multiline", () => {
		expect(extractTask("@pi first line\nsecond line", "@pi")).toBe(
			"first line\nsecond line",
		);
	});
});

describe("renderTemplate", () => {
	const mockContext = {
		type: "issue" as const,
		title: "Bug Report",
		body: "Something is broken",
		number: 42,
		triggerComment: "@pi help",
		task: "help",
	};

	it("renders all variables correctly", () => {
		const template =
			"Type: {{type}}, Display: {{type_display}}, Number: {{number}}, Title: {{title}}, Body: {{body}}, Task: {{task}}, Comment: {{trigger_comment}}";
		const result = renderTemplate(template, mockContext);

		expect(result).toBe(
			"Type: issue, Display: Issue, Number: 42, Title: Bug Report, Body: Something is broken, Task: help, Comment: @pi help",
		);
	});

	it("handles diff variable for PR", () => {
		const prContext = {
			...mockContext,
			type: "pull_request" as const,
			diff: "+ added line\n- removed line",
		};
		const template = "{{type_display}} has diff: {{diff}}";
		const result = renderTemplate(template, prContext);

		expect(result).toBe("Pull Request has diff: + added line\n- removed line");
	});

	it("handles missing diff as empty string", () => {
		const template = "Diff: '{{diff}}'";
		const result = renderTemplate(template, mockContext);

		expect(result).toBe("Diff: ''");
	});

	it("handles multiple occurrences of same variable", () => {
		const template = "{{title}} - {{title}} - {{title}}";
		const result = renderTemplate(template, mockContext);

		expect(result).toBe("Bug Report - Bug Report - Bug Report");
	});
});

describe("buildPrompt", () => {
	it("builds issue prompt", () => {
		const prompt = buildPrompt({
			type: "issue",
			title: "Bug Report",
			body: "Something is broken",
			number: 42,
			triggerComment: "@pi help",
			task: "help",
		});

		expect(prompt).toContain("# GitHub Issue #42");
		expect(prompt).toContain("## Title\nBug Report");
		expect(prompt).toContain("## Description\nSomething is broken");
		expect(prompt).toContain("## Task\nhelp");
	});

	it("builds PR prompt with diff", () => {
		const prompt = buildPrompt({
			type: "pull_request",
			title: "Add feature",
			body: "New feature",
			number: 99,
			triggerComment: "@pi review",
			task: "review",
			diff: "+ new line\n- old line",
		});

		expect(prompt).toContain("# GitHub Pull Request #99");
		expect(prompt).toContain("```diff\n+ new line\n- old line\n```");
	});

	it("uses custom template when provided", () => {
		const customTemplate = "Custom: {{title}} - {{task}}";
		const prompt = buildPrompt(
			{
				type: "issue",
				title: "Bug Report",
				body: "Something is broken",
				number: 42,
				triggerComment: "@pi help",
				task: "help",
			},
			customTemplate,
		);

		expect(prompt).toBe("Custom: Bug Report - help");
	});

	it("falls back to default template when custom is empty", () => {
		const prompt = buildPrompt(
			{
				type: "issue",
				title: "Bug Report",
				body: "Something is broken",
				number: 42,
				triggerComment: "@pi help",
				task: "help",
			},
			"",
		);

		expect(prompt).toContain("# GitHub Issue #42");
	});
});
