import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runAgent } from "./agent.js";
import type { PIContext } from "./context.js";
import { extractTask, hasTrigger } from "./context.js";
import { formatErrorComment, formatSuccessComment } from "./formatting.js";
import {
	addReaction,
	extractTriggerInfo,
	type GitHubClient,
} from "./github.js";
import type { SecurityContext } from "./security.js";
import { sanitizeInput, validatePermissions } from "./security.js";
import { shareSession } from "./share.js";
import type { ModelConfig, RepoRef, Session, TriggerInfo } from "./types.js";

export interface ActionInputs {
	triggerPhrase: string;
	allowedBots: string[];
	modelConfig: ModelConfig;
	githubToken: string | undefined;
	gistToken: string | undefined;
	piAuthJson: string | undefined;
	promptTemplate: string | undefined;
	shareSession: boolean;
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
}

export interface ActionDependencies {
	inputs: ActionInputs;
	context: ActionContext;
	createClient: (token: string) => GitHubClient;
	log: Logger;
	cwd: string;
}

export function setupAuth(piAuthJson: string | undefined): void {
	if (piAuthJson) {
		const authDir = join(homedir(), ".pi", "agent");
		mkdirSync(authDir, { recursive: true });
		writeFileSync(join(authDir, "auth.json"), piAuthJson);
	}
}

/**
 * Validates that the trigger is authorized to run the agent.
 * Returns the trigger info if valid, null otherwise.
 */
function validateTrigger(
	deps: ActionDependencies,
): { triggerInfo: TriggerInfo; ghClient: GitHubClient } | null {
	const { inputs, context, createClient, log } = deps;

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

	if (!inputs.githubToken) {
		log.setFailed("github_token is required");
		return null;
	}

	const ghClient = createClient(inputs.githubToken);
	return { triggerInfo, ghClient };
}

/**
 * Builds the PI context from trigger info and inputs.
 */
async function buildPIContext(
	triggerInfo: TriggerInfo,
	ghClient: GitHubClient,
	triggerPhrase: string,
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

	// Get PR diff if applicable
	if (triggerInfo.isPullRequest) {
		piContext.diff = await ghClient.getPullRequestDiff(triggerInfo.issueNumber);
	}

	return piContext;
}

/**
 * Posts the agent result as a comment with appropriate reaction.
 */
async function postResult(
	ghClient: GitHubClient,
	gistClient: GitHubClient | undefined,
	triggerInfo: TriggerInfo,
	result:
		| { success: true; response: string; session?: Session }
		| { success: false; error: string; session?: Session },
	shareSessionEnabled: boolean,
	log: Logger,
): Promise<void> {
	let shareUrl: string | undefined;

	// Try to share session if enabled and session exists
	// Use gistClient if available, otherwise fall back to ghClient
	if (shareSessionEnabled && result.session) {
		const clientForGist = gistClient ?? ghClient;
		try {
			const shareResult = await shareSession(
				result.session,
				clientForGist,
				`pi-action session for ${result.success ? "success" : "error"}: ${triggerInfo.issueTitle}`,
			);
			if (shareResult) {
				shareUrl = shareResult.previewUrl;
				log.info(`Session shared: ${shareUrl}`);
			}
		} catch (error) {
			log.warning(`Failed to share session: ${error}`);
		}
	}

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

export async function run(deps: ActionDependencies): Promise<void> {
	const { inputs, log, cwd, createClient } = deps;

	setupAuth(inputs.piAuthJson);

	// Validate and extract trigger info
	const validated = validateTrigger(deps);
	if (!validated) {
		return;
	}

	const { triggerInfo, ghClient } = validated;

	// Create separate gist client if gist token is provided
	const gistClient = inputs.gistToken
		? createClient(inputs.gistToken)
		: undefined;

	// Add eyes reaction to acknowledge
	await addReaction(ghClient, triggerInfo, "eyes");

	// Build context
	const piContext = await buildPIContext(
		triggerInfo,
		ghClient,
		inputs.triggerPhrase,
	);

	log.info(`Running pi agent for: ${piContext.task}`);

	// Run the agent
	const result = await runAgent(piContext, {
		...inputs.modelConfig,
		cwd,
		logger: log,
		...(inputs.promptTemplate ? { promptTemplate: inputs.promptTemplate } : {}),
	});

	// Post result (use gistClient for session sharing if available)
	await postResult(
		ghClient,
		gistClient,
		triggerInfo,
		result,
		inputs.shareSession,
		log,
	);
}
