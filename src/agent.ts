import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
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

export interface AgentLogger {
	info: (msg: string) => void;
}

export interface AgentConfig extends ModelConfig {
	cwd: string;
	logger?: AgentLogger;
	apiKey?: string;
	customProvider?: CustomProviderConfig;
	promptTemplate?: string;
	toolNames?: string[];
}

/**
 * Session event types from the pi SDK
 */
interface SessionEvent {
	type: string;
	toolName?: string;
	args?: Record<string, unknown> & {
		command?: unknown;
		path?: unknown;
	};
	isError?: boolean;
	assistantMessageEvent?: {
		type: string;
		delta?: string;
	};
}

/**
 * Creates a session event handler that logs tool executions and collects response text.
 */
function createSessionEventHandler(
	log: AgentLogger,
	onTextDelta: (delta: string) => void,
): (event: SessionEvent) => void {
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: switch statement handling many event types
	return (event: SessionEvent) => {
		switch (event.type) {
			case "turn_start":
				log.info("🔄 Turn started");
				break;
			case "turn_end":
				log.info("✅ Turn completed");
				break;
			case "tool_execution_start": {
				log.info(`🔧 Tool: ${event.toolName}`);
				const command = event.args?.command;
				const path = event.args?.path;
				if (event.toolName === "bash" && command) {
					log.info(`   $ ${command}`);
				} else if (event.toolName === "read" && path) {
					log.info(`   📖 ${path}`);
				} else if (event.toolName === "write" && path) {
					log.info(`   ✏️ ${path}`);
				} else if (event.toolName === "edit" && path) {
					log.info(`   📝 ${path}`);
				}
				break;
			}
			case "tool_execution_end":
				if (event.isError) {
					log.info(`   ❌ Tool error: ${event.toolName}`);
				}
				break;
			case "message_update":
				if (event.assistantMessageEvent?.type === "text_delta") {
					onTextDelta(event.assistantMessageEvent.delta ?? "");
				}
				break;
		}
	};
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
