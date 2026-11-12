// Prompt templates, as in pi: a request whose task starts with `/<name>` gets the template's body, with its arguments.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { Trigger } from "./triggers.ts";
import type { Log } from "./types.ts";

/** Where templates come from: Markdown files, or directories of them (one level deep). */
export interface PromptSource {
	/** Shown in the log: a package name, `.pi/prompts`, or `agent_dir`. */
	source: string;
	paths: readonly string[];
}

export interface PromptTemplate {
	name: string;
	source: string;
	/** The file without its frontmatter. */
	body: string;
}

/** The templates by name: the first source with a name wins. */
export type PromptTemplates = ReadonlyMap<string, PromptTemplate>;

const MARKDOWN = ".md";
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u;
const WHITESPACE = /\s/u;
const COMMAND = /^\/(?<name>[^\s/]+)(?:\s+(?<rest>[\s\S]*))?$/u;
const PLACEHOLDER =
	/\$\{@:(\d+)(?::(\d+))?\}|\$\{(?:ARGUMENTS|@):-([^}]*)\}|\$(ARGUMENTS|@|\d+)/gu;

/** The Markdown files at `path`: the file itself, or the ones in the directory. */
function markdownFiles(path: string): string[] {
	if (!existsSync(path)) {
		return [];
	}
	if (!statSync(path).isDirectory()) {
		return path.endsWith(MARKDOWN) ? [path] : [];
	}
	return readdirSync(path, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(MARKDOWN))
		.map((entry) => join(path, entry.name))
		.toSorted();
}

/** A template file's text without its YAML frontmatter (`description`, `argument-hint`, ...). */
export function stripFrontmatter(text: string): string {
	return text.replace(FRONTMATTER, "").trim();
}

/**
 * Loads the templates of every source, in order. The name is the file name without `.md`. When names collide, the
 * first one wins and the log says which ones it hides.
 */
export function loadPromptTemplates(
	sources: readonly PromptSource[],
	log: Log,
): Map<string, PromptTemplate> {
	const templates = new Map<string, PromptTemplate>();
	for (const { source, paths } of sources) {
		for (const file of paths.flatMap((path) => markdownFiles(path))) {
			const name = basename(file, MARKDOWN);
			const taken = templates.get(name);
			if (taken === undefined) {
				const body = stripFrontmatter(readFileSync(file, "utf8"));
				templates.set(name, { name, source, body });
			} else {
				log.warning(
					`Prompt template /${name} from ${source} is ignored: ${taken.source} has one with that name`,
				);
			}
		}
	}
	return templates;
}

/** The arguments of a template command, split as a shell would: on whitespace, with '...' and "..." kept whole. */
export function parseArguments(text: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: string | undefined;
	let started = false;
	for (const char of text) {
		if (quote !== undefined) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			quote = char;
			started = true;
		} else if (WHITESPACE.test(char)) {
			if (started) {
				args.push(current);
			}
			current = "";
			started = false;
		} else {
			current += char;
			started = true;
		}
	}
	if (started) {
		args.push(current);
	}
	return args;
}

/**
 * Puts the arguments into a template's body, in one pass (an argument that contains `$1` stays as it is): `$1`...
 * for one argument, `$ARGUMENTS` and `$@` for all, `${@:N}` for all from the Nth (`${@:N:L}`: L of them), and
 * `${ARGUMENTS:-default}` for all, or the default when there are none.
 */
export function substituteArguments(
	body: string,
	args: readonly string[],
): string {
	const all = args.join(" ");
	const expand = (
		_match: string,
		start: string | undefined,
		length: string | undefined,
		fallback: string | undefined,
		name: string | undefined,
	): string => {
		if (start !== undefined) {
			const from = Math.max(Number(start) - 1, 0);
			const to = length === undefined ? undefined : from + Number(length);
			return args.slice(from, to).join(" ");
		}
		if (fallback !== undefined) {
			return args.length > 0 ? all : fallback;
		}
		if (name === "ARGUMENTS" || name === "@") {
			return all;
		}
		return args[Number(name) - 1] ?? "";
	};
	return body.replaceAll(PLACEHOLDER, expand);
}

/**
 * The trigger with its task expanded, when the task starts with `/<name>` of a template; the trigger as it is
 * otherwise (an unknown `/name` stays text). Answers to questions are never templates.
 */
export function expandTrigger(
	trigger: Trigger,
	templates: PromptTemplates,
): Trigger {
	const match = trigger.answer ? undefined : COMMAND.exec(trigger.task.trim());
	const template = templates.get(match?.groups?.["name"] ?? "");
	if (template === undefined) {
		return trigger;
	}
	const args = parseArguments(match?.groups?.["rest"] ?? "");
	return {
		...trigger,
		task: substituteArguments(template.body, args),
		template: {
			name: template.name,
			source: template.source,
			typed: trigger.task,
		},
	};
}
