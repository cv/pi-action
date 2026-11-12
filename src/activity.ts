// What pi does, in the workflow log as it happens: one line for each model response and tool call, with the
// details (the full text, a tool's arguments and output) in a collapsed group, and totals for each reply (#46).
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";

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
const ARGUMENTS_LENGTH = 2000;
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

/** The one thing that says what a tool call does: a command, a path, a label, a pattern. */
export function describeCall(
	name: string,
	args: Record<string, unknown>,
): string {
	const edits = Array.isArray(args["edits"]) ? args["edits"].length : 0;
	const main =
		stringArg(args, "command", "label", "path", "file", "pattern", "query") ??
		(typeof args["code"] === "string"
			? args["code"].split("\n").find((line) => line.trim() !== "")
			: undefined);
	if (main === undefined) {
		const json = JSON.stringify(args);
		return json === "{}" ? name : `${name} ${oneLine(json)}`;
	}
	const detail = edits > 0 ? ` (${edits} edit${edits === 1 ? "" : "s"})` : "";
	return `${name}: ${oneLine(main)}${detail}`;
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

const plural = (n: number, word: string) =>
	`${n} ${word}${n === 1 ? "" : "s"}`;

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

/**
 * Logs the entries pi-durable stores, as they are stored: `💬` for a model's text, `🔧` when a tool call starts,
 * and `↳` when it ends, in a group with its arguments and the end of its output. Counts them for `take()`.
 */
export class Activity {
	private readonly log: ActivityLog;
	private readonly now: () => number;
	private stats = emptyStats();
	private since: number | undefined;
	private lastEntry = -1;
	/** Tool calls that have not ended: their line, and whether their response made other calls too. */
	private readonly calls = new Map<
		string,
		{ label: string; args: string; parallel: boolean }
	>();

	constructor(log: ActivityLog, now: () => number = Date.now) {
		this.log = log;
		this.now = now;
	}

	/** Log stored entries; each entry is logged once, however often it is passed. */
	entries(records: readonly EntryRecord[]): void {
		for (const record of records) {
			// Entry IDs grow: one already seen is a replay.
			if (Number(record.id) <= this.lastEntry) {
				continue;
			}
			this.lastEntry = Number(record.id);
			const message = record.model?.[0];
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
			const label = describeCall(call.name, call.arguments);
			this.stats.toolCalls += 1;
			this.calls.set(call.id, {
				label,
				args: JSON.stringify(call.arguments, undefined, 2),
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
		this.log.info(text);
		this.log.endGroup();
	}

	private toolResult(message: ToolResultMessage): void {
		const call = this.calls.get(message.toolCallId);
		this.calls.delete(message.toolCallId);
		if (message.isError) {
			this.stats.failedToolCalls += 1;
		}
		const text = textOf(message.content);
		const output = outputTail(text);
		const lines = text === "" ? 0 : text.split("\n").length;
		const status = message.isError ? "✗ failed" : "✓";
		const parts = [
			...(call?.parallel === true ? [call.label] : []),
			...(message.durationMs === undefined
				? []
				: [formatDuration(message.durationMs)]),
			plural(lines, "line"),
		];
		this.log.startGroup(`  ↳ ${status} ${parts.join(" · ")}`);
		if (call !== undefined) {
			this.log.info(
				call.args.length > ARGUMENTS_LENGTH
					? `${call.args.slice(0, ARGUMENTS_LENGTH - 1)}…`
					: call.args,
			);
			this.log.info("──");
		}
		this.log.info(lines === 0 ? "(no output)" : output.join("\n"));
		this.log.endGroup();
	}
}
