import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { type AgentLogger, createSessionEventHandler } from "./agent-events.js";
import { createConfiguredAgentSession } from "./agent-session.js";
import type { PIContext } from "./context.js";
import { buildPrompt } from "./context.js";
import { registerCustomProvider } from "./custom-provider.js";
import type {
	AgentResult,
	CustomProviderConfig,
	ModelConfig,
	Session,
} from "./types.js";
import { getErrorMessage, withTimeout } from "./utils.js";

export interface AgentConfig extends ModelConfig {
	cwd: string;
	logger?: AgentLogger;
	apiKey?: string;
	customProvider?: CustomProviderConfig;
	promptTemplate?: string;
	toolNames?: string[];
}

export async function runAgent(
	piContext: PIContext,
	config: AgentConfig,
	authStorage?: AuthStorage,
	modelRegistry?: ModelRegistry,
): Promise<AgentResult> {
	const prompt = buildPrompt(piContext, config.promptTemplate);

	// Use in-memory auth/model state so CI configuration comes only from env vars and inputs.
	const auth = authStorage ?? AuthStorage.inMemory();
	if (config.apiKey) {
		auth.setRuntimeApiKey(config.provider, config.apiKey);
	}
	const models = modelRegistry ?? ModelRegistry.inMemory(auth);
	const customProviderError = registerCustomProvider(
		models,
		config.provider,
		config.model,
		config.apiKey,
		config.customProvider,
	);
	if (customProviderError) {
		return { success: false, error: customProviderError };
	}

	// Find the model
	const model = models.find(config.provider, config.model);
	if (!model) {
		return {
			success: false,
			error: `Model not found: ${config.provider}/${config.model}`,
		};
	}

	// Collect response text
	let response = "";
	let session: Session | undefined;

	try {
		const createdSession = await createConfiguredAgentSession(
			config,
			auth,
			models,
			model,
		);

		session = createdSession;

		// biome-ignore lint/suspicious/noEmptyBlockStatements: noop logger
		const log = config.logger ?? { info: () => {} };
		const eventHandler = createSessionEventHandler(log, (delta) => {
			response += delta;
		});

		createdSession.subscribe(eventHandler);

		// Run with timeout
		await withTimeout(
			createdSession.prompt(prompt),
			config.timeout * 1000,
			`Timeout after ${config.timeout} seconds`,
		);

		const trimmedResponse = response.trim();
		if (!trimmedResponse) {
			return {
				success: false,
				error: "Agent returned empty response",
				session: createdSession,
			};
		}

		return {
			success: true,
			response: trimmedResponse,
			session: createdSession,
		};
	} catch (error) {
		const errorResult = {
			success: false,
			error: getErrorMessage(error),
		} as const;
		return session ? { ...errorResult, session } : errorResult;
	}
}
