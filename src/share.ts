import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntryRecord } from "@earendil-works/pi-durable";

type Env = Record<string, string | undefined>;

const TOOL_OUTPUT_LIMIT = 4000;
const SERVER_URL_ENV = "GITHUB_SERVER_URL";
const REPOSITORY_ENV = "GITHUB_REPOSITORY";
const RUN_ID_ENV = "GITHUB_RUN_ID";
const RUNNER_TEMP_ENV = "RUNNER_TEMP";

/** The workflow run page, where the composite action's upload-artifact step puts the session files. */
export function getRunUrl(env: Env = process.env): string | undefined {
	const serverUrl = env[SERVER_URL_ENV] ?? "https://github.com";
	const repository = env[REPOSITORY_ENV];
	const runId = env[RUN_ID_ENV];
	return repository && runId
		? `${serverUrl}/${repository}/actions/runs/${runId}`
		: undefined;
}

function getArtifactDir(env: Env = process.env): string {
	return join(env[RUNNER_TEMP_ENV] ?? tmpdir(), "pi-action-session");
}

interface Block {
	type: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
}

function blocksOf(content: unknown): Block[] {
	return typeof content === "string"
		? [{ type: "text", text: content }]
		: ((content as Block[] | undefined) ?? []);
}

function truncate(text: string): string {
	return text.length > TOOL_OUTPUT_LIMIT
		? `${text.slice(0, TOOL_OUTPUT_LIMIT)}\n… (${text.length - TOOL_OUTPUT_LIMIT} more characters)`
		: text;
}

function renderAssistant(blocks: Block[]): string[] {
	const lines = ["## 🤖 pi", ""];
	for (const block of blocks) {
		if (block.type === "text" && block.text) {
			lines.push(block.text, "");
		} else if (block.type === "toolCall") {
			lines.push(
				`🔧 **${block.name}** \`${JSON.stringify(block.arguments)}\``,
				"",
			);
		}
	}
	return lines;
}

function renderMessage(message: {
	role: string;
	content?: unknown;
	toolName?: string;
	isError?: boolean;
}): string[] {
	const blocks = blocksOf(message.content);
	const text = blocks
		.flatMap((block) => (block.text ? [block.text] : []))
		.join("\n");
	if (message.role === "user") {
		return ["## 🧑 User", "", text, ""];
	}
	if (message.role === "assistant") {
		return renderAssistant(blocks);
	}
	if (message.role === "toolResult") {
		const status = message.isError ? " (error)" : "";
		return [
			`### Result of ${message.toolName ?? "tool"}${status}`,
			"",
			"```",
			truncate(text),
			"```",
			"",
		];
	}
	return [];
}

/** A readable transcript of what the model saw and did. */
function renderTranscript(title: string, entries: EntryRecord[]): string {
	const lines = [`# ${title}`, ""];
	for (const entry of entries) {
		for (const message of entry.model ?? []) {
			lines.push(...renderMessage(message));
		}
	}
	return lines.join("\n");
}

/**
 * Write the thread as session.md (readable) and session.jsonl (every entry) for the composite action's
 * upload-artifact step. Returns the run URL to link, or undefined when the export failed.
 */
export async function exportSession(
	title: string,
	entries: EntryRecord[],
	options: { dir?: string; runUrl?: string | undefined } = {},
): Promise<string | undefined> {
	const dir = options.dir ?? getArtifactDir();
	try {
		await rm(dir, { recursive: true, force: true });
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "session.md"), renderTranscript(title, entries));
		await writeFile(
			join(dir, "session.jsonl"),
			entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
		);
		return options.runUrl ?? getRunUrl() ?? dir;
	} catch {
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
		return;
	}
}
