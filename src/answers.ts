// Answers to questions from pi-durable extensions, from the webhook event of a new run: a box ticked on a question
// (`issue_comment` `edited`) or an `/answer` reply (`issue_comment` `created`). Each becomes one submission to the
// thread: a message for the model, placed as a `ui.answer` entry that pit returns when the program asks again.
import {
	answeredBody,
	oneLine,
	parseQuestion,
	type PostedQuestion,
	readAnswerReply,
} from "./github-ui.ts";
import {
	extractTriggerInfo,
	fieldAt as field,
	type GitHubClient,
	toUserType,
} from "./github.ts";
import { type Allowlists, validatePermissions } from "./security.ts";
import type { Trigger } from "./triggers.ts";
import type {
	GitHubComment,
	GitHubUser,
	Log,
	TriggerInfo,
	UiAnswer,
} from "./types.ts";
import { getErrorMessage } from "./utils.ts";

export const ANSWER_KIND = "ui.answer";
/** Roles that can edit pi-action's comments (and so tick its boxes). */
const WRITE_ROLES = new Set(["admin", "maintain", "write"]);

/** An answer, and the issue or PR it belongs to. */
export interface AnswerEvent {
	info: TriggerInfo;
	trigger: Trigger;
}

export interface AnswerOptions {
	gh: GitHubClient;
	allow: Allowlists;
	log: Log;
}

const text = (value: unknown): string =>
	typeof value === "string" ? value : "";

/** What the event is for questions: a question comment that was edited, an `/answer` reply, or neither. */
export function questionEventKind(
	payload: Record<string, unknown>,
): "edit" | "reply" | undefined {
	if (field(payload, "issue") === undefined) {
		return undefined;
	}
	const body = text(field(payload, "comment", "body"));
	const action = field(payload, "action");
	if (action === "edited") {
		return parseQuestion(body) ? "edit" : undefined;
	}
	return action === "created" && readAnswerReply(body) ? "reply" : undefined;
}

/** The value pit gets, and how the answer is shown. */
function valueOf(
	question: PostedQuestion,
	index: number,
): { answer: boolean | string; shown: string } {
	const label = question.options[index] ?? "";
	return question.kind === "confirm"
		? { answer: index === 0, shown: label }
		: { answer: label, shown: label };
}

function answerTrigger(
	info: TriggerInfo,
	answer: UiAnswer,
	shown: string,
	from: {
		author: GitHubUser;
		commentId: number;
		questionId: number;
		createdAt: string;
	},
): AnswerEvent {
	const message = `**@${answer.by}** answered pi's question *${oneLine(answer.title)}* (${answer.url}): ${shown}`;
	return {
		info,
		trigger: {
			// One per question comment: a question asked again later (same key) is a new comment, and a new answer.
			key: `answer-${answer.key}-${from.questionId}`,
			source: "comment",
			issueNumber: info.issueNumber,
			commentId: from.commentId,
			author: from.author,
			text: message,
			task: message,
			createdAt: from.createdAt,
			url: answer.url,
			answer,
		},
	};
}

/** Whether `sender`, who edited pi-action's comment, may answer: write access, and the action's allowlists. */
async function mayTick(
	sender: GitHubUser,
	options: AnswerOptions,
): Promise<boolean> {
	if (sender.type === "Bot") {
		return validatePermissions(sender, "", options.allow);
	}
	if (
		options.allow.allowedUsers.length > 0 &&
		!validatePermissions(sender, "", options.allow)
	) {
		return false;
	}
	const role = await options.gh
		.getCollaboratorPermission(sender.login)
		.catch((error: unknown) => {
			options.log.warning(
				`Could not check @${sender.login}'s permission: ${getErrorMessage(error)}`,
			);
			return "none";
		});
	return WRITE_ROLES.has(role);
}

async function settle(
	gh: GitHubClient,
	comment: { id: number; body: string },
	shown: string,
	login: string,
	log: Log,
): Promise<void> {
	try {
		await gh.updateComment(
			comment.id,
			answeredBody(comment.body, shown, login),
		);
	} catch (error) {
		log.warning(
			`Could not mark the question answered: ${getErrorMessage(error)}`,
		);
	}
}

