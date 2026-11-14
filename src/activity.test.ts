import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import {
	Activity,
	describeCall,
	formatArguments,
	formatDuration,
	formatStats,
	oneLine,
} from "./activity.ts";

/** An Activity whose log is a list of lines (`::group::<name>`, `::endgroup::`), with a clock the test moves. */
function recorder() {
	const lines: string[] = [];
	let time = 1000;
	const activity = new Activity(
		{
			info: (line) => {
				lines.push(line);
			},
			startGroup: (name) => {
				lines.push(`::group::${name}`);
			},
			endGroup: () => {
				lines.push("::endgroup::");
			},
		},
		() => time,
	);
	return {
		lines,
		activity,
		tick: (ms: number) => {
			time += ms;
		},
	};
}

const usage = (input: number, output: number, cost = 0) => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + output,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: cost,
	},
});

let nextId = 1;
const PADDING = "y".repeat(5000);

function assistant(
	content: unknown[],
	extra: Record<string, unknown> = {},
): EntryRecord {
	nextId += 1;
	return {
		id: nextId,
		conversationId: 1,
		kind: "pi.assistant",
		model: [
			{
				role: "assistant",
				content,
				api: "faux",
				provider: "faux",
				model: "m",
				usage: usage(100, 10, 0.25),
				stopReason: "toolUse",
				timestamp: 0,
				...extra,
			},
		],
	} as unknown as EntryRecord;
}

function toolResult(
	toolCallId: string,
	text: string,
	extra: Record<string, unknown> = {},
): EntryRecord {
	nextId += 1;
	return {
		id: nextId,
		conversationId: 1,
		kind: "pi.tool-result",
		model: [
			{
				role: "toolResult",
				toolCallId,
				toolName: "bash",
				content: [{ type: "text", text }],
				isError: false,
				timestamp: 0,
				...extra,
			},
		],
	} as unknown as EntryRecord;
}

const call = (id: string, name: string, args: Record<string, unknown>) => ({
	type: "toolCall",
	id,
	name,
	arguments: args,
});

describe("describeCall", () => {
	it("shows the argument that says what the call does", () => {
		expect(describeCall("bash", { command: "npm  test" })).toBe(
			"bash: npm test",
		);
		expect(
			describeCall("bash", { command: "python3 - <<'EOF'\nprint(1)\nEOF\n" }),
		).toBe("bash: python3 - <<'EOF' (+2 lines)");
		expect(describeCall("edit", { path: "src/a.ts", edits: [{}, {}] })).toBe(
			"edit: src/a.ts (2 edits)",
		);
		expect(describeCall("edit", { path: "src/a.ts", edits: [{}] })).toBe(
			"edit: src/a.ts (1 edit)",
		);
		expect(describeCall("typescript", { label: "Read files", code: "x" })).toBe(
			"Read files",
		);
		expect(
			describeCall("typescript", { code: "\n  async () => 1\nmore" }),
		).toBe("typescript: async () => 1 (+1 line)");
		expect(describeCall("other", { a: 1 })).toBe('other {"a":1}');
		expect(describeCall("other", {})).toBe("other");
	});

	it("cuts long arguments", () => {
		const label = describeCall("bash", { command: "x".repeat(500) });
		expect(label).toHaveLength("bash: ".length + 120);
		expect(label.endsWith("…")).toBe(true);
		expect(oneLine("a\n\tb ")).toBe("a b");
	});
});

describe("formatDuration and formatStats", () => {
	it("formats durations for people", () => {
		expect(formatDuration(1234)).toBe("1.2s");
		expect(formatDuration(41_000)).toBe("41s");
		expect(formatDuration(192_000)).toBe("3m12s");
		expect(formatDuration(65_000)).toBe("1m05s");
	});

	it("totals a reply", () => {
		expect(
			formatStats({
				responses: 40,
				toolCalls: 39,
				failedToolCalls: 2,
				inputTokens: 1_234_567,
				outputTokens: 40_123,
				cost: 0.414,
				durationMs: 504_000,
			}),
		).toBe(
			"40 model responses · 39 tool calls (2 failed) · 8m24s · 1.2M tokens in, 40k out · $0.41",
		);
		expect(
			formatStats({
				responses: 1,
				toolCalls: 1,
				failedToolCalls: 0,
				inputTokens: 900,
				outputTokens: 5,
				cost: 0,
				durationMs: 0,
			}),
		).toBe("1 model response · 1 tool call · 0.0s · 900 tokens in, 5 out");
	});
});

