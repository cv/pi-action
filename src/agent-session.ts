import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type ModelRegistry,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agent.js";

type CreateAgentSessionResult = Awaited<ReturnType<typeof createAgentSession>>;

type ConfiguredAgentSession = Pick<
	CreateAgentSessionResult["session"],
	"exportToHtml" | "exportToJsonl" | "prompt" | "subscribe"
>;

export async function createConfiguredAgentSession(
	config: AgentConfig,
	modelRuntime: ModelRuntime,
	model: NonNullable<ReturnType<ModelRegistry["find"]>>,
): Promise<ConfiguredAgentSession> {
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

	const { session } = await createAgentSession({
		cwd: config.cwd,
		model,
		thinkingLevel: "off",
		modelRuntime,
		tools: config.toolNames ?? ["read", "bash", "edit", "write"],
		sessionManager: SessionManager.create(config.cwd),
		settingsManager,
		resourceLoader,
	});

	return session;
}
