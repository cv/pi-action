import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Models } from "@earendil-works/pi-ai/models";
import type { Extension } from "@earendil-works/pi-durable";

import { Activity, formatStats, oneLine } from "./activity.ts";
import { createBuiltinExtension } from "./builtin-extension.ts";
import { loadProjectContext } from "./context-files.ts";
import {
	buildPrompt,
	formatFollowUp,
	type PIContext,
	withReplyReminder,
} from "./context.ts";
import { ThreadConversation, type ThreadResult } from "./conversation.ts";
import { createDurableExtensions } from "./durable-extensions.ts";
import { loadExtensions } from "./extensions.ts";
import {
	formatErrorComment,
	formatSuccessComment,
	formatThreadLog,
	formatThreadSummary,
} from "./formatting.ts";
import { createGitHubUi, type GitHubUi } from "./github-ui.ts";
import {
	fieldAt,
	type GitHubClient,
	isForkPullRequest,
	type ReactionTarget,
} from "./github.ts";
import type { ActionInputs } from "./inputs.ts";
import { createActionModels, findModel } from "./models.ts";
import {
	expandTrigger,
	loadPromptTemplates,
	type PromptSource,
	type PromptTemplates,
} from "./prompts.ts";
import { getRunContext } from "./run-context.ts";
import {
	expandSkill,
	loadSkills,
	type SkillSource,
	type Skills,
} from "./skills.ts";
import { GitSyncConflictError } from "./storage/sync.ts";
import type { SnapshotLimits } from "./storage/worktree.ts";
import {
	loadSystemPromptFiles,
	type SystemPromptFiles,
} from "./system-prompt-files.ts";
import { Thread } from "./thread.ts";
import { toolEnv } from "./tool-env.ts";
import { collectTriggers, type Trigger, triggerFromInfo } from "./triggers.ts";
import type { Log, TriggerInfo } from "./types.ts";
import { getErrorMessage } from "./utils.ts";

type Env = Record<string, string | undefined>;

