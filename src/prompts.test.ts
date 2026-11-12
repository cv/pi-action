// oxlint-disable eslint/no-template-curly-in-string -- the tests are full of pi's ${...} template syntax
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	expandTrigger,
	loadPromptTemplates,
	parseArguments,
	stripFrontmatter,
	substituteArguments,
} from "./prompts.ts";
import { createLogger, tempDir, write } from "./test-helpers.ts";
import type { Trigger } from "./triggers.ts";

const trigger = (task: string, overrides: Partial<Trigger> = {}): Trigger => ({
	key: "comment-1",
	source: "comment",
	issueNumber: 1,
	author: { login: "alice", type: "User" },
	text: `@pi ${task}`,
	task,
	createdAt: "2026-01-01T00:00:00Z",
	...overrides,
});

const templates = new Map([
	[
		"review",
		{ name: "review", source: "pit", body: "Review $1, then ${@:2}." },
	],
]);

describe("parseArguments", () => {
	it.each([
		["", []],
		["a b\n c", ["a", "b", "c"]],
		[`"two words" 'and more' x"y z"`, ["two words", "and more", "xy z"]],
		[`'' end`, ["", "end"]],
	])("splits %o", (text, expected) => {
		expect(parseArguments(text)).toStrictEqual(expected);
	});
});

describe("substituteArguments", () => {
	it.each([
		["$1 and $2, not $3.", ["a", "b"], "a and b, not ."],
		["all: $ARGUMENTS | $@", ["a", "b"], "all: a b | a b"],
		["${@:2} / ${@:1:2} / ${@:0}", ["a", "b", "c"], "b c / a b / a b c"],
		["${ARGUMENTS:-everything} ${@:-x}", [], "everything x"],
		["${ARGUMENTS:-everything}", ["a"], "a"],
		["$1", ["$2 and $ARGUMENTS"], "$2 and $ARGUMENTS"],
	])("expands %o with %o", (body, args, expected) => {
		expect(substituteArguments(body, args)).toBe(expected);
	});
});

describe("stripFrontmatter", () => {
	it("removes the frontmatter, and only at the start", () => {
		expect(
			stripFrontmatter(
				"---\ndescription: x\nargument-hint: <a>\n---\n\nBody\n---\nmore\n",
			),
		).toBe("Body\n---\nmore");
		expect(stripFrontmatter("Body only\n")).toBe("Body only");
	});
});

describe("loadPromptTemplates", () => {
	it("loads files and directories in order; the first name wins", () => {
		const dir = tempDir();
		const first = join(dir, "first");
		write(join(first, "review.md"), "---\ndescription: d\n---\nReview it");
		write(join(first, "notes.txt"), "not a template");
		write(join(first, "nested", "deep.md"), "too deep");
		const second = join(dir, "second");
		write(join(second, "review.md"), "Another review");
		const single = write(join(dir, "single", "ship.md"), "Ship it");
		const log = createLogger();

		const loaded = loadPromptTemplates(
			[
				{ source: "pit", paths: [first, join(dir, "missing")] },
				{ source: ".pi/prompts", paths: [second, single] },
			],
			log,
		);

		expect([...loaded.values()]).toStrictEqual([
			{ name: "review", source: "pit", body: "Review it" },
			{ name: "ship", source: ".pi/prompts", body: "Ship it" },
		]);
		expect(log.warning).toHaveBeenCalledExactlyOnceWith(
			"Prompt template /review from .pi/prompts is ignored: pit has one with that name",
		);
	});
});

describe("expandTrigger", () => {
	it("replaces a task that starts with /<name> with the template, with its arguments", () => {
		expect(
			expandTrigger(trigger('/review src/a.ts "the tests" too'), templates),
		).toMatchObject({
			text: '@pi /review src/a.ts "the tests" too',
			task: "Review src/a.ts, then the tests too.",
			template: {
				name: "review",
				source: "pit",
				typed: '/review src/a.ts "the tests" too',
			},
		});
		expect(expandTrigger(trigger("/review"), templates).task).toBe(
			"Review , then .",
		);
	});

	it("leaves other tasks, unknown names, and answers alone", () => {
		for (const task of ["please /review", "/unknown x", "/review/x", ""]) {
			const plain = trigger(task);
			expect(expandTrigger(plain, templates)).toBe(plain);
		}
		const answer = trigger("/review x", {
			answer: {
				key: "k",
				kind: "input",
				answer: "/review x",
				by: "alice",
				url: "u",
				title: "t",
			},
		});
		expect(expandTrigger(answer, templates)).toBe(answer);
	});
});
