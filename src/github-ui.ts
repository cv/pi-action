// Dialogs for pi-durable extensions (`ui.confirm`, `ui.select`, `ui.input`, `ui.notify`) as GitHub comments.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { type GitHubClient, toUserType } from "./github.ts";
import {
	type Allowlists,
	sanitizeInput,
	validatePermissions,
} from "./security.ts";
import type { DurableUi, GitHubComment, Log } from "./types.ts";
import { getErrorMessage } from "./utils.ts";

const MARKER_PREFIX = "<!-- pi-action:question";
const ANSWER_PATTERN = /^\/answer(?:\s+|$)/iu;
const TASK_ITEM = /^\s*[-*+]\s+\[([ xX])\]\s+(.*?)\s*$/u;
const LINE_BREAK = /\r?\n/u;
const WHITESPACE_RUN = /\s+/gu;
/** `input` looks this far back for replies, in case the runner's clock is ahead of GitHub's. */
const CLOCK_SLACK_MS = 60_000;
const CONFIRM_OPTIONS = ["Yes", "No"];
const NOTIFY_ICONS = { info: "ℹ️", warning: "⚠️", error: "❌" } as const;

const markerOf = (id: string): string => `<!-- pi-action:question ${id} -->`;

const oneLine = (text: string): string =>
	text.replaceAll(WHITESPACE_RUN, " ").trim();

/** A checkbox label: one line, never empty (an empty task-list item is not a checkbox on GitHub). */
const optionLabel = (option: string): string => oneLine(option) || "(empty)";

/** Comments that belong to questions (pi-action's own, and `/answer` replies) are never `@pi` triggers. */
export function isQuestionComment(body: string): boolean {
	return body.includes(MARKER_PREFIX) || ANSWER_PATTERN.test(body.trim());
}

export type CheckboxAnswer =
	| { status: "unanswered" }
	| { status: "answered"; index: number }
	/** The marker is gone or the options are not the ones asked: someone rewrote the question. */
	| { status: "changed" };

/**
 * The state of question `id`'s checkboxes in a comment body: the first checked option (`[x]` or `[X]`), none, or
 * "changed" when the body no longer starts with the question's marker or its task list is not exactly `options`.
 */
export function readCheckboxAnswer(
	body: string,
	id: string,
	options: readonly string[],
): CheckboxAnswer {
	if (!body.trimStart().startsWith(markerOf(id))) {
		return { status: "changed" };
	}
	const items = body.split(LINE_BREAK).flatMap((line) => {
		const match = TASK_ITEM.exec(line);
		return match ? [{ checked: match[1] !== " ", label: match[2] ?? "" }] : [];
	});
	if (
		items.length !== options.length ||
		items.some((item, index) => item.label !== options[index])
	) {
		return { status: "changed" };
	}
	const index = items.findIndex((item) => item.checked);
	return index === -1
		? { status: "unanswered" }
		: { status: "answered", index };
}

/** The answer in an `/answer <text>` reply (sanitized, the prefix removed); undefined for any other comment. */
export function readAnswerReply(body: string): string | undefined {
	const text = sanitizeInput(body);
	const match = ANSWER_PATTERN.exec(text);
	return match ? text.slice(match[0].length).trim() : undefined;
}

