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

import { createLogger, fauxModels, tempDir } from "./test-helpers.ts";
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
			seen = context; console.log(JSON.stringify(Object.keys(context)), context.tools?.length, context.systemPrompt?.slice(0,300));
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
	(context.tools ?? []).map((t) => t.name);
const descriptionOf = (context: ModelContext, name: string) =>
	context.tools?.find((t) => t.name === name)?.description;

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
		expect(context.systemPrompt).toContain("pit's instructions");
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
		expect(context.systemPrompt).toContain("first's pit section");
		expect(context.systemPrompt).not.toContain("pit's instructions");
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