/** A box ticked on a question: the first box that was unticked before the edit and is ticked now. */
async function fromEdit(
	payload: Record<string, unknown>,
	info: TriggerInfo,
	options: AnswerOptions,
): Promise<AnswerEvent | undefined> {
	const { gh, log } = options;
	const commentId = Number(field(payload, "comment", "id"));
	const after = parseQuestion(text(field(payload, "comment", "body")));
	const before = parseQuestion(text(field(payload, "changes", "body", "from")));
	if (!(after && before) || before.key !== after.key || before.answered) {
		log.info("An edit of a question that is not a new answer; skipping");
		return undefined;
	}
	const sameOptions =
		before.options.length === after.options.length &&
		before.options.every((option, i) => option === after.options[i]);
	const index = after.ticked.findIndex(
		(ticked, i) => ticked && before.ticked[i] === false,
	);
	if (!sameOptions || index === -1) {
		log.info("No box was newly ticked on the question; skipping");
		return undefined;
	}
	const current = await gh.getComment(commentId);
	const now = parseQuestion(current.body ?? "");
	if (now?.key !== after.key || now.answered) {
		log.info(`The question ${info.url ?? ""} is already answered; skipping`);
		return undefined;
	}
	const login = text(field(payload, "sender", "login"));
	const sender: GitHubUser = {
		login,
		type: toUserType(text(field(payload, "sender", "type"))),
	};
	if (!(login && (await mayTick(sender, options)))) {
		log.warning(
			`@${login} ticked a box on ${info.url ?? "a question"} but may not answer (it takes write access and the allowed_* inputs); ignoring it`,
		);
		return undefined;
	}
	const { answer, shown } = valueOf(after, index);
	const url = info.url ?? current.html_url;
	log.info(`@${login} answered ${oneLine(after.title)} (${url}): ${shown}`);
	await settle(
		gh,
		{ id: commentId, body: current.body ?? "" },
		shown,
		login,
		log,
	);
	return answerTrigger(
		{ ...info, author: sender },
		{
			key: after.key,
			kind: after.kind,
			answer,
			by: login,
			url,
			title: after.title,
		},
		shown,
		{
			author: sender,
			commentId,
			questionId: commentId,
			createdAt:
				text(field(payload, "comment", "updated_at")) ||
				new Date().toISOString(),
		},
	);
}

/** The open `input` question a reply answers: the one it quotes, else the oldest one posted before it. */
function questionFor(
	comments: readonly GitHubComment[],
	replyId: number,
	quote: string,
): { comment: GitHubComment; question: PostedQuestion } | undefined {
	const open = comments.flatMap((comment) => {
		const question = parseQuestion(comment.body ?? "");
		return question?.kind === "input" &&
			!question.answered &&
			comment.id < replyId
			? [{ comment, question }]
			: [];
	});
	return (
		open.find(
			({ question }) => quote !== "" && quote.includes(question.title),
		) ?? open[0]
	);
}

/** 👍 on the reply that answered a question. */
async function thumbsUp(
	gh: GitHubClient,
	issueNumber: number,
	commentId: number,
	log: Log,
): Promise<void> {
	try {
		await gh.addReaction({ source: "comment", issueNumber, commentId }, "+1");
	} catch (error) {
		log.warning(`Could not react to the answer: ${getErrorMessage(error)}`);
	}
}

/** An `/answer` reply from someone allowed to run pi. */
async function fromReply(
	info: TriggerInfo,
	options: AnswerOptions,
): Promise<AnswerEvent | undefined> {
	const { gh, log } = options;
	const reply = readAnswerReply(info.triggerText);
	const replyId = info.commentId;
	if (reply === undefined || replyId === undefined) {
		return undefined;
	}
	if (
		!validatePermissions(info.author, info.authorAssociation, options.allow)
	) {
		log.warning(
			`Ignoring /answer from @${info.author.login}, who is not allowed to run pi`,
		);
		return undefined;
	}
	const found = questionFor(
		await gh.listIssueComments(info.issueNumber),
		replyId,
		reply.quote,
	);
	if (!found) {
		log.info("An /answer reply, but no question is waiting for one; skipping");
		return undefined;
	}
	const { comment, question } = found;
	const { login } = info.author;
	log.info(
		`@${login} answered ${oneLine(question.title)} (${comment.html_url})`,
	);
	await Promise.all([
		settle(
			gh,
			{ id: comment.id, body: comment.body ?? "" },
			reply.text,
			login,
			log,
		),
		thumbsUp(gh, info.issueNumber, replyId, log),
	]);
	return answerTrigger(
		info,
		{
			key: question.key,
			kind: question.kind,
			answer: reply.text,
			by: login,
			url: comment.html_url,
			title: question.title,
		},
		reply.text,
		{
			author: info.author,
			commentId: replyId,
			questionId: comment.id,
			createdAt: info.createdAt ?? new Date().toISOString(),
		},
	);
}

/**
 * The answer the event carries, after checking who gave it, with the question marked answered (and the reply 👍).
 * Undefined, with the reason in the log, when the event is not a valid new answer.
 */
export async function answerFromEvent(
	payload: Record<string, unknown>,
	options: AnswerOptions,
): Promise<AnswerEvent | undefined> {
	const kind = questionEventKind(payload);
	const info = kind ? extractTriggerInfo(payload) : null;
	if (!(kind && info)) {
		return undefined;
	}
	return kind === "edit"
		? fromEdit(payload, info, options)
		: fromReply(info, options);
}
