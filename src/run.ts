import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import type { Submission } from "@earendil-works/pi-durable";
import { buildPrompt, formatFollowUp } from "./context.js";
import type { PIContext } from "./context.js";
import { hasTrigger } from "./context.js";
import { DEFAULTS } from "./defaults.js";
import { formatErrorComment, formatSuccessComment } from "./formatting.js";
import {
	type GitHubClient,
	addReaction,
	extractTriggerInfo,
} from "./github.js";
import { createActionModels, findModel } from "./models.js";
import { validatePermissions } from "./security.js";
import type { SecurityContext } from "./security.js";
import { GitSyncConflictError } from "./storage/sync.js";
import { Thread } from "./thread.js";
import {
	type Trigger,
	type TriggerFilter,
	collectTriggers,
	triggerFromInfo,
} from "./triggers.js";
import type { ModelConfig, RepoRef, TriggerInfo } from "./types.js";
import { getErrorMessage } from "./utils.js";

export interface ActionInputs {
	triggerPhrase: string;
	allowedBots: string[];
	modelConfig: ModelConfig;
	githubToken: string | undefined;
	piAuthJson: string | undefined;
	modelsJson?: string | undefined;
	promptTemplate: string | undefined;
	/** Seconds between checks for new comments while pi works. */
	pollInterval?: number;
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
	/** Override model setup (tests use a faux provider). */
	createModels?: (inputs: ActionInputs, log: Logger) => Promise<Models>;
	/** Git remote holding the thread refs. Default "origin". */
	remote?: string;
}

type SettledRecord = Awaited<ReturnType<Submission["wait"]>>;

/**
 * Validates that the trigger is authorized to run the agent.
 * Returns the trigger info if valid, null otherwise.
 */
function validateTrigger(
	deps: ActionDependencies,
): { triggerInfo: TriggerInfo; ghClient: GitHubClient } | null {
	const { inputs, context, createClient, log } = deps;

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

	if (!inputs.githubToken) {
		log.setFailed("github_token is required");
		return null;
	}

	return { triggerInfo, ghClient: createClient(inputs.githubToken) };
}

function describeUnanswered(
	record: SettledRecord,
	timedOutAfter?: number,
): string {
	if (record.reason === "aborted" && timedOutAfter !== undefined) {
		return `Timeout after ${timedOutAfter} seconds`;
	}
	const detail =
		record.detail === undefined
			? ""
			: `: ${typeof record.detail === "string" ? record.detail : JSON.stringify(record.detail)}`;
	return `${record.reason ?? "unanswered"}${detail}`;
}

/** Waits that a timer can cut short, without keeping the process alive afterwards. */
function sleep(ms: number): { promise: Promise<void>; cancel: () => void } {
	let timer: NodeJS.Timeout | undefined;
	const promise = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, Math.max(0, ms));
	});
	return { promise, cancel: () => clearTimeout(timer) };
}

/** On cancellation (SIGINT, then SIGTERM), push what the thread has so far before the runner kills us. */
function pushOnSignals(thread: Thread, log: Logger): () => void {
	const handler = (signal: NodeJS.Signals) => {
		log.warning(`Received ${signal}; pushing ${thread.ref} before exiting`);
		thread
			.push()
			.catch((error) => log.warning(getErrorMessage(error)))
			.finally(() => process.exit(1));
	};
	process.once("SIGINT", handler);
	process.once("SIGTERM", handler);
	return () => {
		process.off("SIGINT", handler);
		process.off("SIGTERM", handler);
	};
}

class Conversation {
	private readonly handled = new Set<string>();
	private readonly pending = new Set<Promise<void>>();
	private posting: Promise<void> = Promise.resolve();
	private posted = new Map<string, string>();
	timedOut = false;

	constructor(
		private readonly deps: ActionDependencies,
		private readonly thread: Thread,
		private readonly gh: GitHubClient,
		private readonly info: TriggerInfo,
	) {}

	private get filter(): TriggerFilter {
		return {
			triggerPhrase: this.deps.inputs.triggerPhrase,
			allowedBots: this.deps.inputs.allowedBots,
		};
	}

