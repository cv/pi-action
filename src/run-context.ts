import type { PIContext } from "./context.js";
import { extractTask, hasTrigger } from "./context.js";
import { formatReviewComments } from "./formatting.js";
import { extractTriggerInfo, type GitHubClient } from "./github.js";
import type { ActionDependencies, Logger } from "./run.js";
import type { SecurityContext } from "./security.js";
import { sanitizeInput, validatePermissions } from "./security.js";
import type { TriggerInfo } from "./types.js";

export interface ResolvedRunContext {
	piContext: PIContext;
	ghClient: GitHubClient;
	triggerInfo?: TriggerInfo;
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

function validateTrigger(
	deps: ActionDependencies,
): { triggerInfo: TriggerInfo; ghClient: GitHubClient } | null {
	const { inputs, context, log } = deps;
	const triggerInfo = extractTriggerInfo(context.payload);
	if (!triggerInfo) {
		log.info("No issue or pull_request in payload, skipping");
		return null;
	}

	if (!hasTrigger(triggerInfo.triggerText, inputs.triggerPhrase)) {
		log.info(`No trigger phrase "${inputs.triggerPhrase}" found, skipping`);
		return null;
	}

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

async function getPullRequestContext(
	ghClient: GitHubClient,
	pullNumber: number,
	log: Logger,
): Promise<Pick<PIContext, "diff" | "reviewComments">> {
	const diff = await ghClient.getPullRequestDiff(pullNumber);

	try {
		const comments = await ghClient.getPullRequestReviewComments(pullNumber);
		return {
			diff,
			...(comments.length > 0
				? { reviewComments: formatReviewComments(comments) }
				: {}),
		};
	} catch (error) {
		log.warning(`Failed to fetch PR review comments: ${error}`);
	}
	return { diff };
}

async function buildPIContextForPullRequestNumber(
	ghClient: GitHubClient,
	pullNumber: number,
	prompt: string | undefined,
	log: Logger,
): Promise<PIContext> {
	const pullRequest = await ghClient.getPullRequest(pullNumber);
	const task = prompt?.trim() || "Please review this pull request";
	return {
		type: "pull_request",
		title: pullRequest.title,
		body: pullRequest.body,
		number: pullRequest.number,
		triggerComment: task,
		task,
		...(await getPullRequestContext(ghClient, pullRequest.number, log)),
	};
}

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

	if (!triggerInfo.isPullRequest) {
		return piContext;
	}

	return {
		...piContext,
		...(await getPullRequestContext(ghClient, triggerInfo.issueNumber, log)),
	};
}

export async function getRunContext(
	deps: ActionDependencies,
): Promise<ResolvedRunContext | null> {
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
