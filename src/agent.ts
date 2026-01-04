import {
	type AuthStorage,
	type ModelRegistry,
	SessionManager,
	SettingsManager,
	createAgentSession,
	createCodingTools,
	discoverAuthStorage,
	discoverModels,
} from "@mariozechner/pi-coding-agent";
import type { PIContext } from "./context.js";
import { buildPrompt } from "./context.js";
import type { AgentResult } from "./types.js";
import { getErrorMessage } from "./utils.js";

export interface AgentLogger {
	info: (msg: string) => void;
}

export interface AgentConfig {
	provider: string;
	model: string;
	timeout: number;
	cwd: string;
	logger?: AgentLogger;
	promptTemplate?: string;
}

export async function runAgent(
	piContext: PIContext,
	config: AgentConfig,
	authStorage?: AuthStorage,
	modelRegistry?: ModelRegistry,
): Promise<AgentResult> {
	const prompt = buildPrompt(piContext, config.promptTemplate);

	// Use provided or discover auth/models
	const auth = authStorage ?? discoverAuthStorage();
	const models = modelRegistry ?? discoverModels(auth);

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

	try {
		const { session } = await createAgentSession({
			cwd: config.cwd,
			model,
			thinkingLevel: "off",
			authStorage: auth,
			modelRegistry: models,
			tools: createCodingTools(config.cwd),
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: true, maxRetries: 2 },
			}),
			// Disable discovery for hooks, skills, etc. in CI environment
			hooks: [],
			skills: [],
			contextFiles: [],
			slashCommands: [],
		});

		const log = config.logger ?? { info: () => {} };

		// Subscribe to collect response and log events
		session.subscribe((event) => {
			switch (event.type) {
				case "turn_start":
					log.info("🔄 Turn started");
					break;
				case "turn_end":
					log.info("✅ Turn completed");
					break;
				case "tool_execution_start":
					log.info(`🔧 Tool: ${event.toolName}`);
					if (event.toolName === "bash" && event.args?.command) {
						log.info(`   $ ${event.args.command}`);
					} else if (event.toolName === "read" && event.args?.path) {
						log.info(`   📖 ${event.args.path}`);
					} else if (event.toolName === "write" && event.args?.path) {
						log.info(`   ✏️ ${event.args.path}`);
					} else if (event.toolName === "edit" && event.args?.path) {
						log.info(`   📝 ${event.args.path}`);
					}
					break;
				case "tool_execution_end":
					if (event.isError) {
						log.info(`   ❌ Tool error: ${event.toolName}`);
					}
					break;
				case "message_update":
					if (event.assistantMessageEvent.type === "text_delta") {
						response += event.assistantMessageEvent.delta;
					}
					break;
			}
		});

		// Create a timeout promise
		const timeoutId = setTimeout(
			() => reject(new Error(`Timeout after ${config.timeout} seconds`)),
			config.timeout * 1000,
		);

		let reject: (reason?: unknown) => void;
		const timeoutPromise = new Promise<never>((_, rej) => {
			reject = rej;
		});

		try {
			// Run with timeout
			await Promise.race([session.prompt(prompt), timeoutPromise]);

			const trimmedResponse = response.trim();
			if (!trimmedResponse) {
				return { success: false, error: "Agent returned empty response" };
			}

			return { success: true, response: trimmedResponse };
		} finally {
			clearTimeout(timeoutId);
		}
	} catch (error) {
		return { success: false, error: getErrorMessage(error) };
	}
}
