import type { Models } from "@earendil-works/pi-ai/models";
import type { Extension } from "@earendil-works/pi-durable";

import { buildPrompt, formatFollowUp, type PIContext } from "./context.ts";
import { ThreadConversation, type ThreadResult } from "./conversation.ts";
import { createDurableExtensions } from "./durable-extensions.ts";
import { loadExtensions } from "./extensions.ts";
import { formatErrorComment, formatSuccessComment } from "./formatting.ts";
import { createGitHubUi } from "./github-ui.ts";
import type { GitHubClient, ReactionTarget } from "./github.ts";
import type { ActionInputs } from "./inputs.ts";
import { createActionModels, findModel } from "./models.ts";
import { getRunContext } from "./run-context.ts";
import { GitSyncConflictError } from "./storage/sync.ts";
import { Thread } from "./thread.ts";
import { collectTriggers, type Trigger, triggerFromInfo } from "./triggers.ts";
import type { Log, TriggerInfo } from "./types.ts";
import { getErrorMessage } from "./utils.ts";

type Env = Record<string, string | undefined>;

export interface Logger extends Log {
	error: (msg: string) => void;
	setFailed: (msg: string) => void;
	setOutput: (name: string, value: string) => void;
}

export interface ActionDependencies {
	inputs: ActionInputs;
	/** The webhook payload of the event that started the workflow. */
	payload: Record<string, unknown>;
	createClient: (token: string) => GitHubClient;
	log: Logger;
	cwd: string;
	/** Override model setup (tests use a faux provider). */
	createModels?: ((inputs: ActionInputs) => Promise<Models>) | undefined;
	/** Git remote holding the thread refs. Default "origin". */
	remote?: string;
	env?: Env;
	/** Appends Markdown to the job summary (notifications from pi-durable extensions). */
	summary?: (markdown: string) => Promise<void>;
}

/**
 * The `extensions` input and the model setup: the built-in and custom providers and those extensions register
 * (unless `createModels` overrides it), and the pi-durable extensions for the thread, which get the GitHub UI when
 * the run posts to an issue or PR.
 */
async function setUp(
	deps: ActionDependencies,
	gh: GitHubClient,
	issueNumber: number | undefined,
): Promise<{ models: Models; extensions: Extension[] }> {
	const { inputs, log, cwd } = deps;
	const env = deps.env ?? process.env;
	const loaded = await loadExtensions({
		specs: inputs.extensions,
		cwd,
		log,
		env,
	});
	const models = deps.createModels
		? await deps.createModels(inputs)
		: await createActionModels(inputs, {
				providers: loaded.providers,
				env,
				log,
			});
	const ui =
		inputs.outputMode === "comment" && issueNumber !== undefined
			? createGitHubUi({
					gh,
					issueNumber,
					allow: inputs,
					pollIntervalMs: inputs.pollInterval * 1000,
					timeoutMs: inputs.uiTimeout * 1000,
					log,
					summary: deps.summary,
				})
			: undefined;
	const extensions = await createDurableExtensions(loaded.durable, {
		cwd,
		agentDir: inputs.agentDir,
		trustProject: inputs.trustProject,
		ui,
		log,
		env,
	});
	return { models, extensions };
}

