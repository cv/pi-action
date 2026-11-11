// Questions from pi-durable extensions (`ui.ask`) as GitHub comments, and `ui.notify` as the log and job summary.
// pi-action is an asynchronous host: `ask` posts the question and returns at once. The answer (a ticked box, or an
// `/answer` reply) starts a later run, which delivers it to the thread (see answers.ts).
import type { GitHubClient } from "./github.ts";
import { sanitizeInput } from "./security.ts";
import type { DurableUi, Log, UiQuestion } from "./types.ts";
import { getErrorMessage } from "./utils.ts";

const MARKER_PREFIX = "<!-- pi-action:question";
/** Added to a question once it is answered; an open question has none. */
const ANSWERED_MARK = "<!-- pi-action:answered -->";
const KEY_PATTERN = /^[0-9a-f]{8,64}$/u;
const MARKER_PATTERN =
	/^<!-- pi-action:question ([0-9a-f]{8,64}) (confirm|select|input) -->/u;
const HEADING_PATTERN = /^### ❓ (.*)$/mu;
const ANSWER_PATTERN = /^\/answer(?:\s+|$)/iu;
const TASK_ITEM = /^\s*[-*+]\s+\[([ xX])\]\s+(.*?)\s*$/u;
const LINE_BREAK = /\r?\n/u;
const WHITESPACE_RUN = /\s+/gu;
const FOOTER_LINE = /^<sub>.*<\/sub>$/u;
const CONFIRM_OPTIONS: readonly string[] = ["Yes", "No"];
const NOTIFY_ICONS = { info: "ℹ️", warning: "⚠️", error: "❌" } as const;
const DEFAULT_TITLE = "pi has a question";

export const oneLine = (text: string): string =>
	text.replaceAll(WHITESPACE_RUN, " ").trim();

/** A checkbox label: one line, never empty (an empty task-list item is not a checkbox on GitHub). */
const optionLabel = (option: string): string => oneLine(option) || "(empty)";

/** Comments that belong to questions (pi-action's own, and `/answer` replies) are never `@pi` triggers. */
export function isQuestionComment(body: string): boolean {
	return body.includes(MARKER_PREFIX) || readAnswerReply(body) !== undefined;
}

/** A question comment as it reads now. */
export interface PostedQuestion {
	key: string;
	kind: UiQuestion["kind"];
	title: string;
	/** The task list (for confirm and select), in order, and which boxes are ticked. */
	options: string[];
	ticked: boolean[];
	answered: boolean;
}

/** The question in a comment body that starts with pi-action's marker; undefined for any other comment. */
export function parseQuestion(body: string): PostedQuestion | undefined {
	const marker = MARKER_PATTERN.exec(body.trimStart());
	const [, key, kind] = marker ?? [];
	if (
		key === undefined ||
		(kind !== "confirm" && kind !== "select" && kind !== "input")
	) {
		return undefined;
	}
	const items = body.split(LINE_BREAK).flatMap((line) => {
		const match = TASK_ITEM.exec(line);
		return match ? [{ ticked: match[1] !== " ", label: match[2] ?? "" }] : [];
	});
	return {
		key,
		kind,
		title: sanitizeInput(HEADING_PATTERN.exec(body)?.[1] ?? DEFAULT_TITLE),
		options: items.map((item) => item.label),
		ticked: items.map((item) => item.ticked),
		answered: body.includes(ANSWERED_MARK),
	};
}

/**
 * An `/answer <text>` reply: the answer (sanitized, the prefix removed) and the text the reply quotes first (GitHub's
 * "Quote reply" puts the quote before the answer). Undefined for any other comment.
 */
