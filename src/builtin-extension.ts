// pi-action's own pi-durable extension: what pi's coding agent puts in its system prompt, for every conversation.
import {
	defineExtension,
	type Extension,
	type PromptSection,
	section,
	type ToolRegistration,
} from "@earendil-works/pi-durable";

import { PROJECT_CONTEXT_SECTION } from "./context-files.ts";
import { type Skills, skillsSection } from "./skills.ts";

/** The built-in extension's name, which pi-durable extensions from the `extensions` input can't take. */
export const BUILTIN_EXTENSION = "pi-action";

/** The pi version whose prompt text pi-action copies (`buildSystemPromptSections` in pi-coding-agent). */
export const PI_PROMPT_VERSION = "1.5.2";

/** The section keys of the built-in extension, in order, for `wrapSection`. */
export const BUILTIN_SECTIONS = [
	"preamble",
	"tools",
	"rules",
	PROJECT_CONTEXT_SECTION,
	"available_skills",
	"cwd",
] as const;

const PREAMBLE =
	"You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";

/** What a tool adds to the system prompt: one line in `tools`, and rules in `rules`. */
interface ToolPrompt {
	snippet?: string | undefined;
	guidelines?: readonly string[] | undefined;
}

/**
 * pi's text for its coding tools (pi-coding-agent's `*ToolSystemPromptContribution`). bash's guideline about the
 * `PI_*` variables is left out: pi-action doesn't set them. `typescript` is pit's tool, with pit's
 * `PROMPT_SNIPPET`; pit's own `pit_guidelines` section has its guidelines.
 */
const TOOL_PROMPTS: ReadonlyMap<string, ToolPrompt> = new Map([
	[
		"read",
		{
			snippet: "Read file contents",
			guidelines: ["Use read to examine files instead of cat or sed."],
		},
	],
	["bash", { snippet: "Execute bash commands (ls, grep, find, etc.)" }],
	[
		"edit",
		{
			snippet:
				"Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
			guidelines: [
				"Use edit for targeted changes. Batch changes to one file in a single call.",
				"Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.",
			],
		},
	],
	[
		"write",
		{
			snippet: "Create or overwrite files",
			guidelines: ["Use write only for new files or complete rewrites."],
		},
	],
	[
		"typescript",
		{ snippet: "Execute TypeScript with explicit function dependencies" },
	],
]);

/**
 * A tool's prompt text: its own `promptSnippet` and `promptGuidelines`, as pi's tool definitions have them, else
 * pi-action's table.
 */
function toolPrompt(tool: ToolRegistration): ToolPrompt {
	const known = TOOL_PROMPTS.get(tool.name);
	const snippet =
		"promptSnippet" in tool && typeof tool.promptSnippet === "string"
			? tool.promptSnippet
			: known?.snippet;
	const guidelines =
		"promptGuidelines" in tool && Array.isArray(tool.promptGuidelines)
			? tool.promptGuidelines.filter(
					(line): line is string => typeof line === "string",
				)
			: known?.guidelines;
	return { snippet, guidelines };
}

/** The `tools` section: one line for each offered tool with a snippet, as in pi. */
export function formatToolsSection(tools: readonly ToolRegistration[]): string {
	const lines = tools.flatMap((tool) => {
		const snippet = toolPrompt(tool).snippet?.trim();
		return snippet ? [`- ${tool.name}: ${snippet}`] : [];
	});
	const listed = lines.length > 0 ? lines.join("\n") : "(none)";
	return `${listed}\n\nAdditional tools may be available.`;
}

/** The `rules` section, as pi's `buildRules`: the file-operation rule, each tool's guidelines, then pi's two rules. */
export function formatRulesSection(tools: readonly ToolRegistration[]): string {
	const names = new Set(tools.map((tool) => tool.name));
	const rules = new Set<string>();
	const add = (rule: string) => {
		const trimmed = rule.trim();
		if (trimmed !== "") {
			rules.add(trimmed);
		}
	};
	if (
		names.has("bash") &&
		!names.has("grep") &&
		!names.has("find") &&
		!names.has("ls")
	) {
		add("Use bash for file operations like ls, rg, find");
	}
	for (const tool of tools) {
		for (const rule of toolPrompt(tool).guidelines ?? []) {
			add(rule);
		}
	}
	add("Be concise in your responses");
	add("Show file paths clearly when working with files");
	return [...rules].map((rule) => `- ${rule}`).join("\n");
}

export interface BuiltinExtensionOptions {
	/** The `project_context` section (see context-files.ts), read once for the run; none when undefined. */
	projectContext?: string | undefined;
	/** The run's skills, listed in the `available_skills` section. */
	skills: Skills;
}

/**
 * The built-in extension: pi's system prompt sections, in pi's order (see `BUILTIN_SECTIONS`), without pi's `docs`.
 * The `tools` and `rules` sections follow the tools the request offers (after `exclude_tools`, `model_tools_hidden`,
 * and the wraps), so they match the tools the model is declared. The text is the same for every request of a run, so
 * the prompt cache holds. It is installed after the coding tools and before the extensions of the `extensions` input,
 * so their wraps (`wrapSection("rules", ...)`) apply to it.
 */
export function createBuiltinExtension(
	options: BuiltinExtensionOptions,
): Extension {
	const sections: PromptSection[] = [
		section("preamble", () => PREAMBLE, { tag: false }),
		section("tools", (input) => formatToolsSection(input.agent.tools)),
		section("rules", (input) => formatRulesSection(input.agent.tools)),
		section(PROJECT_CONTEXT_SECTION, () => options.projectContext),
		skillsSection(options.skills),
		section("cwd", (input) => input.agent.cwd?.replaceAll("\\", "/")),
	];
	return defineExtension({ name: BUILTIN_EXTENSION, sections });
}