/** On cancellation (SIGINT, then SIGTERM), push what the thread has so far before the runner kills us. */
function pushOnSignals(thread: Thread, log: Log): () => void {
	const handler = (signal: NodeJS.Signals) => {
		log.warning(`Received ${signal}; saving the thread before exiting`);
		thread
			.push()
			.catch((error: unknown) => {
				log.warning(getErrorMessage(error));
			})
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

/** The context of the first message of a thread, for the trigger that starts it. */
function contextFor(piContext: PIContext, trigger: Trigger): PIContext {
	return piContext.type === "direct"
		? piContext
		: { ...piContext, task: trigger.task, triggerComment: trigger.text };
}

/** A run from workflow_dispatch or a direct prompt: one request, keyed by the workflow run. */
function oneOffTrigger(piContext: PIContext, env: Env): Trigger {
	const runId = env["GITHUB_RUN_ID"] ?? String(Date.now());
	const attempt = env["GITHUB_RUN_ATTEMPT"] ?? "1";
	return {
		key: `run-${runId}-${attempt}`,
		source: "body",
		issueNumber: piContext.type === "direct" ? 0 : piContext.number,
		author: { login: env["GITHUB_ACTOR"] ?? "workflow", type: "User" },
		text: piContext.task,
		task: piContext.task,
		createdAt: new Date().toISOString(),
	};
}

/** What the run starts with: every unanswered trigger on the thread in comment mode, else one request. */
async function initialTriggers(
	deps: ActionDependencies,
	gh: GitHubClient,
	piContext: PIContext,
	triggerInfo: TriggerInfo | undefined,
	since: Date | undefined,
): Promise<Trigger[]> {
	const { inputs } = deps;
	if (!triggerInfo) {
		return [oneOffTrigger(piContext, deps.env ?? process.env)];
	}
	const current = triggerFromInfo(triggerInfo, inputs.triggerPhrase);
	return inputs.outputMode === "comment"
		? collectTriggers(gh, triggerInfo, inputs, since, current)
		: [current];
}

/** Close the thread, pushing it; a failure to save is a warning, not a failed run. */
async function closeThread(thread: Thread, log: Log): Promise<void> {
	try {
		await thread.close();
	} catch (error) {
		log.warning(
			error instanceof GitSyncConflictError
				? `${thread.ref} moved on the remote while this run worked; its history was not pushed. ${getErrorMessage(error)}`
				: `Could not save the thread: ${getErrorMessage(error)}`,
		);
	}
}

export async function run(deps: ActionDependencies): Promise<void> {
	const resolved = await getRunContext(deps);
	if (!resolved) {
		return;
	}
	const { piContext, ghClient: gh, triggerInfo } = resolved;
	const { inputs, log } = deps;
	log.info(`Running pi agent for: ${piContext.task}`);
	const issueNumber =
		piContext.type === "direct" ? undefined : piContext.number;
	// In comment mode, a trigger makes the run a conversation on its issue or PR (reactions, new comments join).
	const interactive = inputs.outputMode === "comment" ? triggerInfo : undefined;

	/** Set the outputs, or react on `target` and post the result unless it was posted before. Returns where it went. */
	const report = async (
		result: ThreadResult,
		target: ReactionTarget | undefined,
		ref?: string,
		alreadyPosted = false,
	): Promise<string | undefined> => {
		if (!result.success) {
			log.error(`pi execution failed: ${result.error}`);
		}
		if (inputs.outputMode === "output") {
			log.setOutput("success", String(result.success));
			log.setOutput(
				"response",
				result.success ? result.response : result.error,
			);
			return "output";
		}
		if (target) {
			await gh.addReaction(target, result.success ? "rocket" : "confused");
		}
		if (alreadyPosted || issueNumber === undefined) {
			return undefined;
		}
		const body = result.success
			? formatSuccessComment(result.response, ref)
			: formatErrorComment(result.error, ref);
		return (await gh.createComment(issueNumber, body)).url;
	};

	if (interactive) {
		await gh.addReaction(interactive, "eyes");
	}
	let thread: Thread | undefined;
	let stopSignals: (() => void) | undefined;
	try {
		const { models, extensions } = await setUp(deps, gh, issueNumber);
		const opened = await Thread.open({
			cwd: deps.cwd,
			issueNumber,
			models,
			model: findModel(models, inputs.provider, inputs.model),
			log,
			remote: deps.remote,
			extensions,
		});
		thread = opened;
		stopSignals = pushOnSignals(opened, log);
		log.info(
			opened.ref
				? `Thread ${opened.ref}: ${opened.isNew ? "new" : `since ${opened.startedAt?.toISOString()}`}`
				: "One-off conversation (not stored)",
		);
		// New comments: on a new thread, from the time of the trigger; on an existing one, since it began.
		const since =
			opened.startedAt ??
			new Date(
				Date.parse(interactive?.createdAt ?? new Date().toISOString()) - 1000,
			);
		const conversation = new ThreadConversation({
			thread: opened,
			log,
			timeoutSeconds: inputs.timeout,
			pollIntervalMs: inputs.pollInterval * 1000,
			message: async (trigger, first) =>
				first
					? buildPrompt(contextFor(piContext, trigger), inputs.promptTemplate)
					: formatFollowUp(trigger),
			deliver: async (trigger, result, alreadyPosted) =>
				report(
					result,
					interactive ? trigger : undefined,
					opened.ref,
					alreadyPosted,
				),
			...(interactive
				? { poll: async () => collectTriggers(gh, interactive, inputs, since) }
				: {}),
		});
		await conversation.run(
			await initialTriggers(deps, gh, piContext, triggerInfo, opened.startedAt),
		);
	} catch (error) {
		await report(
			{ success: false, error: getErrorMessage(error) },
			interactive,
		);
	} finally {
		stopSignals?.();
		if (thread) {
			await closeThread(thread, log);
		}
	}
}
