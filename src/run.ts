import type { Models } from "@earendil-works/pi-ai/models";
import { buildPrompt, formatFollowUp, type PIContext } from "./context.js";
import { ThreadConversation, type ThreadResult } from "./conversation.js";
import { DEFAULTS } from "./defaults.js";
import {
	type CommentFooter,
	formatErrorComment,
	formatSuccessComment,
} from "./formatting.js";
import { addReaction, type GitHubClient } from "./github.js";
import { createActionModels, findModel } from "./models.js";
import { getRunContext } from "./run-context.js";
import { GitSyncConflictError } from "./storage/sync.js";
import { Thread } from "./thread.js";
import {
	collectTriggers,
	type Trigger,
	type TriggerFilter,
	triggerFromInfo,
} from "./triggers.js";
import type {
	CustomProviderConfig,
	ModelConfig,
	RepoRef,
	TriggerInfo,
} from "./types.js";
import { getErrorMessage } from "./utils.js";

type OutputMode = "comment" | "output";

const RUN_ID_ENV = "GITHUB_RUN_ID";
const RUN_ATTEMPT_ENV = "GITHUB_RUN_ATTEMPT";
const ACTOR_ENV = "GITHUB_ACTOR";

export interface ActionInputs {
	triggerPhrase: string;
	allowedBots: string[];
	allowedUsers: string[];
	allowedAssociations: string[];
	modelConfig: ModelConfig;
	githubToken: string | undefined;
	apiKey: string | undefined;
	customProvider: CustomProviderConfig | undefined;
	promptTemplate: string | undefined;
	outputMode: OutputMode;
	prompt: string | undefined;
	prNumber: number | undefined;
	/** Seconds between checks for new comments while pi works. */
	pollInterval: number;
}

interface ActionContext {
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
	/** Override model setup (tests use a faux provider). */
	createModels?: (inputs: ActionInputs) => Promise<Models>;
	/** Git remote holding the thread refs. Default "origin". */
	remote?: string;
	env?: Record<string, string | undefined>;
}

const defaultModels = (inputs: ActionInputs): Promise<Models> =>
	createActionModels({
		provider: inputs.modelConfig.provider,
		model: inputs.modelConfig.model,
		apiKey: inputs.apiKey,
		customProvider: inputs.customProvider,
	});

/** On cancellation (SIGINT, then SIGTERM), push what the thread has so far before the runner kills us. */
function pushOnSignals(thread: Thread, log: Logger): () => void {
	const handler = (signal: NodeJS.Signals) => {
		log.warning(`Received ${signal}; saving the thread before exiting`);
		thread
			.push()
			.catch((error: unknown) => log.warning(getErrorMessage(error)))
			.finally(() => {
				process.exitCode = 1;
				process.kill(process.pid, "SIGKILL");
			})
			.catch(() => undefined);
	};
	process.once("SIGINT", handler);
	process.once("SIGTERM", handler);
	return () => {
		process.off("SIGINT", handler);
		process.off("SIGTERM", handler);
	};
}

function reactionTarget(trigger: Trigger) {
	return {
		isCommentEvent: trigger.source !== "body",
		issueNumber: trigger.issueNumber,
		source: trigger.source,
		...(trigger.commentId === undefined
			? {}
			: { commentId: trigger.commentId }),
	};
}

function issueNumberOf(piContext: PIContext): number | undefined {
	return piContext.type === "direct" ? undefined : piContext.number;
}

/** The context of the first message of a thread, for the trigger that starts it. */
function contextFor(piContext: PIContext, trigger: Trigger): PIContext {
	return piContext.type === "direct"
		? piContext
		: { ...piContext, task: trigger.task, triggerComment: trigger.text };
}

/** A run from workflow_dispatch or a direct prompt: one request, keyed by the workflow run. */
function oneOffTrigger(
	piContext: PIContext,
	env: Record<string, string | undefined>,
): Trigger {
	const runId = env[RUN_ID_ENV] ?? String(Date.now());
	const attempt = env[RUN_ATTEMPT_ENV] ?? "1";
	return {
		key: `run-${runId}-${attempt}`,
		source: "body",
		issueNumber: issueNumberOf(piContext) ?? 0,
		author: { login: env[ACTOR_ENV] ?? "workflow", type: "User" },
		text: piContext.task,
		task: piContext.task,
		createdAt: new Date().toISOString(),
	};
}

class ActionRun {
	private readonly deps: ActionDependencies;
	private readonly gh: GitHubClient;
	private readonly piContext: PIContext;
	private readonly triggerInfo: TriggerInfo | undefined;
	private readonly env: Record<string, string | undefined>;

	constructor(
		deps: ActionDependencies,
		gh: GitHubClient,
		piContext: PIContext,
		triggerInfo: TriggerInfo | undefined,
	) {
		this.deps = deps;
		this.gh = gh;
		this.piContext = piContext;
		this.triggerInfo = triggerInfo;
		this.env = deps.env ?? process.env;
	}

	private get inputs(): ActionInputs {
		return this.deps.inputs;
	}

	private get filter(): TriggerFilter {
		const { triggerPhrase, allowedBots, allowedUsers, allowedAssociations } =
			this.inputs;
		return { triggerPhrase, allowedBots, allowedUsers, allowedAssociations };
	}

	/** Comments on the issue/PR, in comment mode with a trigger; everything else is a one-off. */
	private get interactive(): boolean {
		return (
			this.inputs.outputMode === "comment" && this.triggerInfo !== undefined
		);
	}

