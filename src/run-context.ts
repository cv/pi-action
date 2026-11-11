// What a run works on: the pull request of pr_number, a direct prompt, or the issue/PR/comment that triggered it.
import { extractTask, hasTrigger, type PIContext } from "./context.ts";
import { formatReviewComments } from "./formatting.ts";
import { extractTriggerInfo, type GitHubClient } from "./github.ts";
import type { ActionDependencies } from "./run.ts";
import { sanitizeInput, validatePermissions } from "./security.ts";
import type { Log, TriggerInfo } from "./types.ts";
import { getErrorMessage } from "./utils.ts";

export interface ResolvedRunContext {
	piContext: PIContext;
	ghClient: GitHubClient;
	triggerInfo?: TriggerInfo;
}

function createClient(deps: ActionDependencies): GitHubClient | null {
	const { inputs, createClient: create, log } = deps;
	if (!inputs.githubToken) {
		log.setFailed("github_token is required");
		return null;
	}
	return create(inputs.githubToken);
}

/** A pull request's diff and existing review comments (left out, with a warning, if they can't be listed). */
async function pullRequestDetails(
	gh: GitHubClient,
	pullNumber: number,
	log: Log,
): Promise<{ diff: string; reviewComments?: string }> {
	const diff = await gh.getPullRequestDiff(pullNumber);
	try {
		const reviewComments = formatReviewComments(
			await gh.listReviewComments(pullNumber),
		);
		return reviewComments ? { diff, reviewComments } : { diff };
	} catch (error) {
		log.warning(
			`Failed to fetch PR review comments: ${getErrorMessage(error)}`,
		);
		return { diff };
	}
}

/** The trigger of the event, if it mentions the trigger phrase and its author may run pi. */
function permittedTrigger(deps: ActionDependencies): TriggerInfo | null {
	const { inputs, payload, log } = deps;
	const info = extractTriggerInfo(payload);
	if (!info) {
		log.info("No issue or pull_request in payload, skipping");
		return null;
	}
	if (!hasTrigger(info.triggerText, inputs.triggerPhrase)) {
		log.info(`No trigger phrase "${inputs.triggerPhrase}" found, skipping`);
		return null;
	}
	if (!validatePermissions(info.author, info.authorAssociation, inputs)) {
		log.warning(
			`User ${info.author.login} (${info.authorAssociation}) does not have permission`,
		);
		return null;
	}
	return info;
}

export async function getRunContext(
	deps: ActionDependencies,
): Promise<ResolvedRunContext | null> {
	const { inputs, log } = deps;
	if (inputs.prNumber !== undefined) {
		const ghClient = createClient(deps);
		if (!ghClient) {
			return null;
		}
		const pr = await ghClient.getPullRequest(inputs.prNumber);
		const task = inputs.prompt?.trim() || "Please review this pull request";
		return {
			ghClient,
			piContext: {
				type: "pull_request",
				title: pr.title,
				body: pr.body,
				number: pr.number,
				triggerComment: task,
				task,
				...(await pullRequestDetails(ghClient, pr.number, log)),
			},
		};
	}

	if (inputs.prompt) {
		if (inputs.outputMode !== "output") {
			log.setFailed(
				"prompt requires output_mode: output when no PR number is set",
			);
			return null;
		}
		const ghClient = createClient(deps);
		const piContext: PIContext = {
			type: "direct",
			title: "Direct prompt",
			task: inputs.prompt,
		};
		return ghClient ? { ghClient, piContext } : null;
	}

	const triggerInfo = permittedTrigger(deps);
	const ghClient = triggerInfo ? createClient(deps) : null;
	if (!(triggerInfo && ghClient)) {
		return null;
	}
	const triggerComment = sanitizeInput(triggerInfo.triggerText);
	const subject = {
		title: triggerInfo.issueTitle,
		body: triggerInfo.issueBody,
		number: triggerInfo.issueNumber,
		triggerComment,
		task: extractTask(triggerComment, inputs.triggerPhrase),
	};
	return {
		ghClient,
		triggerInfo,
		piContext: triggerInfo.isPullRequest
			? {
					type: "pull_request",
					...subject,
					...(await pullRequestDetails(ghClient, subject.number, log)),
				}
			: { type: "issue", ...subject },
	};
}
