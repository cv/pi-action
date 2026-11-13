import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	getSystemMessageText,
	type Context as ModelContext,
	type ModelThinkingLevel,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	defineExtension,
	defineTool,
	type Extension,
	section,
	type ToolRegistration,
	wrapSection,
	wrapTool,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { describe, expect, it } from "vitest";

import { createBuiltinExtension } from "./builtin-extension.ts";
import { loadProjectContext } from "./context-files.ts";
import {
	createLogger,
	fauxModels,
	tempDir,
	tempRemote,
	toolsOf,
} from "./test-helpers.ts";
import { Thread, type ThreadOptions } from "./thread.ts";

const bash = (CodingTools.tools ?? []).find((tool) => tool.name === "bash");
if (bash === undefined) {
	throw new Error("CodingTools has no bash tool");
}

const tool = (name: string, description = name): ToolRegistration =>
	defineTool({
		name,
		description,
		parameters: { type: "object", properties: {} },
		execute: async () => ({ output: [{ type: "text", text: name }] }),
	});

/** A pit-like extension: a `typescript` tool and a `pit` section. */
const pit = defineExtension({
	name: "pit",
	tools: [tool("typescript")],
	sections: [section("pit", () => "pit's instructions")],
});

/** What the model sees in the first request of a one-off thread with `extensions`. */
async function firstRequest(
	extensions: readonly Extension[],
	options: Partial<ThreadOptions> = {},
): Promise<ModelContext> {
	const { faux, models, model } = fauxModels();
	let seen: ModelContext | undefined;
	faux.setResponses([
		(context) => {
			seen = context;
			return fauxAssistantMessage("ok");
		},
	]);
	const thread = await Thread.open({
		cwd: tempDir(),
		models,
		model,
		log: createLogger(),
		extensions,
		...options,
	});
	try {
		const submission = await thread.submit({
			key: "k",
			content: "hi",
			data: {},
		});
		await submission.wait(BACKGROUND_CONTEXT);
	} finally {
		await thread.close();
	}
	if (seen === undefined) {
		throw new Error("the model got no request");
	}
	return seen;
}

const toolNames = (context: ModelContext) =>
	toolsOf(context).map((t) => t.name);
const descriptionOf = (context: ModelContext, name: string) =>
	toolsOf(context).find((t) => t.name === name)?.description;
/** The system prompt and its sections, as JSON. */
const systemText = (context: ModelContext) =>
	JSON.stringify(context.messages.filter((m) => m.role === "system"));

/** The section keys of each system message the model saw, in order. */
const sectionKeys = (context: ModelContext) =>
	context.messages.flatMap((m) =>
		m.role === "system" ? [Object.keys(m.sections ?? {})] : [],
	);

/** The built-in `pi-action` extension, with these context files and no skills. */
const builtin = (projectContext?: string) =>
	createBuiltinExtension({ projectContext, skills: new Map() });

/** pit 0.36: its `typescript` tool, with the coding tools hidden from the model. */
const pitOnly = defineExtension({
	...pit,
	name: "pit-only",
	wraps: (CodingTools.tools ?? []).map((coding) =>
		wrapTool(coding, (t) => ({ ...t, callers: ["tools"] })),
	),
});

const PREAMBLE =
	"You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";
const DEFAULT_TOOL_LINES = [
	"- read: Read file contents",
	"- write: Create or overwrite files",
	"- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
	"- bash: Execute bash commands (ls, grep, find, etc.)",
];
const PIT_TOOL_LINE =
	"- typescript: Execute TypeScript with explicit function dependencies";
/** The `tools` section with these lines. */
const toolsSection = (lines: readonly string[]) =>
	`<tools>\n${lines.join("\n")}\n\nAdditional tools may be available.\n</tools>`;
const DEFAULT_TOOLS = toolsSection(DEFAULT_TOOL_LINES);
const DEFAULT_RULES = [
	"<rules>",
	"- Use bash for file operations like ls, rg, find",
	"- Use read to examine files instead of cat or sed.",
	"- Use write only for new files or complete rewrites.",
	"- Use edit for targeted changes. Batch changes to one file in a single call.",
	"- Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.",
	"- Be concise in your responses",
	"- Show file paths clearly when working with files",
	"</rules>",
].join("\n");
const PI_RULES =
	"- Be concise in your responses\n- Show file paths clearly when working with files";

