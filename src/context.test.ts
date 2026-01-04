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
	const context = {
		type: "issue" as const,
		title: "Test Issue",
		body: "Issue body",
		number: 42,
		triggerComment: "@pi help me",
		task: "help me",
		diff: undefined,
	};

	it("replaces all template variables", () => {
		const template = "{{type}} #{{number}}: {{title}} - {{task}}";
		const result = renderTemplate(template, context);
		expect(result).toBe("issue #42: Test Issue - help me");
	});

	it("handles type_display variable", () => {
		const template = "{{type_display}} {{number}}";
		const result = renderTemplate(template, context);
		expect(result).toBe("Issue 42");
	});

	it("handles PR type_display", () => {
		const template = "{{type_display}} {{number}}";
		const prContext = { ...context, type: "pull_request" as const };
		const result = renderTemplate(template, prContext);
		expect(result).toBe("Pull Request 42");
	});

	it("handles empty diff", () => {
		const template = "Diff: {{diff}}";
		const result = renderTemplate(template, context);
		expect(result).toBe("Diff: ");
	});

	it("handles diff with content", () => {
		const template = "Changes:\n{{diff}}";
		const contextWithDiff = { ...context, diff: "+ added line" };
		const result = renderTemplate(template, contextWithDiff);
		expect(result).toBe("Changes:\n+ added line");
	});

	it("leaves unknown placeholders unchanged", () => {
		const template = "{{unknown}} {{title}}";
		const result = renderTemplate(template, context);
		expect(result).toBe("{{unknown}} Test Issue");
	});

	it("handles multiple occurrences of same variable", () => {
		const template = "{{title}} - {{title}}";
		const result = renderTemplate(template, context);
		expect(result).toBe("Test Issue - Test Issue");
	});
});

describe("buildPrompt", () => {
	it("builds default issue prompt when no template provided", () => {
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

	it("builds default PR prompt with diff", () => {
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
		const customTemplate = "Task: {{task}} for {{type_display}} #{{number}}";
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

		expect(prompt).toBe("Task: help for Issue #42");
	});

	it("ignores empty custom template", () => {
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

	it("ignores whitespace-only custom template", () => {
		const prompt = buildPrompt(
			{
				type: "issue",
				title: "Bug Report",
				body: "Something is broken",
				number: 42,
				triggerComment: "@pi help",
				task: "help",
			},
			"   \n  ",
		);

		expect(prompt).toContain("# GitHub Issue #42");
	});
});
