import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
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

import { createLogger, fauxModels, tempDir, toolsOf } from "./test-helpers.ts";
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
