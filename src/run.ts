import type { runAgent } from "./agent.js";
import { runAgentWithEmptyResponseRetry } from "./empty-response-retry.js";
import { addReaction, type GitHubClient } from "./github.js";
import {
	postResult,
	setResultOutputs,
	shareSessionForResult,
} from "./result-delivery.js";
import { getRunContext } from "./run-context.js";
import type { CustomProviderConfig, ModelConfig, RepoRef } from "./types.js";

type OutputMode = "comment" | "output";

export interface ActionInputs {
	triggerPhrase: string;
	allowedBots: string[];
	modelConfig: ModelConfig;
	githubToken: string | undefined;
	apiKey: string | undefined;
	customProvider: CustomProviderConfig | undefined;
	promptTemplate: string | undefined;
	shareSession: boolean;
	outputMode: OutputMode;
	prompt: string | undefined;
	prNumber: number | undefined;
}

export interface ActionContext {
	payload: Record<string, unknown>;
	repo: RepoRef;
}

export interface Logger {
	info: (msg: string) => void;
	warning: (msg: string) => void;
	error: (msg: string) => void;
	setFailed: (msg: string) => void;
	setOutput: (name: string, value: string) => void;
}

export interface ActionDependencies {
	inputs: ActionInputs;
	context: ActionContext;
	createClient: (token: string) => GitHubClient;
	log: Logger;
	cwd: string;
}

function createAgentConfig(
	inputs: ActionInputs,
	cwd: string,
	log: Logger,
): Parameters<typeof runAgent>[1] {
	return {
		...inputs.modelConfig,
		cwd,
		logger: log,
		...(inputs.apiKey ? { apiKey: inputs.apiKey } : {}),
		...(inputs.customProvider ? { customProvider: inputs.customProvider } : {}),
		...(inputs.promptTemplate ? { promptTemplate: inputs.promptTemplate } : {}),
	};
}

export async function run(deps: ActionDependencies): Promise<void> {
	const { inputs, log, cwd } = deps;
	const runContext = await getRunContext(deps);
	if (!runContext) {
		return;
	}

	const { piContext, ghClient, triggerInfo } = runContext;
	if (inputs.outputMode === "comment" && triggerInfo) {
		await addReaction(ghClient, triggerInfo, "eyes");
	}

	log.info(`Running pi agent for: ${piContext.task}`);
	const result = await runAgentWithEmptyResponseRetry(
		piContext,
		createAgentConfig(inputs, cwd, log),
		log,
	);

	if (inputs.outputMode === "output") {
		const shareUrl = await shareSessionForResult(
			piContext.title,
			result,
			inputs.shareSession,
			log,
		);
		setResultOutputs(log, result, shareUrl);
		return;
	}

	if (!triggerInfo) {
		log.setFailed(
			"comment output mode requires an issue or pull request trigger",
		);
		return;
	}

	await postResult(ghClient, triggerInfo, result, inputs.shareSession, log);
}
