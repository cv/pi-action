import { runAgent } from "./agent.js";
import type { PIContext } from "./context.js";
import { extractTask, hasTrigger } from "./context.js";
import { formatReviewComments } from "./formatting.js";
import {
	addReaction,
	extractTriggerInfo,
	type GitHubClient,
} from "./github.js";
import {
	postResult,
	setResultOutputs,
	shareSessionForResult,
} from "./result-delivery.js";
import type { SecurityContext } from "./security.js";
import { sanitizeInput, validatePermissions } from "./security.js";
import type {
	AgentResult,
	CustomProviderConfig,
	ModelConfig,
	RepoRef,
	TriggerInfo,
} from "./types.js";

const EMPTY_RESPONSE_ERROR = "Agent returned empty response";

type OutputMode = "comment" | "output";

export interface ActionInputs {
	triggerPhrase: string;
	allowedBots: string[];
	modelConfig: ModelConfig;
	githubToken: string | undefined;
	gistToken: string | undefined;
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

function createGitHubClientFromInputs(
	deps: ActionDependencies,
): GitHubClient | null {
	const { inputs, createClient, log } = deps;
	if (!inputs.githubToken) {
		log.setFailed("github_token is required");
		return null;
	}
	return createClient(inputs.githubToken);
}

/**
 * Validates that the trigger is authorized to run the agent.
 * Returns the trigger info if valid, null otherwise.
 */
function validateTrigger(
	deps: ActionDependencies,
): { triggerInfo: TriggerInfo; ghClient: GitHubClient } | null {
	const { inputs, context, log } = deps;

	// Extract trigger info from payload
	const triggerInfo = extractTriggerInfo(context.payload);
	if (!triggerInfo) {
		log.info("No issue or pull_request in payload, skipping");
		return null;
	}

	// Check if trigger phrase is present
	if (!hasTrigger(triggerInfo.triggerText, inputs.triggerPhrase)) {
		log.info(`No trigger phrase "${inputs.triggerPhrase}" found, skipping`);
		return null;
	}

	// Validate permissions
	const securityContext: SecurityContext = {
		authorAssociation: triggerInfo.authorAssociation,
		authorLogin: triggerInfo.author.login,
		isBot: triggerInfo.author.type === "Bot",
		allowedBots: inputs.allowedBots,
	};

	if (!validatePermissions(securityContext)) {
		log.warning(
			`User ${triggerInfo.author.login} (${triggerInfo.authorAssociation}) does not have permission`,
		);
		return null;
	}

	const ghClient = createGitHubClientFromInputs(deps);
	return ghClient ? { triggerInfo, ghClient } : null;
}

function createDirectPIContext(prompt: string): PIContext {
	return {
		type: "direct",
		title: "Direct prompt",
		body: "",
		number: 0,
		triggerComment: prompt,
		task: prompt,
	};
}

async function addPullRequestContext(
	piContext: PIContext,
	ghClient: GitHubClient,
	pullNumber: number,
	log: Logger,
): Promise<void> {
	piContext.diff = await ghClient.getPullRequestDiff(pullNumber);

	try {
		const comments = await ghClient.getPullRequestReviewComments(pullNumber);
		if (comments.length > 0) {
			piContext.reviewComments = formatReviewComments(comments);
		}
	} catch (error) {
		log.warning(`Failed to fetch PR review comments: ${error}`);
	}
}

async function buildPIContextForPullRequestNumber(
	ghClient: GitHubClient,
	pullNumber: number,
	prompt: string | undefined,
	log: Logger,
): Promise<PIContext> {
	const pullRequest = await ghClient.getPullRequest(pullNumber);
	const task = prompt?.trim() || "Please review this pull request";
	const piContext: PIContext = {
		type: "pull_request",
		title: pullRequest.title,
		body: pullRequest.body,
		number: pullRequest.number,
		triggerComment: task,
		task,
	};
	await addPullRequestContext(piContext, ghClient, pullRequest.number, log);
	return piContext;
}

/**
 * Builds the PI context from trigger info and inputs.
 */
async function buildPIContext(
	triggerInfo: TriggerInfo,
	ghClient: GitHubClient,
	triggerPhrase: string,
	log: Logger,
): Promise<PIContext> {
	const sanitizedBody = sanitizeInput(triggerInfo.triggerText);
	const task = extractTask(sanitizedBody, triggerPhrase);

	const piContext: PIContext = {
		type: triggerInfo.isPullRequest ? "pull_request" : "issue",
		title: triggerInfo.issueTitle,
		body: triggerInfo.issueBody,
		number: triggerInfo.issueNumber,
		triggerComment: sanitizedBody,
		task,
	};

	// Get PR diff and review comments if applicable
	if (triggerInfo.isPullRequest) {
		await addPullRequestContext(
			piContext,
			ghClient,
			triggerInfo.issueNumber,
			log,
		);
	}

	return piContext;
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

function shouldRetryEmptyResponse(
	result: AgentResult,
): result is Extract<AgentResult, { success: false }> {
	return !result.success && result.error === EMPTY_RESPONSE_ERROR;
}

async function runAgentWithEmptyResponseRetry(
	piContext: PIContext,
	inputs: ActionInputs,
	cwd: string,
	log: Logger,
): Promise<AgentResult> {
	const agentConfig = createAgentConfig(inputs, cwd, log);
	const result = await runAgent(piContext, agentConfig);
	if (!shouldRetryEmptyResponse(result)) {
		return result;
	}

	log.warning(
		"Agent returned empty response from first attempt. Re-prompting for a summary.",
	);
	const firstError = result.error;
	const firstSession = result.session;
	const retryContext: PIContext = {
		...piContext,
		task: `IMPORTANT: You completed your work but did not provide a final text summary. This summary is REQUIRED. Please now write a plain-text summary of what you accomplished, including:
+- What changes were made and why
+- Which files were modified
+- Any errors encountered or remaining issues
+- Confirmation that your work is complete
+
+Do NOT call any tools - just provide the text summary.`,
	};
	const retryResult = await runAgent(retryContext, {
		...agentConfig,
		toolNames: [],
	});

	if (retryResult.success) {
		const retrySuccess = {
			success: true,
			response: retryResult.response,
		} as const;
		const session = firstSession ?? retryResult.session;
		return session ? { ...retrySuccess, session } : retrySuccess;
	}

	const retryError = retryResult.error;
	const retryFailure = {
		success: false,
		error: `Agent failed to provide a response after two attempts. First attempt: ${firstError}. Retry attempt: ${retryError}.`,
	} as const;
	const session = firstSession ?? retryResult.session;
	return session ? { ...retryFailure, session } : retryFailure;
}

async function getRunContext(deps: ActionDependencies): Promise<{
	piContext: PIContext;
	ghClient: GitHubClient;
	triggerInfo?: TriggerInfo;
} | null> {
	const { inputs, log } = deps;
	if (inputs.prNumber) {
		const ghClient = createGitHubClientFromInputs(deps);
		return ghClient
			? {
					ghClient,
					piContext: await buildPIContextForPullRequestNumber(
						ghClient,
						inputs.prNumber,
						inputs.prompt,
						log,
					),
				}
			: null;
	}

	if (inputs.prompt && inputs.outputMode === "output") {
		const ghClient = createGitHubClientFromInputs(deps);
		return ghClient
			? { ghClient, piContext: createDirectPIContext(inputs.prompt) }
			: null;
	}

	if (inputs.prompt && inputs.outputMode !== "output") {
		log.setFailed(
			"prompt requires output_mode: output when no PR number is set",
		);
		return null;
	}

	const validated = validateTrigger(deps);
	if (!validated) {
		return null;
	}

	return {
		...validated,
		piContext: await buildPIContext(
			validated.triggerInfo,
			validated.ghClient,
			inputs.triggerPhrase,
			log,
		),
	};
}

export async function run(deps: ActionDependencies): Promise<void> {
	const { inputs, log, cwd, createClient } = deps;
	const runContext = await getRunContext(deps);
	if (!runContext) {
		return;
	}

	const { piContext, ghClient, triggerInfo } = runContext;
	const gistClient = inputs.gistToken
		? createClient(inputs.gistToken)
		: undefined;

	if (inputs.outputMode === "comment" && triggerInfo) {
		await addReaction(ghClient, triggerInfo, "eyes");
	}

	log.info(`Running pi agent for: ${piContext.task}`);
	const result = await runAgentWithEmptyResponseRetry(
		piContext,
		inputs,
		cwd,
		log,
	);

	if (inputs.outputMode === "output") {
		const shareUrl = await shareSessionForResult(
			ghClient,
			gistClient,
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

	await postResult(
		ghClient,
		gistClient,
		triggerInfo,
		result,
		inputs.shareSession,
		log,
	);
}