export function readAnswerReply(
	body: string,
): { text: string; quote: string } | undefined {
	const lines = sanitizeInput(body).split(LINE_BREAK);
	const start = lines.findIndex(
		(line) => line.trim() !== "" && !line.startsWith(">"),
	);
	const rest = start === -1 ? "" : lines.slice(start).join("\n").trim();
	const match = ANSWER_PATTERN.exec(rest);
	if (!match) {
		return undefined;
	}
	const quote = lines
		.slice(0, Math.max(start, 0))
		.map((line) => line.slice(1).trim())
		.join("\n")
		.trim();
	return { text: rest.slice(match[0].length).trim(), quote };
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

/** The checkbox labels a confirm or select question shows. */
function labelsOf(question: UiQuestion): string[] {
	if (question.kind === "confirm") {
		return [...CONFIRM_OPTIONS];
	}
	return question.kind === "select"
		? question.options.map((option) => optionLabel(option))
		: [];
}

const CHECKBOX_FOOTER =
	"<sub>Tick one box to answer. pi continues in a new run when you do; this run has ended.</sub>";
const REPLY_FOOTER =
	"<sub>Reply with a comment that starts with `/answer` (only replies from people allowed to run pi count). pi continues in a new run when you do; this run has ended.</sub>";

/** What a question shows between its title and footer: a task list, or an example `/answer` reply. */
function questionBody(question: UiQuestion): string[] {
	if (question.kind !== "input") {
		return [
			...quoted(question.kind === "confirm" ? question.message : undefined),
			...labelsOf(question).map((label) => `- [ ] ${label}`),
		];
	}
	return question.placeholder?.trim()
		? [`For example: \`/answer ${oneLine(question.placeholder)}\``]
		: [];
}

export function renderQuestion(question: UiQuestion): string {
	const body = questionBody(question);
	return [
		`<!-- pi-action:question ${question.key} ${question.kind} -->`,
		`### ❓ ${oneLine(question.title) || DEFAULT_TITLE}`,
		"",
		...body,
		"",
		question.kind === "input" ? REPLY_FOOTER : CHECKBOX_FOOTER,
	].join("\n");
}

/** The question's body once answered: the footer replaced by the answer and who gave it, and the answered mark. */
export function answeredBody(
	body: string,
	answer: string,
	login: string,
): string {
	const lines = body
		.trimEnd()
		.split(LINE_BREAK)
		.filter((line) => !FOOTER_LINE.test(line.trim()));
	return [
		...lines,
		`**✅ Answered: ${oneLine(answer) || "(empty)"} by @${login}**`,
		ANSWERED_MARK,
	].join("\n");
}

export interface GitHubUiOptions {
	gh: GitHubClient;
	/** The issue or PR the questions are posted on. */
	issueNumber: number;
	log: Log;
	/** Appends Markdown to the job summary. */
	summary?: ((markdown: string) => Promise<void>) | undefined;
}

/** The UI, and the questions this run asked (their comment URLs, oldest first). */
export interface GitHubUi extends DurableUi {
	readonly asked: readonly string[];
}

/**
 * pi-durable questions as comments on the issue or PR. `ask` posts a task list (`confirm`, `select`) or a request for
 * an `/answer` reply (`input`) and returns its URL at once; a question already open with the same key is not posted
 * twice. `notify` goes to the log and the job summary, not to comments.
 */
export function createGitHubUi(options: GitHubUiOptions): GitHubUi {
	const { gh, issueNumber, log } = options;
	const asked: string[] = [];
	let summarized = false;

	/** The URL of the open question with this key, if one was posted before. */
	async function openQuestion(
		question: UiQuestion,
	): Promise<string | undefined> {
		const comments = await gh.listIssueComments(issueNumber);
		const open = comments.find((comment) => {
			const posted = parseQuestion(comment.body ?? "");
			return (
				posted?.key === question.key &&
				posted.kind === question.kind &&
				!posted.answered
			);
		});
		return open?.html_url;
	}

	return {
		asked,

		async ask(question) {
			if (!KEY_PATTERN.test(question.key)) {
				throw new Error(
					`Invalid question key ${JSON.stringify(question.key)}: expected 8 to 64 lowercase hex characters`,
				);
			}
			if (question.kind === "select" && question.options.length === 0) {
				throw new Error(
					`The question "${oneLine(question.title)}" has no options`,
				);
			}
			const title = oneLine(question.title);
			const open = await openQuestion(question);
			if (open !== undefined) {
				log.info(`Already asked on GitHub, still open: ${title} (${open})`);
				asked.push(open);
				return { url: open };
			}
			const posted = await gh.createComment(
				issueNumber,
				renderQuestion(question),
			);
			log.info(`Asked on GitHub: ${title} (${posted.url})`);
			asked.push(posted.url);
			return { url: posted.url };
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