export interface Logger extends Log {
	debug: (msg: string) => void;
	error: (msg: string) => void;
	setFailed: (msg: string) => void;
	setOutput: (name: string, value: string) => void;
	startGroup: (name: string) => void;
	endGroup: () => void;
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
 * The sources of one kind in the repository and in `agent_dir`: the project's `dirs` with `trust_project` only
 * (anyone who can push a branch can change them), then `<agent_dir>/<kind>`.
 */
function localSources(
	deps: ActionDependencies,
	what: string,
	project: { source: string; dirs: readonly string[] },
	kind: string,
): { source: string; paths: string[] }[] {
	const { inputs, log, cwd } = deps;
	const present = project.dirs.filter((dir) => existsSync(join(cwd, dir)));
	if (!inputs.trustProject && present.length > 0) {
		log.info(
			`Not loading the ${what} in ${present.join(", ")}: trust_project is off`,
		);
	}
	return [
		...(inputs.trustProject
			? [
					{
						source: project.source,
						paths: project.dirs.map((dir) => join(cwd, dir)),
					},
				]
			: []),
		...(inputs.agentDir
			? [
					{
						source: "agent_dir",
						paths: [join(resolve(cwd, inputs.agentDir), kind)],
					},
				]
			: []),
	];
}

/** The prompt templates of the run: the extensions' `pi.prompts`, then `.pi/prompts`, then `<agent_dir>/prompts`. */
function promptTemplates(
	deps: ActionDependencies,
	packages: readonly PromptSource[],
): PromptTemplates {
	const templates = loadPromptTemplates(
		[
			...packages,
			...localSources(
				deps,
				"prompt templates",
				{ source: ".pi/prompts", dirs: [".pi/prompts"] },
				"prompts",
			),
		],
		deps.log,
	);
	if (templates.size > 0) {
		deps.log.info(
			`Prompt templates: ${[...templates.values()].map((t) => `/${t.name} (${t.source})`).join(", ")}`,
		);
	}
	return templates;
}

/**
 * The skills of the run: the packages' (`extensions`, then `skills`), then the project's `.pi/skills` and
 * `.agents/skills`, then `<agent_dir>/skills`.
 */
function runSkills(
	deps: ActionDependencies,
	packages: readonly SkillSource[],
): Skills {
	const skills = loadSkills(
		[
			...packages,
			...localSources(
				deps,
				"skills",
				{ source: "project", dirs: [".pi/skills", ".agents/skills"] },
				"skills",
			),
		],
		deps.log,
	);
	if (skills.size > 0) {
		const listed = [...skills.values()].map(
			(skill) =>
				`${skill.name} (${skill.source}${skill.disableModelInvocation ? `, /skill:${skill.name} only` : ""})`,
		);
		deps.log.info(`Skills: ${listed.join(", ")}`);
	}
	return skills;
}

/**
 * The `extensions` input and the model setup: the built-in and custom providers and those extensions register
 * (unless `createModels` overrides it), the pi-durable extensions for the thread, which get the GitHub UI when
 * the run posts to an issue or PR, and the variables the agent's tools get (see `toolEnv()`). pi-durable extensions
 * run in this process, so when there are any, those variables are set in its environment too (after npm ran).
 */
async function setUp(
	deps: ActionDependencies,
	gh: GitHubClient,
	issueNumber: number | undefined,
): Promise<{
	models: Models;
	extensions: Extension[];
	tools: Record<string, string>;
	ui: GitHubUi | undefined;
	templates: PromptTemplates;
	context: string | undefined;
	skills: Skills;
	systemPrompt: SystemPromptFiles;
}> {
	const { inputs, log, cwd } = deps;
	const env = deps.env ?? process.env;
	const loaded = await loadExtensions({
		specs: inputs.extensions,
		skillSpecs: inputs.skills,
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
	const tools = await toolEnv({ token: inputs.githubToken, cwd, env });
	if (Object.keys(tools).length > 0) {
		log.info(`The agent's tools get ${Object.keys(tools).join(", ")}`);
	}
	if (loaded.durable.length > 0) {
		Object.assign(env, tools);
	}
	const ui =
		inputs.outputMode === "comment" && issueNumber !== undefined
			? createGitHubUi({ gh, issueNumber, log, summary: deps.summary })
			: undefined;
	const extensions = await createDurableExtensions(loaded.durable, {
		cwd,
		agentDir: inputs.agentDir,
		trustProject: inputs.trustProject,
		ui,
		log,
		env,
	});
	return {
		models,
		extensions,
		tools,
		ui,
		templates: promptTemplates(deps, loaded.prompts),
		context: await projectContext(deps, env),
		skills: runSkills(deps, loaded.skills),
		systemPrompt: await systemPromptFiles(deps, env),
	};
}

/** On a pull request from a fork, the base commit to read the context files from (its author controls the checkout). */
function forkBase(
	deps: ActionDependencies,
): { sha: string; remote: string } | undefined {
	if (!isForkPullRequest(deps.payload)) {
		return undefined;
	}
	const sha = fieldAt(deps.payload, "pull_request", "base", "sha");
	return {
		sha: typeof sha === "string" ? sha : "",
		remote: deps.remote ?? "origin",
	};
}

/** The `project_context` section of the run (the `context_files` input), read once. */
async function projectContext(
	deps: ActionDependencies,
	env: Env,
): Promise<string | undefined> {
	const { inputs, log, cwd } = deps;
	if (!inputs.contextFiles) {
		log.info("Context files: off (context_files)");
		return undefined;
	}
	const loaded = await loadProjectContext({
		cwd,
		workspace: env["GITHUB_WORKSPACE"] || undefined,
		agentDir: inputs.agentDir ? resolve(cwd, inputs.agentDir) : undefined,
		maxBytes: inputs.contextFilesMaxBytes,
		base: forkBase(deps),
		log,
	});
	return loaded.text;
}

/** `SYSTEM.md` and `APPEND_SYSTEM.md` of the run (the `system_prompt_files` input), read once. */
async function systemPromptFiles(
	deps: ActionDependencies,
	env: Env,
): Promise<SystemPromptFiles> {
	const { inputs, log, cwd } = deps;
	if (!inputs.systemPromptFiles) {
		log.info("System prompt files: off (system_prompt_files)");
		return {};
	}
	return loadSystemPromptFiles({
		cwd,
		workspace: env["GITHUB_WORKSPACE"] || undefined,
		agentDir: inputs.agentDir ? resolve(cwd, inputs.agentDir) : undefined,
		trustProject: inputs.trustProject,
		fork: isForkPullRequest(deps.payload),
		maxBytes: inputs.contextFilesMaxBytes,
		log,
	});
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

/** One line for the model, its thinking level, the tools it gets, and the pi-durable extensions, after the setup group. */
function describeSetup(
	inputs: ActionInputs,
	extensions: readonly Extension[],
	{ modelTools, thinkingLevel }: Pick<Thread, "modelTools" | "thinkingLevel">,
): string {
	const loaded = extensions.map(
		(extension) =>
			`${extension.name} (${(extension.tools ?? []).map((tool) => tool.name).join(", ") || "no tools"})`,
	);
	const thinking =
		thinkingLevel === undefined ? "" : ` · thinking ${thinkingLevel}`;
	return `🤖 ${inputs.provider}/${inputs.model}${thinking} · tools: ${modelTools.join(", ")}${loaded.length > 0 ? ` · extensions: ${loaded.join(", ")}` : ""}`;
}

/** One line for a request as pi gets it: who, where, and its first line (as typed, for a prompt template or skill). */
function describeTrigger(trigger: Trigger): string {
	const what = trigger.answer ? "Answer" : "Request";
	const where = trigger.url ? ` (${trigger.url})` : "";
	const { template, skill } = trigger;
	let request = oneLine(trigger.task || trigger.text);
	if (template) {
		request = `${oneLine(template.typed)} (prompt template from ${template.source})`;
	} else if (skill) {
		request = `${oneLine(skill.typed)} (skill from ${skill.source})`;
	}
	return `▶ ${what} from @${trigger.author.login}${where}: ${request}`;
}

/** The context of the first message of a thread, for the trigger that starts it. */
function contextFor(piContext: PIContext, trigger: Trigger): PIContext {
	return piContext.type === "direct"
		? { ...piContext, task: trigger.task }
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
	answer: Trigger | undefined,
): Promise<Trigger[]> {
	const { inputs } = deps;
	if (!triggerInfo) {
		return [oneOffTrigger(piContext, deps.env ?? process.env)];
	}
	const current = answer ?? triggerFromInfo(triggerInfo, inputs.triggerPhrase);
	return inputs.outputMode === "comment"
		? collectTriggers(gh, triggerInfo, inputs, since, current)
		: [current];
}

/** The working-tree snapshot limits of the thread; undefined (off) by input and on fork pull requests. */
function worktreeLimits(deps: ActionDependencies): SnapshotLimits | undefined {
	const { inputs, log } = deps;
	if (!inputs.worktreeSnapshots) {
		return undefined;
	}
	if (isForkPullRequest(deps.payload)) {
		log.info(
			"A pull request from a fork: its token can't push, so the working tree is not saved",
		);
		return undefined;
	}
	return inputs.worktreeLimits;
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

/** The thread, first thing in the log: whether it is new, with how to read it with git in its group. */
function announceThread(deps: ActionDependencies, thread: Thread): void {
	const { log } = deps;
	if (thread.ref === undefined) {
		log.info("🧵 One-off conversation (not stored)");
		return;
	}
	const since = thread.startedAt
		?.toISOString()
		.replace(/:\d\d\.\d+Z$/u, " UTC");
	log.startGroup(
		`🧵 Thread ${thread.ref}: ${since === undefined ? "new" : `continuing, started ${since.replace("T", " ")}`}`,
	);
	log.info(formatThreadLog(thread.ref, deps.remote ?? "origin"));
	log.endGroup();
}

/** After the final push: where the thread is now, in the log, and how to read it, in the job summary. */
async function showThread(
	deps: ActionDependencies,
	thread: Thread,
	ref: string,
): Promise<void> {
	const { log } = deps;
	const remote = deps.remote ?? "origin";
	const { tip } = thread;
	log.info(
		`🧵 ${ref} is at ${tip === undefined ? "(nothing stored)" : tip.slice(0, 7)}`,
	);
	try {
		await deps.summary?.(formatThreadSummary(ref, remote));
	} catch (error) {
		log.warning(`Could not write the job summary: ${getErrorMessage(error)}`);
	}
}

export async function run(deps: ActionDependencies): Promise<void> {
	const resolved = await getRunContext(deps);
	if (!resolved) {
		return;
	}
	const { piContext, ghClient: gh, triggerInfo } = resolved;
	const { inputs, log } = deps;
	const activity = new Activity(log);
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
		const stats = formatStats(activity.take());
		if (inputs.outputMode === "output") {
			log.info(`${result.success ? "✅" : "❌"} Set the outputs (${stats})`);
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
		const { url } = await gh.createComment(issueNumber, body);
		log.info(
			`${result.success ? "✅ Replied" : "❌ Reported the error"}: ${url} (${stats})`,
		);
		return url;
	};

	if (interactive) {
		await gh.addReaction(interactive, "eyes");
	}
	let thread: Thread | undefined;
	let stopSignals: (() => void) | undefined;
	try {
		log.startGroup("Setup");
		let setup: Awaited<ReturnType<typeof setUp>>;
		try {
			setup = await setUp(deps, gh, issueNumber);
		} finally {
			log.endGroup();
		}
		const {
			models,
			extensions,
			tools,
			ui,
			templates,
			context,
			skills,
			systemPrompt,
		} = setup;
		// Tools of pi-durable extensions can say how the log shows their calls (`present`).
		activity.useTools(extensions.flatMap((extension) => extension.tools ?? []));
		// `/skill:<name>` first, so a template can't take a skill's command.
		const expand = (triggers: Trigger[]) =>
			triggers.map((trigger) => {
				const expanded = expandSkill(trigger, skills);
				return expanded === trigger
					? expandTrigger(trigger, templates)
					: expanded;
			});
		const opened = await Thread.open({
			cwd: deps.cwd,
			issueNumber,
			models,
			model: findModel(models, inputs.provider, inputs.model),
			thinkingLevel: inputs.thinkingLevel,
			log,
			remote: deps.remote,
			extensions: [
				createBuiltinExtension({
					projectContext: context,
					skills,
					systemPrompt: systemPrompt.system?.content,
					appendSystemPrompt: systemPrompt.append?.content,
				}),
				...extensions,
			],
			tools: { exclude: inputs.excludeTools, hidden: inputs.modelToolsHidden },
			toolEnv: tools,
			worktree: worktreeLimits(deps),
			onEntries: (entries) => {
				activity.entries(entries);
			},
		});
		thread = opened;
		log.info(describeSetup(inputs, extensions, opened));
		stopSignals = pushOnSignals(opened, log);
		announceThread(deps, opened);
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
			message: async (trigger, first) => {
				// As `report` does, pi-action posts the reply: say so, or pi may post it with `gh` too (#42).
				const repliesAsComment =
					inputs.outputMode === "comment" && issueNumber !== undefined;
				if (first && !trigger.answer) {
					return buildPrompt(
						contextFor(piContext, trigger),
						inputs.promptTemplate,
						{ repliesAsComment },
					);
				}
				const message = trigger.answer ? trigger.text : formatFollowUp(trigger);
				return repliesAsComment ? withReplyReminder(message) : message;
			},
			started: (trigger) => {
				log.info(describeTrigger(trigger));
			},
			deliver: async (trigger, result, alreadyPosted) =>
				report(
					result,
					interactive ? trigger : undefined,
					opened.ref,
					alreadyPosted,
				),
			...(interactive
				? {
						poll: async () =>
							expand(await collectTriggers(gh, interactive, inputs, since)),
					}
				: {}),
			...(ui ? { asked: () => ui.asked } : {}),
		});
		await conversation.run(
			expand(
				await initialTriggers(
					deps,
					gh,
					piContext,
					triggerInfo,
					opened.startedAt,
					resolved.answer,
				),
			),
		);
		if (conversation.failures.length > 0) {
			log.setFailed(
				`pi could not answer ${conversation.failures.length} comment(s): ${conversation.failures.join("; ")}`,
			);
		}
	} catch (error) {
		await report(
			{ success: false, error: getErrorMessage(error) },
			interactive,
		);
	} finally {
		stopSignals?.();
		if (thread) {
			await closeThread(thread, log);
			if (thread.ref !== undefined) {
				await showThread(deps, thread, thread.ref);
			}
		}
	}
}
