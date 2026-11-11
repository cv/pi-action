/**
 * A pi-durable extension, as `pit/durable` ships one: `createPiDurableExtension(options)` returns an extension with
 * an `ask_user` tool that asks `ui.confirm` and `ui.select` and reports the answers (and the host options), so
 * tests can drive pi-action's GitHub UI end to end.
 */
import { defineTool, type Extension } from "@earendil-works/pi-durable";

interface Ui {
	confirm: (
		title: string,
		message: string,
		options?: { signal?: AbortSignal },
	) => Promise<boolean>;
	select: (
		title: string,
		options: string[],
		opts?: { signal?: AbortSignal },
	) => Promise<string | undefined>;
	notify: (message: string, level?: "info" | "warning" | "error") => void;
}

interface HostOptions {
	cwd?: string;
	agentDir?: string;
	trustProject?: boolean;
	ui?: Ui;
	log?: { info: (msg: string) => void; warning: (msg: string) => void };
}

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
				async execute(_args, _api, context) {
					const { ui } = options;
					if (!ui) {
						return { output: [{ type: "text", text: "no ui" }] };
					}
					const signal = context.abortSignal;
					const dialog = signal ? { signal } : {};
					const ok = await ui.confirm(
						"Deploy?",
						"Ship it to production?",
						dialog,
					);
					const color = await ui.select("Color", ["red", "green"], dialog);
					ui.notify(`deploy=${String(ok)}`);
					return {
						output: [
							{
								type: "text",
								text: `confirm=${String(ok)} select=${color ?? "none"} agentDir=${options.agentDir ?? ""}`,
							},
						],
					};
				},
			}),
		],
	};
}
