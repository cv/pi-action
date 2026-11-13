import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	defineTool,
	type PromptInput,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import {
	BUILTIN_EXTENSION,
	BUILTIN_SECTIONS,
	createBuiltinExtension,
	formatRulesSection,
	formatToolsSection,
	PI_PROMPT_VERSION,
} from "./builtin-extension.ts";

const tool = (name: string, extra: object = {}): ToolRegistration => ({
	...defineTool({
		name,
		description: name,
		parameters: { type: "object", properties: {} },
		execute: async () => ({ output: [] }),
	}),
	...extra,
});

const MANIFEST = join(
	process.cwd(),
	"node_modules/@earendil-works/pi-durable/package.json",
);

describe("PI_PROMPT_VERSION", () => {
	it("is the installed pi version: compare the copied text with pi-coding-agent when pi changes", () => {
		const manifest: unknown = JSON.parse(readFileSync(MANIFEST, "utf8"));
		expect(manifest).toMatchObject({ version: PI_PROMPT_VERSION });
	});
});

describe("formatToolsSection", () => {
	it("lists the tools with a snippet, in order, or (none)", () => {
		expect(
			formatToolsSection([tool("bash"), tool("unknown"), tool("read")]),
		).toBe(
			"- bash: Execute bash commands (ls, grep, find, etc.)\n- read: Read file contents\n\nAdditional tools may be available.",
		);
		expect(formatToolsSection([tool("unknown")])).toBe(
			"(none)\n\nAdditional tools may be available.",
		);
	});

	it("uses a tool's own promptSnippet before the table", () => {
		expect(
			formatToolsSection([
				tool("read", { promptSnippet: "Read a file" }),
				tool("mine", { promptSnippet: "  Do my thing " }),
				tool("blank", { promptSnippet: " " }),
				tool("odd", { promptSnippet: 42 }),
			]),
		).toBe(
			"- read: Read a file\n- mine: Do my thing\n\nAdditional tools may be available.",
		);
	});
});

describe("formatRulesSection", () => {
	const PI_RULES = [
		"- Be concise in your responses",
		"- Show file paths clearly when working with files",
	];

	it("adds bash's file-operation rule only without grep, find, and ls", () => {
		expect(formatRulesSection([tool("bash")]).split("\n")).toStrictEqual([
			"- Use bash for file operations like ls, rg, find",
			...PI_RULES,
		]);
		for (const other of ["grep", "find", "ls"]) {
			expect(
				formatRulesSection([tool("bash"), tool(other)]).split("\n"),
			).toStrictEqual(PI_RULES);
		}
		expect(formatRulesSection([]).split("\n")).toStrictEqual(PI_RULES);
	});

	it("adds each tool's guidelines once, its own before the table's", () => {
		expect(
			formatRulesSection([
				tool("read"),
				tool("mine", {
					promptGuidelines: [
						" Use mine. ",
						"",
						7,
						"Be concise in your responses",
					],
				}),
				tool("again", { promptGuidelines: ["Use mine."] }),
				tool("write", { promptGuidelines: [] }),
				tool("odd", { promptGuidelines: "not a list" }),
			]).split("\n"),
		).toStrictEqual([
			"- Use read to examine files instead of cat or sed.",
			"- Use mine.",
			...PI_RULES,
		]);
	});
});

describe("createBuiltinExtension", () => {
	const render = async (
		options: Parameters<typeof createBuiltinExtension>[0],
		agent: Partial<PromptInput["agent"]>,
	) => {
		const extension = createBuiltinExtension(options);
		expect(extension.name).toBe(BUILTIN_EXTENSION);
		const sections = extension.sections ?? [];
		expect(sections.map((s) => s.key)).toStrictEqual([...BUILTIN_SECTIONS]);
		const input = { agent: { tools: [], ...agent } } as unknown as PromptInput;
		const rendered = new Map<
			string,
			{ text: string | undefined; tag: boolean | undefined }
		>();
		for (const s of sections) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- the sections render in order, as in a request
			rendered.set(s.key, { text: await s.render(input, BACKGROUND_CONTEXT), tag: s.tag });
		}
		return rendered;
	};

	it("renders the preamble untagged, the context files, and the cwd with slashes", async () => {
		const sections = await render(
			{ projectContext: "rules", skills: new Map() },
			{ cwd: String.raw`C:\work\xyz` },
		);
		expect(sections.get("preamble")).toStrictEqual({
			text: "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.",
			tag: false,
		});
		expect(sections.get("tools")?.tag).toBeUndefined();
		expect(sections.get("project_context")?.text).toBe("rules");
		expect(sections.get("available_skills")?.text).toBeUndefined();
		expect(sections.get("cwd")?.text).toBe("C:/work/xyz");
	});

	it("leaves out the context files and the cwd when there are none", async () => {
		const sections = await render({ skills: new Map() }, {});
		expect(sections.get("project_context")?.text).toBeUndefined();
		expect(sections.get("cwd")?.text).toBeUndefined();
	});
});
