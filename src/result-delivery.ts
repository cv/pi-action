import { formatErrorComment, formatSuccessComment } from "./formatting.js";
import { addReaction, type GitHubClient } from "./github.js";
import type { Logger } from "./run.js";
import { shareSession } from "./share.js";
import type { AgentResult, TriggerInfo } from "./types.js";

export async function shareSessionForResult(
	ghClient: GitHubClient,
	gistClient: GitHubClient | undefined,
	issueTitle: string,
	result: AgentResult,
	shareSessionEnabled: boolean,
	log: Logger,
): Promise<string | undefined> {
	if (!(shareSessionEnabled && result.session)) {
		return undefined;
	}

	const clientForGist = gistClient ?? ghClient;
	try {
		const shareResult = await shareSession(
			result.session,
			clientForGist,
			`pi-action session for ${result.success ? "success" : "error"}: ${issueTitle}`,
		);
		if (shareResult) {
			log.info(`Session shared: ${shareResult.previewUrl}`);
			return shareResult.previewUrl;
		}
	} catch (error) {
		log.warning(`Failed to share session: ${error}`);
	}
	return undefined;
}

export async function postResult(
	ghClient: GitHubClient,
	gistClient: GitHubClient | undefined,
	triggerInfo: TriggerInfo,
	result: AgentResult,
	shareSessionEnabled: boolean,
	log: Logger,
): Promise<void> {
	const shareUrl = await shareSessionForResult(
		ghClient,
		gistClient,
		triggerInfo.issueTitle,
		result,
		shareSessionEnabled,
		log,
	);

	if (result.success) {
		await addReaction(ghClient, triggerInfo, "rocket");
		await ghClient.createComment(
			triggerInfo.issueNumber,
			formatSuccessComment(result.response, shareUrl),
		);
	} else {
		log.error(`pi execution failed: ${result.error}`);
		await addReaction(ghClient, triggerInfo, "confused");
		await ghClient.createComment(
			triggerInfo.issueNumber,
			formatErrorComment(result.error, shareUrl),
		);
	}
}

export function setResultOutputs(
	log: Logger,
	result: AgentResult,
	shareUrl: string | undefined,
): void {
	log.setOutput("success", result.success ? "true" : "false");
	log.setOutput("response", result.success ? result.response : result.error);
	if (shareUrl) {
		log.setOutput("share_url", shareUrl);
	}
}