function formatDuration(ms: number): string {
	const seconds = Math.max(1, Math.round(ms / 1000));
	if (seconds % 60 === 0) {
		const minutes = seconds / 60;
		return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	}
	return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function renderQuestion(
	id: string,
	title: string,
	lines: readonly string[],
	footer: string,
): string {
	return [
		markerOf(id),
		`### ❓ ${oneLine(title) || "pi has a question"}`,
		"",
		...lines,
		"",
		footer,
	].join("\n");
}

/** The message as a blockquote, so none of its lines can pass for one of the question's checkboxes. */
const quoted = (text: string | undefined): string[] =>
	text?.trim()
		? [
				...text
					.trim()
					.split(LINE_BREAK)
					.map((line) => `> ${line}`.trimEnd()),
				"",
			]
		: [];

type Waited<T> =
	| { kind: "answered"; value: T }
	| { kind: "timeout" }
	| { kind: "aborted" };

export interface GitHubUiOptions {
	gh: GitHubClient;
	/** The issue or PR the questions are posted on. */
	issueNumber: number;
	/** Who may answer `input` questions: the same rules as for running pi. */
	allow: Allowlists;
	pollIntervalMs: number;
	/** How long a question waits for an answer. */
	timeoutMs: number;
	log: Log;
	/** Appends Markdown to the job summary. */
	summary?: ((markdown: string) => Promise<void>) | undefined;
	/** Question IDs (default: random UUIDs). */
	newId?: () => string;
}

/**
 * pi-durable dialogs as comments on the issue or PR. `confirm` and `select` post a task list and poll the comment
 * until a box is ticked (only people with write access can edit pi-action's comments); `input` waits for a reply
 * starting with `/answer` from someone allowed to run pi. A question that times out, is aborted, or is rewritten is
 * edited to say pi continued without an answer. `notify` goes to the log and the job summary, not to comments.
 */
export function createGitHubUi(options: GitHubUiOptions): DurableUi {
	const { gh, issueNumber, log } = options;
	const newId = options.newId ?? randomUUID;
	const waitsFor = formatDuration(options.timeoutMs);
	const consumed = new Set<number>();
	const ignored = new Set<number>();
	let summarized = false;

	async function waitFor<T>(
		check: () => Promise<T | undefined>,
		signal: AbortSignal | undefined,
	): Promise<Waited<T>> {
		const deadline = Date.now() + options.timeoutMs;
		for (;;) {
			const remaining = deadline - Date.now();
			if (signal?.aborted === true) {
				return { kind: "aborted" };
			}
			if (remaining <= 0) {
				return { kind: "timeout" };
			}
			try {
				// oxlint-disable-next-line eslint/no-await-in-loop -- polling waits between checks by design
				await sleep(
					Math.min(options.pollIntervalMs, remaining),
					undefined,
					signal ? { signal } : {},
				);
			} catch {
				return { kind: "aborted" };
			}
			try {
				// oxlint-disable-next-line eslint/no-await-in-loop -- one check per round
				const value = await check();
				if (value !== undefined) {
					return { kind: "answered", value };
				}
			} catch (error) {
				log.warning(`Could not check for an answer: ${getErrorMessage(error)}`);
			}
		}
	}

	/** Replace the question's footer with its outcome; `latest` when it still has the footer, else the original. */
	async function settle(
		commentId: number,
		bodies: { original: string; latest: string },
		footer: string,
		outcome: string,
	): Promise<void> {
		const base = bodies.latest.includes(footer)
			? bodies.latest
			: bodies.original;
		try {
			await gh.updateComment(commentId, base.replace(footer, outcome));
		} catch (error) {
			log.warning(
				`Could not update the question comment: ${getErrorMessage(error)}`,
			);
		}
	}

	function unanswered(kind: "timeout" | "aborted" | "changed"): string {
		if (kind === "timeout") {
			return `**⏱️ No answer within ${waitsFor}; pi continued without one.**`;
		}
		return kind === "aborted"
			? "**⏹️ pi stopped waiting (the run was stopped) and continued without an answer.**"
			: "**⚠️ This question was edited beyond its checkboxes, so pi ignored it and continued without an answer.**";
	}

	/** Post a checkbox question and wait for a box; the index of the first ticked option, or undefined. */
	async function askCheckboxes(
		title: string,
		message: string | undefined,
		labels: readonly string[],
		signal: AbortSignal | undefined,
	): Promise<number | undefined> {
		if (signal?.aborted === true) {
			return undefined;
		}
		const id = newId();
		const footer = `<sub>Tick one box to answer. pi waits up to ${waitsFor}, then continues without an answer.</sub>`;
		const original = renderQuestion(
			id,
			title,
			[...quoted(message), ...labels.map((label) => `- [ ] ${label}`)],
			footer,
		);
		const posted = await gh.createComment(issueNumber, original);
		log.info(`Asked on GitHub: ${oneLine(title)} (${posted.url})`);
		const bodies = { original, latest: original };
		const waited = await waitFor(async () => {
			bodies.latest = (await gh.getComment(posted.id)).body ?? "";
			const answer = readCheckboxAnswer(bodies.latest, id, labels);
			return answer.status === "unanswered" ? undefined : answer;
		}, signal);
		if (waited.kind === "answered" && waited.value.status === "answered") {
			const { index } = waited.value;
			const label = labels[index] ?? "";
			log.info(`Answered on GitHub: ${oneLine(title)}: ${label}`);
			await settle(posted.id, bodies, footer, `**✅ Answered: ${label}**`);
			return index;
		}
		const kind = waited.kind === "answered" ? "changed" : waited.kind;
		if (kind === "changed") {
			log.warning(
				`The question "${oneLine(title)}" (${posted.url}) was edited beyond its checkboxes; pi ignored it`,
			);
		} else {
			log.info(`No answer on GitHub to: ${oneLine(title)} (${kind})`);
		}
		await settle(
			posted.id,
			{ original, latest: original },
			footer,
			unanswered(kind),
		);
		return undefined;
	}

	/** 👍 on the reply that answered a question. */
	async function acknowledge(commentId: number): Promise<void> {
		try {
			await gh.addReaction({ source: "comment", issueNumber, commentId }, "+1");
		} catch (error) {
			log.warning(`Could not react to the answer: ${getErrorMessage(error)}`);
		}
	}

	/** The first `/answer` reply after the question from someone allowed to run pi, not used for another question. */
	function findReply(
		comments: readonly GitHubComment[],
		questionId: number,
	): { comment: GitHubComment; login: string; text: string } | undefined {
		for (const comment of comments) {
			const text = readAnswerReply(comment.body ?? "");
			const { user } = comment;
			if (
				comment.id > questionId &&
				!consumed.has(comment.id) &&
				text !== undefined &&
				user
			) {
				const author = { login: user.login, type: toUserType(user.type) };
				if (
					validatePermissions(author, comment.author_association, options.allow)
				) {
					consumed.add(comment.id);
					return { comment, login: user.login, text };
				}
				if (!ignored.has(comment.id)) {
					ignored.add(comment.id);
					log.info(
						`Ignoring /answer from @${user.login}, who is not allowed to run pi`,
					);
				}
			}
		}
		return undefined;
	}

	return {
		async confirm(title, message, dialog) {
			const index = await askCheckboxes(
				title,
				message,
				CONFIRM_OPTIONS,
				dialog?.signal,
			);
			return index === 0;
		},

		async select(title, choices, dialog) {
			if (choices.length === 0) {
				return undefined;
			}
			const index = await askCheckboxes(
				title,
				undefined,
				choices.map((choice) => optionLabel(choice)),
				dialog?.signal,
			);
			return index === undefined ? undefined : choices[index];
		},

		async input(title, placeholder, dialog) {
			const signal = dialog?.signal;
			if (signal?.aborted === true) {
				return undefined;
			}
			const since = new Date(Date.now() - CLOCK_SLACK_MS).toISOString();
			const footer = `<sub>Reply with a comment that starts with \`/answer\`; only replies from people allowed to run pi count. pi waits up to ${waitsFor}, then continues without an answer.</sub>`;
			const hint = placeholder?.trim()
				? [`For example: \`/answer ${oneLine(placeholder)}\``]
				: [];
			const original = renderQuestion(newId(), title, hint, footer);
			const posted = await gh.createComment(issueNumber, original);
			log.info(`Asked on GitHub: ${oneLine(title)} (${posted.url})`);
			const waited = await waitFor(
				async () =>
					findReply(await gh.listIssueComments(issueNumber, since), posted.id),
				signal,
			);
			const bodies = { original, latest: original };
			if (waited.kind !== "answered") {
				log.info(`No answer on GitHub to: ${oneLine(title)} (${waited.kind})`);
				await settle(posted.id, bodies, footer, unanswered(waited.kind));
				return undefined;
			}
			const { comment, login, text } = waited.value;
			log.info(`Answered on GitHub by @${login}: ${oneLine(title)}`);
			await Promise.all([
				settle(
					posted.id,
					bodies,
					footer,
					`**✅ Answered by @${login}** (${comment.html_url})`,
				),
				acknowledge(comment.id),
			]);
			return text;
		},

		notify(message, level = "info") {
			if (level === "info") {
				log.info(`pi: ${message}`);
			} else {
				log.warning(`pi (${level}): ${message}`);
			}
			const heading = summarized ? "" : "### pi notifications\n\n";
			summarized = true;
			options
				.summary?.(`${heading}- ${NOTIFY_ICONS[level]} ${oneLine(message)}\n`)
				.catch((error: unknown) => {
					log.warning(
						`Could not write the job summary: ${getErrorMessage(error)}`,
					);
				});
		},
	};
}
