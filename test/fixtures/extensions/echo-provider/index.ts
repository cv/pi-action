/**
 * A pi extension, written as for the coding agent: it registers an "echo" provider (legacy
 * registerProvider form, with its own streamSimple) and also a tool and an event handler,
 * which pi-action ignores with a warning. It answers with the API key it was given and the
 * number of messages it saw, so tests can check the action's wiring end to end.
 */
import {
	type Api,
	fauxAssistantMessage,
	fauxProvider,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

interface ExtensionApi {
	registerProvider: (name: string, config: Record<string, unknown>) => void;
	registerTool: (tool: Record<string, unknown>) => void;
	on: (event: string, handler: () => void) => void;
}

const faux = fauxProvider({
	provider: "echo",
	api: "echo-api",
	models: [{ id: "echo-1" }],
});

// oxlint-disable-next-line import/no-default-export -- pi loads an extension's default export
export default function echoProvider(pi: ExtensionApi): void {
	pi.registerProvider("echo", {
		name: "Echo",
		baseUrl: "https://echo.invalid/v1",
		apiKey: "$ECHO_API_KEY",
		api: "echo-api",
		models: [
			{
				id: "echo-1",
				name: "Echo 1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32_000,
				maxTokens: 1024,
			},
		],
		streamSimple(
			model: Model<Api>,
			context: TranscriptContext,
			options?: SimpleStreamOptions,
		) {
			faux.appendResponses([
				fauxAssistantMessage(
					`echo from ${model.provider}/${model.id} with key ${options?.apiKey ?? "none"}`,
				),
			]);
			return faux.provider.streamSimple(model, context, options);
		},
	});
	pi.registerTool({ name: "echo_tool" });
	pi.on("session_start", () => undefined);
}