	async run(): Promise<void> {
		const { inputs, log } = this.deps;
		this.posted = await this.thread.postedResults();
		const current = triggerFromInfo(this.info, inputs.triggerPhrase);
		// A new thread starts from this trigger; an existing one also picks up comments no run handled yet.
		const since = this.thread.startedAt;
		const pollSince = since ?? new Date(Date.parse(current.createdAt) - 1000);
		await this.submit(
			await collectTriggers(this.gh, this.info, this.filter, since, current),
		);

		const timeoutMs = inputs.modelConfig.timeout * 1000;
		const pollMs = (inputs.pollInterval ?? DEFAULTS.pollInterval) * 1000;
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				this.timedOut = true;
				break;
			}
			if (this.pending.size > 0) {
				const timer = sleep(Math.min(pollMs, remaining));
				await Promise.race([
					Promise.allSettled([...this.pending]),
					timer.promise,
				]);
				timer.cancel();
			}
			const fresh = (
				await collectTriggers(this.gh, this.info, this.filter, pollSince)
			).filter((trigger) => !this.handled.has(trigger.key));
			if (fresh.length > 0) {
				log.info(
					`${fresh.length} new comment(s) for pi; adding them to the conversation`,
				);
				await this.submit(fresh);
			} else if (this.pending.size === 0) {
				break;
			}
		}

		if (this.timedOut) {
			log.warning(
				`Timeout after ${inputs.modelConfig.timeout} seconds; aborting the run`,
			);
			await this.thread.abort();
		}
		await Promise.allSettled([...this.pending]);
		await this.posting;
	}

	private async submit(triggers: Trigger[]): Promise<void> {
		for (const trigger of triggers) {
			if (this.handled.has(trigger.key)) {
				continue;
			}
			const first = this.thread.isNew && this.handled.size === 0;
			this.handled.add(trigger.key);
			const content = first
				? buildPrompt(
						await this.issueContext(trigger),
						this.deps.inputs.promptTemplate,
					)
				: formatFollowUp({
						author: trigger.author.login,
						task: trigger.task,
						url: trigger.url,
						reviewComment: trigger.source === "review_comment",
					});
			const submission = await this.thread.submit({
				key: trigger.key,
				content,
				data: {
					author: trigger.author.login,
					url: trigger.url,
					source: trigger.source,
				},
			});
			const settled = submission
				.wait(BACKGROUND_CONTEXT)
				.then((record) => this.enqueueReport(trigger, record))
				.catch((error) => this.deps.log.warning(getErrorMessage(error)));
			this.pending.add(settled);
			settled.finally(() => this.pending.delete(settled));
		}
	}

	private async issueContext(trigger: Trigger): Promise<PIContext> {
		const context: PIContext = {
			type: this.info.isPullRequest ? "pull_request" : "issue",
			title: this.info.issueTitle,
			body: this.info.issueBody,
			number: this.info.issueNumber,
			triggerComment: trigger.text,
			task: trigger.task,
		};
		if (this.info.isPullRequest) {
			context.diff = await this.gh.getPullRequestDiff(this.info.issueNumber);
		}
		return context;
	}

	private enqueueReport(
		trigger: Trigger,
		record: SettledRecord,
	): Promise<void> {
		this.posting = this.posting
			.then(() => this.report(trigger, record))
			.catch((error) =>
				this.deps.log.warning(
					`Failed to post result: ${getErrorMessage(error)}`,
				),
			);
		return this.posting;
	}

	/** Post each answer (or failure) once, also across runs; react on every trigger it covers. */
	private async report(trigger: Trigger, record: SettledRecord): Promise<void> {
		const done = record.status === "done" && record.answer !== undefined;
		const key = done ? `answer-${record.answer}` : `error-${record.id}`;
		const footer = { ref: this.thread.ref };
		if (!this.posted.has(key)) {
			let body: string;
			if (done && record.answer !== undefined) {
				const text = await this.thread.answerText(record.answer);
				body = formatSuccessComment(
					text || "_(no text in the response)_",
					footer,
				);
			} else {
				const timedOutAfter = this.timedOut
					? this.deps.inputs.modelConfig.timeout
					: undefined;
				const reason = describeUnanswered(record, timedOutAfter);
				this.deps.log.error(`pi execution failed: ${reason}`);
				body = formatErrorComment(reason, footer);
			}
			const comment = await this.gh.createComment(this.info.issueNumber, body);
			this.posted.set(key, comment.url);
			await this.thread.markPosted(key, comment.url);
		} else if (!done) {
			return; // a failure an earlier run already reported
		}
		await addReaction(
			this.gh,
			{
				isCommentEvent: trigger.source !== "body",
				commentId: trigger.commentId,
				issueNumber: trigger.issueNumber,
				source: trigger.source,
			},
			done ? "rocket" : "confused",
		);
	}
}

const defaultModels = (inputs: ActionInputs, log: Logger): Promise<Models> =>
	createActionModels({
		authJson: inputs.piAuthJson,
		modelsJson: inputs.modelsJson,
		log: log.info,
	});

export async function run(deps: ActionDependencies): Promise<void> {
	const { inputs, log, cwd } = deps;

	const validated = validateTrigger(deps);
	if (!validated) {
		return;
	}
	const { triggerInfo, ghClient } = validated;

	// Acknowledge
	await addReaction(ghClient, triggerInfo, "eyes");

	let thread: Thread | undefined;
	let stopSignals: (() => void) | undefined;
	try {
		const models = await (deps.createModels ?? defaultModels)(inputs, log);
		const model = findModel(
			models as Parameters<typeof findModel>[0],
			inputs.modelConfig.provider,
			inputs.modelConfig.model,
		);
		thread = await Thread.open({
			cwd,
			issueNumber: triggerInfo.issueNumber,
			models,
			model,
			log,
			remote: deps.remote,
		});
		log.info(
			`Thread ${thread.ref}: ${thread.isNew ? "new" : `since ${thread.startedAt?.toISOString()}`}`,
		);
		stopSignals = pushOnSignals(thread, log);
		await new Conversation(deps, thread, ghClient, triggerInfo).run();
	} catch (error) {
		const message = getErrorMessage(error);
		log.error(`pi execution failed: ${message}`);
		await addReaction(ghClient, triggerInfo, "confused");
		await ghClient.createComment(
			triggerInfo.issueNumber,
			formatErrorComment(message),
		);
	} finally {
		try {
			await thread?.close();
		} catch (error) {
			const conflict = error instanceof GitSyncConflictError;
			log.warning(
				conflict
					? `${thread?.ref} moved on the remote while this run worked; its history was not pushed. ${getErrorMessage(error)}`
					: `Could not save the thread: ${getErrorMessage(error)}`,
			);
		}
		stopSignals?.();
	}
}
