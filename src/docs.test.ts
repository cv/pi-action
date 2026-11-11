// Checks that keep the Markdown documentation honest: links and anchors resolve, the template variables that
// docs/prompts.md lists are the ones renderTemplate() replaces, and every `extensions:` example parses.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

import { describe, expect, it } from "vitest";

import { renderTemplate } from "./context.ts";
import { classifySpec } from "./extensions.ts";
import { parseExtensionSpecs } from "./inputs.ts";

const ROOT_DOCS = ["README.md", "CONTRIBUTING.md"];
const DOC_DIRS = ["docs", "examples"];
const FENCE_PATTERN = /^(\s*)```[^\n]*\n[\s\S]*?^\1```\s*$/gmu;
const INLINE_CODE_PATTERN = /`[^`\n]*`/gu;
const LINK_PATTERN = /\[[^\]]*\]\(([^)\s]+)\)/gu;
const EXTERNAL_PATTERN = /^(?:[a-z]+:|\/\/)/u;
const HEADING_PATTERN = /^#{1,6}\s+(.+?)\s*#*\s*$/gmu;
const SLUG_DROP_PATTERN = /[^\p{L}\p{N}\s_-]/gu;
const WHITESPACE_PATTERN = /\s/gu;
const VARIABLE_ROW_PATTERN = /^\| `\{\{(?<name>\w+)\}\}` \|/gmu;
const PLACEHOLDER_PATTERN = /\{\{\w+\}\}/u;
const EXTENSIONS_PATTERN =
	/^(?<indent>[ \t]*)extensions:[ \t]*(?:\|[ \t]*\n(?<block>(?:\k<indent>[ \t]+\S[^\n]*\n?)+)|(?<line>[^|\s][^\n]*)$)/gmu;

function markdownFiles(): string[] {
	return [
		...ROOT_DOCS,
		...DOC_DIRS.flatMap((dir) =>
			readdirSync(dir)
				.filter((name) => name.endsWith(".md"))
				.map((name) => join(dir, name)),
		),
	];
}

const read = (file: string): string => readFileSync(file, "utf8");

/** The text outside fenced code blocks, where headings are headings. */
const outsideFences = (markdown: string): string =>
	markdown.replaceAll(FENCE_PATTERN, "");

/** The text outside fenced code blocks and inline code, where links are links. */
const prose = (markdown: string): string =>
	outsideFences(markdown).replaceAll(INLINE_CODE_PATTERN, "");

/** GitHub's heading anchors: lowercase, punctuation dropped, spaces as hyphens, `-1`, `-2`... for repeats. */
function anchors(markdown: string): Set<string> {
	const seen = new Map<string, number>();
	const result = new Set<string>();
	for (const [, heading = ""] of outsideFences(markdown).matchAll(
		HEADING_PATTERN,
	)) {
		const slug = heading
			.replaceAll("`", "")
			.toLowerCase()
			.replaceAll(SLUG_DROP_PATTERN, "")
			.replaceAll(WHITESPACE_PATTERN, "-");
		const count = seen.get(slug) ?? 0;
		seen.set(slug, count + 1);
		result.add(count === 0 ? slug : `${slug}-${count}`);
	}
	return result;
}

/** Every relative link in a file that does not resolve to a file, or to a heading of a Markdown file. */
function brokenLinks(file: string): string[] {
	const text = read(file);
	return [...prose(text).matchAll(LINK_PATTERN)].flatMap(([, target = ""]) => {
		if (EXTERNAL_PATTERN.test(target)) {
			return [];
		}
		const [path = "", anchor] = target.split("#");
		const resolved = path === "" ? file : normalize(join(dirname(file), path));
		if (!existsSync(resolved)) {
			return [`${target} (no such file)`];
		}
		if (anchor === undefined || !resolved.endsWith(".md")) {
			return [];
		}
		const known = anchors(path === "" ? text : read(resolved));
		return known.has(anchor) ? [] : [`${target} (no such heading)`];
	});
}

/** The values of every `extensions:` input in the documentation's YAML examples (a block, or one line). */
function extensionExamples(): { file: string; value: string }[] {
	return markdownFiles().flatMap((file) =>
		[...read(file).matchAll(EXTENSIONS_PATTERN)].map((match) => ({
			file,
			value: match.groups?.["block"] ?? match.groups?.["line"] ?? "",
		})),
	);
}

/** The examples that would fail a run: no spec at all, or a spec pi-action rejects. */
function unparsableExtensionExamples(): string[] {
	return extensionExamples().flatMap(({ file, value }) => {
		const specs = parseExtensionSpecs(value);
		if (specs.length === 0) {
			return [`${file}: no extensions in ${JSON.stringify(value)}`];
		}
		return specs.flatMap((spec) => {
			try {
				classifySpec(spec, "/workspace");
				return [];
			} catch (error) {
				return [`${file}: ${String(error)}`];
			}
		});
	});
}

/** The variables in the table of docs/prompts.md. */
const documentedVariables = (): string[] =>
	[...read("docs/prompts.md").matchAll(VARIABLE_ROW_PATTERN)].map(
		(match) => match.groups?.["name"] ?? "",
	);

describe("documentation", () => {
	it.each(markdownFiles())("%s has no broken relative links", (file) => {
		expect(brokenLinks(file)).toStrictEqual([]);
	});

	it("replaces every template variable that docs/prompts.md lists", () => {
		const documented = documentedVariables();
		expect(documented.length).toBeGreaterThan(0);
		const rendered = renderTemplate(
			documented.map((name) => `{{${name}}}`).join("\n"),
			{
				type: "pull_request",
				title: "t",
				body: "b",
				number: 1,
				task: "k",
				triggerComment: "c",
				diff: "d",
				reviewComments: "r",
			},
		);
		expect(rendered).not.toMatch(PLACEHOLDER_PATTERN);
		expect(rendered.split("\n")).toHaveLength(documented.length);
	});

	it("has extensions examples that pi-action can parse", () => {
		expect(extensionExamples().length).toBeGreaterThan(0);
		expect(unparsableExtensionExamples()).toStrictEqual([]);
	});
});
