// What pi does, in the workflow log as it happens: one line for each model response and tool call, with the
// details (the full text, a tool's arguments and output) in a collapsed group, and totals for each reply (#46).
import { randomUUID } from "node:crypto";

import type {
	AssistantMessage,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";

import { type ToolPresentation, toolPresentation } from "./tool-presentation.ts";
import { getErrorMessage } from "./utils.ts";

/** The log calls this module makes. */
export interface ActivityLog {
	info: (message: string) => void;
	startGroup: (name: string) => void;
	endGroup: () => void;
}

/** What pi did since the last `Activity.take()`. */
export interface ActivityStats {
	responses: number;
	toolCalls: number;
	failedToolCalls: number;
	/** Prompt tokens, cached ones included. */
	inputTokens: number;
	outputTokens: number;
	/** In dollars, as the provider reports it; 0 when it does not. */
	cost: number;
	/** Milliseconds since the first entry after the last take, 0 without one. */
	durationMs: number;
}

const ASSISTANT_KIND = "pi.assistant";
const TOOL_RESULT_KIND = "pi.tool-result";
/** The longest line the log shows of a text, a command, or a path. */
const LINE_LENGTH = 120;
/** How many lines of a tool's output its group shows: the last ones, where errors and results are. */
const OUTPUT_LINES = 30;
const OUTPUT_LINE_LENGTH = 300;
const ARGUMENTS_LENGTH = 4000;
/** A line the runner would take as a workflow command (`::error::`, `::add-mask::`, the old `##[error]`). */
const WORKFLOW_COMMAND = /^\s*(?:::|##\[)/mu;

/** pit's header, the first line of a `typescript` program: `// @pit: {"label": "Read the config"}`. */
const PIT_HEADER = /^\s*\/\/[ \t]*@pit:[ \t]*(.*)(?:\r?\n|$)/u;
/** Compact JSON longer than this goes on the lines after its key, indented. */
const COMPACT_JSON_LENGTH = 80;

const nonEmpty = (value: unknown): value is string =>
	typeof value === "string" && value.trim() !== "";

/** The label in pit's header, if it has one. */
function headerLabel(json: string): string | undefined {
	let header: unknown;
	try {
		header = JSON.parse(json);
	} catch {
		return undefined;
	}
	if (typeof header !== "object" || header === null || !("label" in header)) {
		return undefined;
	}
	return nonEmpty(header.label) ? header.label : undefined;
}

/**
 * A call's label (its `label` argument, or the label in pit's header) and the arguments that remain to show: the
 * code without pit's header, and no `label` when the label is shown already (#80).
 */
function splitLabel(args: Record<string, unknown>): {
	label: string | undefined;
	rest: Record<string, unknown>;
} {
	const { label, ...rest } = args;
	const { code } = args;
	const match = typeof code === "string" ? PIT_HEADER.exec(code) : null;
	const fromHeader = match === null ? undefined : headerLabel(match[1] ?? "");
	if (match !== null && typeof code === "string") {
		rest["code"] = code.slice(match[0].length);
	}
	if (nonEmpty(label)) {
		return { label, rest };
	}
	return {
		label: fromHeader,
		rest: label === undefined ? rest : { label, ...rest },
	};
}

/** A value that is not a string: compact JSON, or indented JSON on the next lines when it is long. */
function formatValue(key: string, value: unknown): string {
	// Tool arguments are parsed JSON, so each value has a JSON text.
	const compact = JSON.stringify(value);
	if (compact.length > COMPACT_JSON_LENGTH) {
		const indented = JSON.stringify(value, null, 2);
		if (indented.includes("\n")) {
			return `${key}:\n${indented}`;
		}
	}
	return `${key}: ${compact}`;
}

/**
 * A tool call's arguments for people: `key: value`, and a multi-line string (a script, a file) on the lines after
 * its key, as it is, not as an escaped JSON string. pit's header and the label are left out: the call's line shows
 * the label.
 */
export function formatArguments(args: Record<string, unknown>): string {
	const lines = Object.entries(splitLabel(args).rest).map(([key, value]) => {
		if (typeof value === "string") {
			return value.includes("\n")
				? `${key}:\n${value.replace(/\n$/u, "")}`
				: `${key}: ${value}`;
		}
		return formatValue(key, value);
	});
	const text = lines.join("\n");
	return text.length > ARGUMENTS_LENGTH
		? `${text.slice(0, ARGUMENTS_LENGTH - 1)}…`
		: text;
}
const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** `text` on one line, at most `max` characters. */
export function oneLine(text: string, max = LINE_LENGTH): string {
	const line = text.replaceAll(/\s+/gu, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const stringArg = (args: Record<string, unknown>, ...keys: string[]) => {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.trim() !== "") {
			return value;
		}
	}
	return undefined;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The one thing that says what a tool call does: a label (as it is, it says it all), or the tool and a command, a
 * path, a pattern, or the first line of a program.
 */
export function describeCall(
	name: string,
	args: Record<string, unknown>,
): string {
	const { label, rest } = splitLabel(args);
	if (label !== undefined) {
		return oneLine(label);
	}
	const edits = Array.isArray(rest["edits"]) ? rest["edits"].length : 0;
	const main =
		stringArg(rest, "command", "path", "file", "pattern", "query") ??
		stringArg(rest, "code");
	if (main === undefined) {
		const json = JSON.stringify(args);
		return json === "{}" ? name : `${name} ${oneLine(json)}`;
	}
	// A script (a heredoc, a program) reads best as its first line and its length: the group shows the rest.
	const lines = main.trim().split("\n");
	const more =
		lines.length > 1 ? ` (+${plural(lines.length - 1, "line")})` : "";
	const detail = edits > 0 ? ` (${edits} edit${edits === 1 ? "" : "s"})` : "";
	return `${name}: ${oneLine(lines[0] ?? "")}${more}${detail}`;
}

/** 1.2s, 41s, 3m12s. */
export function formatDuration(ms: number): string {
	if (ms < 10 * SECOND) {
		return `${(ms / SECOND).toFixed(1)}s`;
	}
	if (ms < MINUTE) {
		return `${Math.round(ms / SECOND)}s`;
	}
	const minutes = Math.floor(ms / MINUTE);
	const seconds = Math.round((ms % MINUTE) / SECOND);
	return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/** 950, 40k, 1.2M. */
function formatCount(n: number): string {
	if (n < 1000) {
		return String(n);
	}
	if (n < 1_000_000) {
		return `${Math.round(n / 1000)}k`;
	}
	return `${(n / 1_000_000).toFixed(1)}M`;
}

/** `40 model responses · 39 tool calls (2 failed) · 8m24s · 1.2M tokens in, 40k out · $0.41`. */
export function formatStats(stats: ActivityStats): string {
	const failed =
		stats.failedToolCalls > 0 ? ` (${stats.failedToolCalls} failed)` : "";
	const parts = [
		plural(stats.responses, "model response"),
		`${plural(stats.toolCalls, "tool call")}${failed}`,
		formatDuration(stats.durationMs),
		`${formatCount(stats.inputTokens)} tokens in, ${formatCount(stats.outputTokens)} out`,
	];
	if (stats.cost > 0) {
		parts.push(`$${stats.cost.toFixed(2)}`);
	}
	return parts.join(" · ");
}

const emptyStats = (): ActivityStats => ({
	responses: 0,
	toolCalls: 0,
	failedToolCalls: 0,
	inputTokens: 0,
	outputTokens: 0,
	cost: 0,
	durationMs: 0,
});

/** The text blocks of a message, joined. */
function textOf(content: readonly { type: string; text?: string }[]): string {
	return content
		.flatMap((block) =>
			block.type === "text" && block.text !== undefined ? [block.text] : [],
		)
		.join("")
		.trim();
}

/** The last OUTPUT_LINES lines of a tool's output, each cut at OUTPUT_LINE_LENGTH. */
function outputTail(text: string): string[] {
	const lines = text.replace(/\n+$/u, "").split("\n");
	const shown = lines
		.slice(-OUTPUT_LINES)
		.map((line) =>
			line.length > OUTPUT_LINE_LENGTH
				? `${line.slice(0, OUTPUT_LINE_LENGTH - 1)}…`
				: line,
		);
	return lines.length > OUTPUT_LINES
		? [`… ${lines.length - OUTPUT_LINES} earlier lines`, ...shown]
		: shown;
}

/** A call that has not ended. */
interface OpenCall {
	name: string;
	arguments: Record<string, unknown>;
	/** Its `🔧` line, without the icon. */
	label: string;
	/** Its details: its arguments, or the body the tool presented. */
	args: string;
	/** Whether its response made other calls too. */
	parallel: boolean;
}

/** `text`, at most `max` characters. */
const cut = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * Logs the entries pi-durable stores, as they are stored: `💬` for a model's text, `🔧` when a tool call starts,
 * and `↳` when it ends, in a group with its arguments and the end of its output. Counts them for `take()`. A tool
 * with a `present` field says itself what these lines show (see `useTools()`).
 */
export class Activity {
	private readonly log: ActivityLog;
	private readonly now: () => number;
	private stats = emptyStats();
	private since: number | undefined;
	private lastEntry = -1;
	private readonly calls = new Map<string, OpenCall>();
	private readonly presentations = new Map<string, ToolPresentation>();
	/** `<tool>.<hook>` of the presentations that failed, which the log said once. */
	private readonly failed = new Set<string>();

	constructor(log: ActivityLog, now: () => number = Date.now) {
		this.log = log;
		this.now = now;
	}

	/**
	 * Show the calls of these tools as their `present` fields say. A tool named like an earlier one replaces it, as in
	 * the registry; a tool without `present` gets the generic form.
	 */
	useTools(tools: readonly { readonly name: string }[]): void {
		for (const tool of tools) {
			const presentation = toolPresentation(tool);
			if (presentation === undefined) {
				this.presentations.delete(tool.name);
			} else {
				this.presentations.set(tool.name, presentation);
			}
		}
	}

	/** Log stored entries; each entry is logged once, however often it is passed. */
	entries(records: readonly EntryRecord[]): void {
		for (const record of records) {
			// Entry IDs grow: one already seen is a replay.
			const seen = Number(record.id) <= this.lastEntry;
			this.lastEntry = Math.max(this.lastEntry, Number(record.id));
			const message = seen ? undefined : record.model?.[0];
			if (record.kind === ASSISTANT_KIND && message?.role === "assistant") {
				this.since ??= this.now();
				this.assistant(message);
			} else if (
				record.kind === TOOL_RESULT_KIND &&
				message?.role === "toolResult"
			) {
				this.since ??= this.now();
				this.toolResult(message);
			}
		}
	}

	/** What pi did since the last take, and start counting again. */
	take(): ActivityStats {
		const stats = {
			...this.stats,
			durationMs: this.since === undefined ? 0 : this.now() - this.since,
		};
		this.stats = emptyStats();
		this.since = undefined;
		return stats;
	}

	/**
	 * What a tool's presentation returns, or undefined: when the tool has none, or when it fails, which the log says
	 * once for each tool and hook. The log then shows the generic form.
	 */
	private presented<T>(
		tool: string,
		hook: "call" | "result",
		present: (presentation: ToolPresentation) => T | undefined,
	): T | undefined {
		const presentation = this.presentations.get(tool);
		if (presentation === undefined) {
			return undefined;
		}
		try {
			return present(presentation);
		} catch (error) {
			const key = `${tool}.${hook}`;
			if (!this.failed.has(key)) {
				this.failed.add(key);
				this.log.info(
					`⚠️ Tool ${tool}: present.${hook}() failed, so the log shows its calls in the generic form: ${oneLine(getErrorMessage(error))}`,
				);
			}
			return undefined;
		}
	}

	private assistant(message: AssistantMessage): void {
		const { usage } = message;
		this.stats.responses += 1;
		this.stats.inputTokens += usage.input + usage.cacheRead + usage.cacheWrite;
		this.stats.outputTokens += usage.output;
		this.stats.cost += usage.cost.total;
		if (message.stopReason === "error") {
			this.log.info(
				`⚠️ The model returned an error: ${oneLine(message.errorMessage ?? "unknown error")}`,
			);
		}
		const text = textOf(message.content);
		if (text !== "") {
			this.text(text);
		}
		const calls = message.content.filter((block) => block.type === "toolCall");
		for (const call of calls) {
			const presented = this.presented(call.name, "call", (presentation) =>
				presentation.call?.(call.arguments),
			);
			const label =
				presented === undefined
					? describeCall(call.name, call.arguments)
					: oneLine(presented.title);
			this.stats.toolCalls += 1;
			this.calls.set(call.id, {
				name: call.name,
				arguments: call.arguments,
				label,
				args:
					presented?.body === undefined
						? formatArguments(call.arguments)
						: cut(presented.body, ARGUMENTS_LENGTH),
				parallel: calls.length > 1,
			});
			this.log.info(`🔧 ${label}`);
		}
	}

	/** A model's text: one line, or its first line with the rest in a group. */
	private text(text: string): void {
		const first = oneLine(text.split("\n")[0] ?? "");
		if (!text.includes("\n") && text.length <= LINE_LENGTH) {
			this.log.info(`💬 ${first}`);
			return;
		}
		this.log.startGroup(`💬 ${first}`);
		this.raw(text);
		this.log.endGroup();
	}

	private toolResult(message: ToolResultMessage): void {
		const call = this.calls.get(message.toolCallId);
		this.calls.delete(message.toolCallId);
		if (message.isError) {
			this.stats.failedToolCalls += 1;
		}
		const presented =
			call === undefined
				? undefined
				: this.presented(call.name, "result", (presentation) =>
						presentation.result?.(call.arguments, message),
					);
		const text = presented?.body ?? textOf(message.content);
		const lines = text === "" ? 0 : text.split("\n").length;
		const status = message.isError ? "✗ failed" : "✓";
		const parts = [
			...(call?.parallel === true ? [call.label] : []),
			...(message.durationMs === undefined
				? []
				: [formatDuration(message.durationMs)]),
			presented?.summary === undefined
				? plural(lines, "line")
				: oneLine(presented.summary),
		].filter((part) => part !== "");
		const summary = parts.length > 0 ? ` ${parts.join(" · ")}` : "";
		this.log.startGroup(`  ↳ ${status}${summary}`);
		if (call !== undefined) {
			this.raw(call.args);
			this.log.info("──");
		}
		this.raw(lines === 0 ? "(no output)" : outputTail(text).join("\n"));
		this.log.endGroup();
	}

	/**
	 * Log text that pi or a tool wrote, so the runner does not run the workflow commands in it: a tool's output with
	 * `::error file=...::` (a linter's GitHub reporter) would otherwise annotate the run (#46).
	 */
	private raw(text: string): void {
		if (!WORKFLOW_COMMAND.test(text)) {
			this.log.info(text);
			return;
		}
		const token = randomUUID();
		this.log.info(`::stop-commands::${token}`);
		this.log.info(text);
		this.log.info(`::${token}::`);
	}
}
