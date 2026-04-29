import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { type AgentLogger, createSessionEventHandler } from "./agent-events.js";
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
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: true, maxRetries: 2 },
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: config.cwd,
			agentDir: getAgentDir(),
			settingsManager,
			// Disable discovery for extensions, skills, prompts, themes, and context files in CI.
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();

		const { session: createdSession } = await createAgentSession({
			cwd: config.cwd,
			model,
			thinkingLevel: "off",
			authStorage: auth,
			modelRegistry: models,
			tools: config.toolNames ?? ["read", "bash", "edit", "write"],
			sessionManager: SessionManager.create(config.cwd),
			settingsManager,
			resourceLoader,
		});

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
				session,
			};
		}

		return { success: true, response: trimmedResponse, session };
	} catch (error) {
		const errorResult = {
			success: false,
			error: getErrorMessage(error),
		} as const;
		return session ? { ...errorResult, session } : errorResult;
	}
}