describe("Activity", () => {
	it("logs a response, its tool call when it starts, and the result when it ends", () => {
		const r = recorder();
		const response = assistant([
			{ type: "thinking", thinking: "" },
			{ type: "text", text: "Let me check." },
			call("c1", "bash", { command: "npm test" }),
		]);
		r.activity.entries([response]);
		expect(r.lines).toStrictEqual(["💬 Let me check.", "🔧 bash: npm test"]);
		r.tick(5000);
		r.activity.entries([
			response,
			toolResult("c1", "ok\nTests 3 passed\n", { durationMs: 4200 }),
		]);
		expect(r.lines.slice(2)).toStrictEqual([
			"::group::  ↳ ✓ 4.2s · 2 lines",
			"command: npm test",
			"──",
			"ok\nTests 3 passed",
			"::endgroup::",
		]);
		expect(r.activity.take()).toStrictEqual({
			responses: 1,
			toolCalls: 1,
			failedToolCalls: 0,
			inputTokens: 100,
			outputTokens: 10,
			cost: 0.25,
			durationMs: 5000,
		});
		expect(r.activity.take().responses).toBe(0);
	});

	it("names each call's result when a response makes several, and counts failures", () => {
		const r = recorder();
		r.activity.entries([
			assistant([
				call("a", "read", { path: "a.ts" }),
				call("b", "read", { path: "b.ts" }),
			]),
			toolResult("b", "no such file", { isError: true, durationMs: 3 }),
			toolResult("a", ""),
		]);
		expect(r.lines).toStrictEqual([
			"🔧 read: a.ts",
			"🔧 read: b.ts",
			"::group::  ↳ ✗ failed read: b.ts · 0.0s · 1 line",
			"path: b.ts",
			"──",
			"no such file",
			"::endgroup::",
			"::group::  ↳ ✓ read: a.ts · 0 lines",
			"path: a.ts",
			"──",
			"(no output)",
			"::endgroup::",
		]);
		expect(r.activity.take().failedToolCalls).toBe(1);
	});

	it("shows the end of long output, and long texts in a group", () => {
		const r = recorder();
		const output = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
		r.activity.entries([
			assistant([
				{ type: "text", text: "First line.\n\nMore detail." },
				call("c", "bash", { command: "seq 40", padding: PADDING }),
			]),
			toolResult("c", output.join("\n")),
		]);
		expect(r.lines.slice(0, 4)).toStrictEqual([
			"::group::💬 First line.",
			"First line.\n\nMore detail.",
			"::endgroup::",
			"🔧 bash: seq 40",
		]);
		expect(r.lines[4]).toBe("::group::  ↳ ✓ 40 lines");
		expect(r.lines[5]).toHaveLength(4000);
		expect(r.lines[7]?.split("\n")).toStrictEqual([
			"… 10 earlier lines",
			...output.slice(10),
		]);
	});

	it("takes the label of a pit program from its header, and leaves the header out", () => {
		const code =
			'// @pit: {"label": "Read the config"}\nasync ({ workspace: { read } }) =>\n\tread("a.json")\n';
		expect(describeCall("typescript", { code })).toBe("Read the config");
		expect(describeCall("typescript", { code, label: "  Given label  " })).toBe(
			"Given label",
		);
		expect(formatArguments({ code, timeoutMs: 5000 })).toBe(
			'code:\nasync ({ workspace: { read } }) =>\n\tread("a.json")\ntimeoutMs: 5000',
		);
		expect(formatArguments({ code, label: "" })).toBe(
			'label: \ncode:\nasync ({ workspace: { read } }) =>\n\tread("a.json")',
		);
		// A header without a label, or one that is not JSON, is left out too.
		expect(
			describeCall("typescript", {
				code: "  // @pit: {}\nasync () => 1",
			}),
		).toBe("typescript: async () => 1");
		expect(
			describeCall("typescript", {
				code: "// @pit: nope\nasync () => 1",
			}),
		).toBe("typescript: async () => 1");
	});

	it("shows long JSON values indented", () => {
		const params = { files: ["src/a.ts", "src/b.ts"], query: "x".repeat(60) };
		expect(formatArguments({ params, n: [1, 2] })).toBe(
			`params:\n${JSON.stringify(params, null, 2)}\nn: [1,2]`,
		);
	});

	it("logs a pit program by its label, and its code without the header", () => {
		const r = recorder();
		r.activity.entries([
			assistant([
				call("t", "typescript", {
					code: '// @pit: {"label": "List files"}\nasync ({ workspace: { list } }) => list()',
				}),
			]),
			toolResult("t", '["a.ts"]', { durationMs: 20 }),
		]);
		expect(r.lines).toStrictEqual([
			"🔧 List files",
			"::group::  ↳ ✓ 0.0s · 1 line",
			"code: async ({ workspace: { list } }) => list()",
			"──",
			'["a.ts"]',
			"::endgroup::",
		]);
	});

	it("shows multi-line arguments as they are", () => {
		expect(
			formatArguments({
				command: "cat > x <<'EOF'\na \"b\"\nEOF\n",
				timeout: 30,
			}),
		).toBe("command:\ncat > x <<'EOF'\na \"b\"\nEOF\ntimeout: 30");
	});

	it("keeps the runner from running workflow commands in what pi and its tools wrote", () => {
		const r = recorder();
		r.activity.entries([
			assistant([
				{ type: "text", text: "Done.\n::add-mask::x" },
				call("c", "bash", { command: "npm run lint" }),
			]),
			toolResult(
				"c",
				"src/a.ts\n::error file=src/a.ts,line=1::bad\n##[error]old",
			),
		]);
		const stops = r.lines.filter((line) =>
			line.startsWith("::stop-commands::"),
		);
		expect(stops).toHaveLength(2);
		for (const stop of stops) {
			const token = stop.slice("::stop-commands::".length);
			const at = r.lines.indexOf(stop);
			expect(r.lines[at + 2]).toBe(`::${token}::`);
			expect(r.lines[at + 3]).toBe("::endgroup::");
		}
		expect(r.lines[r.lines.indexOf(String(stops[1])) + 1]).toContain(
			"::error file=",
		);
		// Arguments without commands are logged as they are.
		expect(r.lines).toContain("command: npm run lint");
	});

	it("logs model errors, and a result whose call it never saw", () => {
		const r = recorder();
		r.activity.entries([
			assistant([], { stopReason: "error", errorMessage: "overloaded" }),
			assistant([], { stopReason: "error" }),
			toolResult("unknown", "x"),
			{
				id: 999,
				conversationId: 1,
				kind: "pi-action.posted",
			} as unknown as EntryRecord,
		]);
		expect(r.lines).toStrictEqual([
			"⚠️ The model returned an error: overloaded",
			"⚠️ The model returned an error: unknown error",
			"::group::  ↳ ✓ 1 line",
			"x",
			"::endgroup::",
		]);
	});
});
