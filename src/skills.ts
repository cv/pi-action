// Agent Skills (https://agentskills.io), as in pi: directories with a SKILL.md, listed in the system prompt so the model
// reads one when a task matches it, and `/skill:<name>` to put a skill's instructions in the request.
import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { type PromptSection, section } from "@earendil-works/pi-durable";

import type { Trigger } from "./triggers.ts";
import type { Log } from "./types.ts";

/** Where skills come from: SKILL.md files, or directories searched for them. */
export interface SkillSource {
	/** Shown in the log: a package name, `project`, or `agent_dir`. */
	source: string;
	paths: readonly string[];
}

export interface Skill {
	name: string;
	description: string;
	/** The absolute path of its SKILL.md. */
	filePath: string;
	/** The skill's directory, which its relative paths are relative to. */
	baseDir: string;
	source: string;
	/** `disable-model-invocation: true`: not listed for the model, only `/skill:<name>`. */
	disableModelInvocation: boolean;
}

/** The skills by name: the first source with a name wins. */
export type Skills = ReadonlyMap<string, Skill>;

const SKILL_FILE = "SKILL.md";
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const FRONTMATTER = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/u;
const KEY = /^(?<key>[A-Za-z0-9_-]+):(?:[ \t]+(?<value>.*?))?[ \t]*$/u;
const BLOCK = /^[|>][+-]?$/u;
const INDENTED = /^[ \t]/u;
const INDENT = /^[ \t]*/u;
const LINE_BREAK = /\r?\n/u;
const COMMENT = /\s+#.*$/u;
const SKILL_COMMAND = /^\/skill:(?<name>\S*)(?:\s+(?<rest>[\s\S]*))?$/u;
const XML_SPECIAL = /[&<>"']/gu;
const XML_ENTITIES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&apos;",
};

/** A YAML scalar as written in one line: quotes removed, `'` and `"` escapes resolved, a trailing comment cut. */
function scalar(raw: string): string {
	if (raw.startsWith('"') && raw.endsWith('"') && raw.length > 1) {
		try {
			return String(JSON.parse(raw));
		} catch {
			return raw.slice(1, -1);
		}
	}
	if (raw.startsWith("'") && raw.endsWith("'") && raw.length > 1) {
		return raw.slice(1, -1).replaceAll("''", "'");
	}
	return raw.replace(COMMENT, "");
}

/** A block scalar's lines (`|` keeps line breaks, `>` folds them), without their common indentation. */
function blockScalar(style: string, lines: readonly string[]): string {
	const indents = lines
		.filter((line) => line.trim() !== "")
		.map((line) => INDENT.exec(line)?.[0].length ?? 0);
	const indent = Math.min(...indents);
	const text = lines.map((line) => line.slice(indent));
	if (style.startsWith("|")) {
		return text.join("\n").trim();
	}
	return text
		.join("\n")
		.split(/\n[ \t]*\n/u)
		.map((paragraph) => paragraph.replaceAll("\n", " ").trim())
		.join("\n")
		.trim();
}

/**
 * The top-level fields of a file's YAML frontmatter, as strings: `key: value`, quoted values, values that go on in
 * indented lines, and block scalars (`|`, `>`). Nested maps (`metadata:`) are left out. Undefined without frontmatter.
 */
export function parseFrontmatter(
	text: string,
): Map<string, string> | undefined {
	const yaml = FRONTMATTER.exec(text)?.groups?.["yaml"];
	if (yaml === undefined) {
		return undefined;
	}
	const fields = new Map<string, string>();
	const lines = yaml.split(LINE_BREAK);
	for (let index = 0; index < lines.length; index += 1) {
		const match = KEY.exec(lines[index] ?? "");
		if (match?.groups !== undefined) {
			const key = match.groups["key"] ?? "";
			const value = match.groups["value"] ?? "";
			const rest: string[] = [];
			while (index + 1 < lines.length) {
				const next = lines[index + 1] ?? "";
				if (!(INDENTED.test(next) || next.trim() === "")) {
					break;
				}
				rest.push(next);
				index += 1;
			}
			if (BLOCK.test(value)) {
				fields.set(key, blockScalar(value, rest));
			} else if (value !== "") {
				const more = rest.map((line) => line.trim()).filter(Boolean);
				fields.set(key, scalar([value, ...more].join(" ")));
			}
		}
	}
	return fields;
}