	async start(): Promise<void> {
		const { triggerInfo, inputs } = this;
		if (this.interactive && triggerInfo) {
			await addReaction(this.gh, triggerInfo, "eyes");
		}
		let thread: Thread | undefined;
		let stopSignals: (() => void) | undefined;
		try {
			const models = await (this.deps.createModels ?? defaultModels)(inputs);
			const model = findModel(
				models,
				inputs.modelConfig.provider,
				inputs.modelConfig.model,
			);
			thread = await Thread.open({
				cwd: this.deps.cwd,
				issueNumber: issueNumberOf(this.piContext),
				models,
				model,
				log: this.deps.log,
				remote: this.deps.remote,
			});
			stopSignals = pushOnSignals(thread, this.deps.log);
			await this.converse(thread);
		} catch (error) {
			await this.fail(getErrorMessage(error));
		} finally {
			stopSignals?.();
			await this.finish(thread);
		}
	}

	private footer(thread?: Thread): CommentFooter {
		return { ref: thread?.ref };
	}

	private async converse(thread: Thread): Promise<void> {
		const { triggerInfo } = this;
		this.deps.log.info(
			thread.ref
				? `Thread ${thread.ref}: ${thread.isNew ? "new" : `since ${thread.startedAt?.toISOString()}`}`
				: "One-off conversation (not stored)",
		);
		const conversation = new ThreadConversation({
			thread,
			log: this.deps.log,
			timeoutSeconds: this.inputs.modelConfig.timeout,
			pollIntervalMs:
				(this.inputs.pollInterval || DEFAULTS.pollInterval) * 1000,
			message: (trigger, first) => this.message(trigger, first),
			deliver: (trigger, result, alreadyPosted) =>
				this.deliver(thread, trigger, result, alreadyPosted),
			...(this.interactive && triggerInfo
				? { poll: () => this.poll(thread, triggerInfo) }
				: {}),
		});
		if (!(this.interactive && triggerInfo)) {
			const trigger = triggerInfo
				? triggerFromInfo(triggerInfo, this.inputs.triggerPhrase)
				: oneOffTrigger(this.piContext, this.env);
			await conversation.run([trigger]);
			return;
		}
		const current = triggerFromInfo(triggerInfo, this.inputs.triggerPhrase);
		await conversation.run(
			await collectTriggers(
				this.gh,
				triggerInfo,
				this.filter,
				thread.startedAt,
				current,
			),
		);
	}

	/** New thread: from the time of the trigger; existing one: everything since it began. */
	private poll(thread: Thread, info: TriggerInfo): Promise<Trigger[]> {
		const since =
			thread.startedAt ??
			new Date(Date.parse(info.createdAt ?? new Date().toISOString()) - 1000);
		return collectTriggers(this.gh, info, this.filter, since);
	}

	private message(trigger: Trigger, first: boolean): Promise<string> {
		if (first) {
			return Promise.resolve(
				buildPrompt(
					contextFor(this.piContext, trigger),
					this.inputs.promptTemplate,
				),
			);
		}
		return Promise.resolve(
			formatFollowUp({
				author: trigger.author.login,
				task: trigger.task,
				reviewComment: trigger.source === "review_comment",
				...(trigger.url ? { url: trigger.url } : {}),
			}),
		);
	}

	private async deliver(
		thread: Thread,
		trigger: Trigger,
		result: ThreadResult,
		alreadyPosted: boolean,
	): Promise<string | undefined> {
		const { log } = this.deps;
		if (!result.success) {
			log.error(`pi execution failed: ${result.error}`);
		}
		if (this.inputs.outputMode === "output") {
			this.setOutputs(result);
			return "output";
		}
		if (this.interactive) {
			await addReaction(
				this.gh,
				reactionTarget(trigger),
				result.success ? "rocket" : "confused",
			);
		}
		if (alreadyPosted) {
			return;
		}
		const number = issueNumberOf(this.piContext);
		if (number === undefined) {
			log.setFailed(
				"comment output mode requires an issue or pull request trigger",
			);
			return;
		}
		const footer = this.footer(thread);
		const body = result.success
			? formatSuccessComment(result.response, footer)
			: formatErrorComment(result.error, footer);
		return (await this.gh.createComment(number, body)).url;
	}

	private setOutputs(result: ThreadResult): void {
		const { log } = this.deps;
		log.setOutput("success", result.success ? "true" : "false");
		log.setOutput("response", result.success ? result.response : result.error);
	}

	/** A failure before the conversation could run (no model, no thread). */
	private async fail(message: string): Promise<void> {
		const { triggerInfo } = this;
		const result: ThreadResult = { success: false, error: message };
		this.deps.log.error(`pi execution failed: ${message}`);
		if (this.inputs.outputMode === "output") {
			this.setOutputs(result);
			return;
		}
		if (triggerInfo) {
			await addReaction(this.gh, triggerInfo, "confused");
		}
		const number = issueNumberOf(this.piContext);
		if (number !== undefined) {
			await this.gh.createComment(number, formatErrorComment(message));
		}
	}

	private async finish(thread: Thread | undefined): Promise<void> {
		const { log } = this.deps;
		if (!thread) {
			return;
		}
		try {
			await thread.close();
		} catch (error) {
			const conflict = error instanceof GitSyncConflictError;
			log.warning(
				conflict
					? `${thread.ref} moved on the remote while this run worked; its history was not pushed. ${getErrorMessage(error)}`
					: `Could not save the thread: ${getErrorMessage(error)}`,
			);
		}
	}
}

export async function run(deps: ActionDependencies): Promise<void> {
	const runContext = await getRunContext(deps);
	if (!runContext) {
		return;
	}
	const { piContext, ghClient, triggerInfo } = runContext;
	deps.log.info(`Running pi agent for: ${piContext.task}`);
	await new ActionRun(deps, ghClient, piContext, triggerInfo).start();
}
