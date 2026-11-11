/**
 * A pi-durable extension, as `pit/durable` ships one: `createPiDurableExtension(options)` returns an extension with an
 * `ask_user` tool that asks to confirm a deployment and to pick a color, the way pit asks on an asynchronous host. A
 * question with an unused `ui.answer` in the conversation gets that answer (recorded as consumed); any other is posted
 * with `ui.ask`, and the call ends the run (`control.terminate`). Once both are answered, the tool reports them and
 * the host options, so tests can drive pi-action's GitHub questions end to end.
 */
import { createHash } from "node:crypto";

import { defineTool, type Extension } from "@earendil-works/pi-durable";

type UiQuestion =
	| { kind: "confirm"; key: string; title: string; message: string }
	| { kind: "select"; key: string; title: string; options: string[] };
type Draft =
	| { kind: "confirm"; title: string; message: string }
	| { kind: "select"; title: string; options: string[] };

interface Ui {
	ask: (question: UiQuestion) => Promise<{ url?: string }>;
	notify: (message: string, level?: "info" | "warning" | "error") => void;
}

interface HostOptions {
	cwd?: string;
	agentDir?: string;
	trustProject?: boolean;
	ui?: Ui;
	log?: { info: (msg: string) => void; warning: (msg: string) => void };
}

/** pit's question key: the first 16 hex characters of sha256(JSON.stringify([kind, title, detail])). */
function withKey(draft: Draft): UiQuestion {
	const detail = draft.kind === "confirm" ? draft.message : draft.options;
	const key = createHash("sha256")
		.update(JSON.stringify([draft.kind, draft.title, detail]))
		.digest("hex")
		.slice(0, 16);
	return { ...draft, key };
}

const isRecord = (value: unknown): value is object =>
	typeof value === "object" && value !== null;

const text = (value: string) => ({
	output: [{ type: "text" as const, text: value }],
});

export function createPiDurableExtension(options: HostOptions = {}): Extension {
	options.log?.info(
		`durable-ask: trustProject=${String(options.trustProject)}`,
	);
	return {
		name: "durable-ask",
		tools: [
			defineTool({
				name: "ask_user",
				description: "Ask the user to confirm a deployment and pick a color",
				parameters: { type: "object", properties: {} },
				async execute(_args, api, context) {
					const { ui } = options;
					if (!ui) {
						return text("no ui");
					}
					// Unused answers in the conversation, per question key.
					const answers = new Map<string, unknown[]>();
					await api.commit(async (tx) => {
						const page = await tx.scanEntries(
							{ conversationId: api.conversationId, order: "ascending" },
							1000,
						);
						for (const entry of page.items) {
							const data = isRecord(entry.data) ? entry.data : {};
							const key: unknown = Reflect.get(data, "key");
							if (typeof key === "string" && entry.kind === "ui.answer") {
								answers.set(key, [
									...(answers.get(key) ?? []),
									Reflect.get(data, "answer"),
								]);
							} else if (
								typeof key === "string" &&
								entry.kind === "ui.answer-consumed"
							) {
								answers.get(key)?.shift();
							}
						}
					}, context);
					const used: string[] = [];
					const answer = async (draft: Draft) => {
						const question = withKey(draft);
						const found = answers.get(question.key)?.shift();
						if (found !== undefined) {
							used.push(question.key);
							return { answer: found };
						}
						return { question, posted: await ui.ask(question) };
					};
					const results: unknown[] = [];
					for (const draft of [
						{
							kind: "confirm",
							title: "Deploy?",
							message: "Ship it to production?",
						},
						{ kind: "select", title: "Color", options: ["red", "green"] },
					] satisfies Draft[]) {
						// oxlint-disable-next-line eslint/no-await-in-loop -- questions are asked in order, and the first unanswered one ends the call
						const got = await answer(draft);
						if ("posted" in got) {
							return {
								...text(
									`Question posted: ${got.question.title} (${got.posted.url ?? ""}). The answer will arrive as a later message; end your turn now.`,
								),
								control: { terminate: true },
							};
						}
						results.push(got.answer);
					}
					const conversation = await api.conversation(
						api.conversationId,
						context,
					);
					for (const key of used) {
						// oxlint-disable-next-line eslint/no-await-in-loop -- one write per answer used, in order
						await conversation?.submit(
							{
								type: "write",
								entry: { kind: "ui.answer-consumed", data: { key } },
							},
							context,
						);
					}
					ui.notify(`deploy=${String(results[0])}`);
					return text(
						`confirm=${String(results[0])} select=${String(results[1])} agentDir=${options.agentDir ?? ""}`,
					);
				},
			}),
		],
	};
}