/** Whether a frontmatter flag is true (`true`, `yes`, `on`, in any case). */
function isTrue(value: string | undefined): boolean {
	return ["true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

function isDirectory(path: string): boolean {
	return existsSync(path) && statSync(path).isDirectory();
}

/**
 * The SKILL.md files at `path`: the file itself, or, in a directory, its SKILL.md, else the ones in its
 * subdirectories, recursively. A skill's own subdirectories are its resources, not skills. Hidden directories and
 * node_modules are skipped.
 */
function skillFiles(path: string, seen = new Set<string>()): string[] {
	if (!existsSync(path)) {
		return [];
	}
	if (!isDirectory(path)) {
		return basename(path) === SKILL_FILE ? [path] : [];
	}
	const real = realpathSync(path);
	if (seen.has(real)) {
		return [];
	}
	seen.add(real);
	const own = join(path, SKILL_FILE);
	if (existsSync(own) && !isDirectory(own)) {
		return [own];
	}
	return readdirSync(path)
		.filter((name) => !name.startsWith(".") && name !== "node_modules")
		.toSorted()
		.flatMap((name) => {
			const full = join(path, name);
			return isDirectory(full) ? skillFiles(full, seen) : [];
		});
}

/** Why a skill's frontmatter breaks the Agent Skills rules; undefined when it doesn't. */
function invalidReason(
	fields: ReadonlyMap<string, string> | undefined,
	dir: string,
): string | undefined {
	if (fields === undefined) {
		return "it has no frontmatter";
	}
	const name = fields.get("name") ?? "";
	const description = fields.get("description") ?? "";
	if (name === "") {
		return "it has no name";
	}
	if (name.length > MAX_NAME_LENGTH || !NAME.test(name)) {
		return `its name "${name}" must be at most ${MAX_NAME_LENGTH} characters of a-z, 0-9, and single hyphens inside`;
	}
	if (name !== basename(dir)) {
		return `its name "${name}" is not the name of its directory, ${basename(dir)}`;
	}
	if (description.trim() === "") {
		return "it has no description";
	}
	if (description.length > MAX_DESCRIPTION_LENGTH) {
		return `its description is longer than ${MAX_DESCRIPTION_LENGTH} characters`;
	}
	return undefined;
}

/**
 * Loads the skills of every source, in order. A skill whose frontmatter breaks the Agent Skills rules is skipped,
 * and when names collide, the first one wins; the log says which ones it skips.
 */
export function loadSkills(
	sources: readonly SkillSource[],
	log: Log,
): Map<string, Skill> {
	const skills = new Map<string, Skill>();
	for (const { source, paths } of sources) {
		for (const filePath of paths.flatMap((path) => skillFiles(path))) {
			const baseDir = dirname(filePath);
			const fields = parseFrontmatter(readFileSync(filePath, "utf8"));
			const reason = invalidReason(fields, baseDir);
			const name = fields?.get("name") ?? "";
			const taken = skills.get(name);
			if (reason !== undefined) {
				log.warning(`Skill ${filePath} from ${source} is skipped: ${reason}`);
			} else if (taken === undefined) {
				skills.set(name, {
					name,
					description: (fields?.get("description") ?? "").trim(),
					filePath,
					baseDir,
					source,
					disableModelInvocation: isTrue(
						fields?.get("disable-model-invocation"),
					),
				});
			} else {
				log.warning(
					`Skill ${name} from ${source} is ignored: ${taken.source} has one with that name`,
				);
			}
		}
	}
	return skills;
}

const escapeXml = (text: string): string =>
	text.replaceAll(XML_SPECIAL, (char) => XML_ENTITIES[char] ?? char);

/**
 * The text of the `available_skills` section: the skills the model may use, with how to read them (`read` names
 * the tool or function that reads a file). Undefined when there are none.
 */
export function formatSkillsSection(
	skills: Skills,
	read: string,
): string | undefined {
	const listed = [...skills.values()].filter(
		(skill) => !skill.disableModelInvocation,
	);
	if (listed.length === 0) {
		return undefined;
	}
	return [
		"The following skills provide specialized instructions for specific tasks.",
		`Use ${read} to load a skill's SKILL.md in full when the task matches its description.`,
		"Resolve relative paths in a skill against its directory.",
		"",
		...listed.flatMap((skill) => [
			"  <skill>",
			`    <name>${escapeXml(skill.name)}</name>`,
			`    <description>${escapeXml(skill.description)}</description>`,
			`    <location>${escapeXml(skill.filePath)}</location>`,
			"  </skill>",
		]),
	].join("\n");
}

/**
 * The `available_skills` section. It names the read tool, or pit's `workspace.read` when the model is offered
 * pit's `typescript` tool and no `read` tool. The text is the same for the whole run, so the prompt cache holds.
 */
export function skillsSection(skills: Skills): PromptSection {
	const rendered = new Map<string, string | undefined>();
	return section("available_skills", (input) => {
		const offered = new Set(input.agent.tools.map((tool) => tool.name));
		const read =
			!offered.has("read") && offered.has("typescript")
				? "workspace.read"
				: "the read tool";
		if (!rendered.has(read)) {
			rendered.set(read, formatSkillsSection(skills, read));
		}
		return rendered.get(read);
	});
}

/** A skill's instructions for a request: its SKILL.md without the frontmatter, with its directory, as in pi. */
export function skillMessage(skill: Skill, args: string): string {
	const body = readFileSync(skill.filePath, "utf8")
		.replace(FRONTMATTER, "")
		.trim();
	const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
	return args === "" ? block : `${block}\n\n${args}`;
}

/**
 * The trigger with its task expanded, when the task starts with `/skill:<name>`: the skill's instructions, then the
 * arguments. An unknown name rejects the trigger (`rejected`: the error to reply with); other tasks, and answers to
 * questions, stay as they are.
 */
export function expandSkill(trigger: Trigger, skills: Skills): Trigger {
	const match = trigger.answer
		? undefined
		: SKILL_COMMAND.exec(trigger.task.trim());
	if (match?.groups === undefined) {
		return trigger;
	}
	const name = match.groups["name"] ?? "";
	const skill = skills.get(name);
	if (skill === undefined) {
		const known = [...skills.keys()].map((other) => `\`${other}\``);
		return {
			...trigger,
			rejected: `There is no skill named \`${name}\`. ${known.length > 0 ? `Skills: ${known.join(", ")}.` : "No skills are loaded."} See https://github.com/cv/pi-action/blob/main/docs/skills.md`,
		};
	}
	return {
		...trigger,
		task: skillMessage(skill, (match.groups["rest"] ?? "").trim()),
		skill: { name: skill.name, source: skill.source, typed: trigger.task },
	};
}