/** The text of the first system message, as the model gets it. */
const systemPromptText = (context: ModelContext) => {
	const [first] = context.messages;
	return first?.role === "system" ? getSystemMessageText(first) : undefined;
};

/** The sections of the first system message. */
const sectionsOf = (context: ModelContext) => {
	const [first] = context.messages;
	return first?.role === "system" ? (first.sections ?? {}) : {};
};

describe("Thread: pi's system prompt sections (the built-in pi-action extension)", () => {
	it("renders pi's sections in pi's order, then the extensions' sections", async () => {
		const cwd = tempDir();
		const context = await firstRequest(
			[
				builtin("Project-specific instructions and guidelines:\n\nRepo rules."),
				pit,
			],
			{ cwd },
		);
		expect(sectionKeys(context)).toStrictEqual([
			["preamble", "tools", "rules", "project_context", "cwd", "pit"],
		]);
		expect(systemPromptText(context)).toBe(
			[
				PREAMBLE,
				toolsSection([...DEFAULT_TOOL_LINES, PIT_TOOL_LINE]),
				DEFAULT_RULES,
				"<project_context>\nProject-specific instructions and guidelines:\n\nRepo rules.\n</project_context>",
				`<cwd>\n${cwd}\n</cwd>`,
				"<pit>\npit's instructions\n</pit>",
			].join("\n\n"),
		);
		expect(context.messages[0]).toMatchObject({ role: "system", content: "" });
	});

	it("lists the default tools and pi's rules for them", async () => {
		const sections = sectionsOf(await firstRequest([builtin()]));
		expect(sections["preamble"]).toBe(PREAMBLE);
		expect(sections["tools"]).toBe(DEFAULT_TOOLS);
		expect(sections["rules"]).toBe(DEFAULT_RULES);
		expect(sections["project_context"]).toBeUndefined();
	});

	it("lists only pit's typescript tool when pit hides the coding tools, without pit's guidelines", async () => {
		const context = await firstRequest([builtin(), pitOnly]);
		expect(toolNames(context)).toStrictEqual(["typescript"]);
		const sections = sectionsOf(context);
		expect(sections["tools"]).toBe(toolsSection([PIT_TOOL_LINE]));
		expect(sections["rules"]).toBe(`<rules>\n${PI_RULES}\n</rules>`);
	});

	it("leaves out the tools of exclude_tools, and bash's rule without bash", async () => {
		const sections = sectionsOf(
			await firstRequest([builtin()], {
				tools: { exclude: ["bash"], hidden: [] },
			}),
		);
		expect(sections["tools"]).not.toContain("bash");
		expect(sections["tools"]).toContain("- edit: ");
		expect(sections["rules"]).not.toContain("Use bash");
		expect(sections["rules"]).toContain("Use read to examine files");
	});

	it("says (none) when no offered tool has a snippet", async () => {
		const custom = defineExtension({ name: "custom", tools: [tool("custom")] });
		const context = await firstRequest([builtin(), custom], {
			tools: { exclude: ["read", "write", "edit", "bash"], hidden: [] },
		});
		expect(toolNames(context)).toStrictEqual(["custom"]);
		const sections = sectionsOf(context);
		expect(sections["tools"]).toBe(toolsSection(["(none)"]));
		expect(sections["rules"]).toBe(`<rules>\n${PI_RULES}\n</rules>`);
	});

	it("does not change during a run, also when the agent edits AGENTS.md", async () => {
		const cwd = tempDir();
		writeFileSync(join(cwd, "AGENTS.md"), "Old rules.");
		const { text } = await loadProjectContext({
			cwd,
			workspace: undefined,
			agentDir: undefined,
			maxBytes: 65_536,
			log: createLogger(),
		});
		const { faux, models, model } = fauxModels();
		const seen: ModelContext[] = [];
		faux.setResponses([
			(context) => {
				seen.push(context);
				return fauxAssistantMessage(
					[fauxToolCall("write", { path: "AGENTS.md", content: "New rules." })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				seen.push(context);
				return fauxAssistantMessage("ok");
			},
		]);
		const thread = await Thread.open({
			cwd,
			models,
			model,
			log: createLogger(),
			extensions: [builtin(text), pit],
		});
		try {
			const submission = await thread.submit({
				key: "k",
				content: "hi",
				data: {},
			});
			await submission.wait(BACKGROUND_CONTEXT);
		} finally {
			await thread.close();
		}
		// One system message in both requests: no "Updated system prompt section" after the edit.
		const keys = [
			"preamble",
			"tools",
			"rules",
			"project_context",
			"cwd",
			"pit",
		];
		expect(seen.map((context) => sectionKeys(context))).toStrictEqual([
			[keys],
			[keys],
		]);
		const [first, second] = seen.map((context) => systemText(context));
		expect(second).toBe(first);
		expect(second).toContain("Old rules.");
		expect(second).not.toContain("New rules.");
	});

	it("lets an extension wrap a built-in section", async () => {
		const wrapper = defineExtension({
			name: "wrapper",
			wraps: [
				wrapSection("rules", (s) => ({ ...s, render: () => "my rules" })),
			],
		});
		const sections = sectionsOf(await firstRequest([builtin(), wrapper]));
		expect(sections["rules"]).toBe("<rules>\nmy rules\n</rules>");
	});
});

describe("Thread: extension overrides", () => {
	it("offers the coding tools, then each extension's tools", async () => {
		const context = await firstRequest([pit]);
		expect(toolNames(context)).toStrictEqual([
			"read",
			"write",
			"edit",
			"bash",
			"typescript",
		]);
		expect(systemText(context)).toContain("pit's instructions");
	});

	it("applies the wraps of every extension in input order: the last wrap wins", async () => {
		const first = defineExtension({
			name: "first",
			wraps: [
				wrapTool(bash, (t) => ({ ...t, description: "first's bash" })),
				wrapSection("pit", (s) => ({
					...s,
					render: () => "first's pit section",
				})),
			],
		});
		const second = defineExtension({
			name: "second",
			wraps: [wrapTool(bash, (t) => ({ ...t, description: "second's bash" }))],
		});

		const context = await firstRequest([pit, first, second]);

		expect(descriptionOf(context, "bash")).toBe("second's bash");
		expect(systemText(context)).toContain("first's pit section");
		expect(systemText(context)).not.toContain("pit's instructions");
	});

	it("lets a wrap hide a tool from the model (callers: tools)", async () => {
		const hide = defineExtension({
			name: "hide",
			wraps: [wrapTool(bash, (t) => ({ ...t, callers: ["tools"] }))],
		});
		const context = await firstRequest([pit, hide]);
		expect(toolNames(context)).toStrictEqual([
			"read",
			"write",
			"edit",
			"typescript",
		]);
	});

	it("lets a later extension's tool replace one of the same name", async () => {
		const replacement = defineExtension({
			name: "replacement",
			tools: [tool("bash", "a sandboxed bash")],
		});
		const context = await firstRequest([replacement]);
		expect(toolNames(context)).toStrictEqual(["read", "write", "edit", "bash"]);
		expect(descriptionOf(context, "bash")).toBe("a sandboxed bash");
	});
});

describe("Thread: the tools the model sees", () => {
	it("hides tools from the model and disables excluded ones, by glob", async () => {
		const log = createLogger();
		const context = await firstRequest([pit], {
			log,
			tools: { exclude: ["bash"], hidden: ["w*", "*dit", "nothing*"] },
		});
		expect(toolNames(context)).toStrictEqual(["read", "typescript"]);
		expect(log.warning).toHaveBeenCalledExactlyOnceWith(
			'model_tools_hidden: "nothing*" matches no tool',
		);
	});

	it("reports the tools the model gets", async () => {
		const { models, model } = fauxModels();
		const thread = await Thread.open({
			cwd: tempDir(),
			models,
			model,
			log: createLogger(),
			extensions: [pit],
			tools: { exclude: [], hidden: ["read", "write", "edit", "bash"] },
		});
		await thread.close();
		expect(thread.modelTools).toStrictEqual(["typescript"]);
	});

	it("fails when the model would get no tools", async () => {
		const { models, model } = fauxModels();
		await expect(
			Thread.open({
				cwd: tempDir(),
				models,
				model,
				log: createLogger(),
				tools: { exclude: ["bash"], hidden: ["*"] },
			}),
		).rejects.toThrow(
			"exclude_tools and model_tools_hidden leave the model with no tools (it would have read, write, edit, bash)",
		);
	});
});

/** The `reasoning` option of each request the faux provider gets while `thread` answers one input. */
async function ask(
	thread: Thread,
	faux: ReturnType<typeof fauxModels>["faux"],
	key: string,
): Promise<SimpleStreamOptions["reasoning"]> {
	let seen: SimpleStreamOptions | undefined;
	faux.setResponses([
		(_context, options) => {
			seen = options;
			return fauxAssistantMessage("ok");
		},
	]);
	const submission = await thread.submit({ key, content: "hi", data: {} });
	await submission.wait(BACKGROUND_CONTEXT);
	return seen?.reasoning;
}

describe("Thread: the thinking level", () => {
	async function oneRequest(
		thinkingLevel: ModelThinkingLevel | undefined,
		reasoning: boolean,
	) {
		const { faux, models, model } = fauxModels({ reasoning });
		const log = createLogger();
		const thread = await Thread.open({
			cwd: tempDir(),
			models,
			model,
			thinkingLevel,
			log,
		});
		try {
			return {
				reasoning: await ask(thread, faux, "k"),
				thinkingLevel: thread.thinkingLevel,
				log,
			};
		} finally {
			await thread.close();
		}
	}

	it("sends the level in the request options of a model with reasoning", async () => {
		const result = await oneRequest("high", true);
		expect(result.reasoning).toBe("high");
		expect(result.thinkingLevel).toBe("high");
		expect(result.log.info).not.toHaveBeenCalledWith(
			expect.stringContaining("thinking_level"),
		);
	});

	it("sends off to a model without reasoning, with a log line", async () => {
		const result = await oneRequest("medium", false);
		expect(result.reasoning).toBeUndefined();
		expect(result.thinkingLevel).toBe("off");
		expect(result.log.info).toHaveBeenCalledWith(
			expect.stringMatching(
				/^thinking_level: faux\S*\/\S+ has no reasoning support; using off$/u,
			),
		);
	});

	it("caps a level the model does not support, as pi does", async () => {
		// Without a thinkingLevelMap entry, xhigh is unsupported; the nearest level below it is high.
		const result = await oneRequest("xhigh", true);
		expect(result.reasoning).toBe("high");
		expect(result.log.info).toHaveBeenCalledWith(
			expect.stringMatching(
				/^thinking_level: faux\S*\/faux-reasoning does not support thinking level xhigh; using high$/u,
			),
		);
	});

	it("leaves the conversation's level (off) when none is given", async () => {
		const result = await oneRequest(undefined, true);
		expect(result.reasoning).toBeUndefined();
		expect(result.thinkingLevel).toBeUndefined();
	});

	it("switches a continuing thread to the level of the new run", async () => {
		const { faux, models, model } = fauxModels({ reasoning: true });
		const w = tempRemote();
		const open = async (cwd: string, thinkingLevel: ModelThinkingLevel) =>
			Thread.open({
				cwd,
				issueNumber: 7,
				models,
				model,
				thinkingLevel,
				log: createLogger(),
			});
		const first = await open(w.clone(), "low");
		const before = await ask(first, faux, "first");
		await first.close();
		const second = await open(w.clone(), "high");
		try {
			expect(second.isNew).toBe(false);
			expect(before).toBe("low");
			await expect(ask(second, faux, "second")).resolves.toBe("high");
		} finally {
			await second.close();
		}
	});
});
