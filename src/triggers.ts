import { extractTask, hasTrigger } from "./context.ts";
import { isQuestionComment } from "./github-ui.ts";
import { type GitHubClient, toUserType } from "./github.ts";
import {
	type Allowlists,
	sanitizeInput,
	validatePermissions,
} from "./security.ts";
import type {
	GitHubComment,
	GitHubUser,
	TriggerInfo,
	TriggerSource,
	UiAnswer,
} from "./types.ts";

/** One request for pi: an issue/PR body or comment that mentions the trigger phrase. */
export interface Trigger {
	/** Stable per GitHub item; used as the submission's requestId so it is answered once. */
	key: string;
	source: TriggerSource;
	issueNumber: number;
	commentId?: number;
	author: GitHubUser;
	/** The sanitized text, and the task: what follows the trigger phrase. */
	text: string;
	task: string;
	createdAt: string;
	url?: string;
	/** Set when this is the answer to a question from a pi-durable extension; `text` is the message for the model. */
	answer?: UiAnswer;
}

/** Who may run pi, and how they ask: the trigger_phrase and allowed_* inputs. */
export interface TriggerFilter extends Allowlists {
	triggerPhrase: string;
}

export function triggerKey(
	source: TriggerSource,
	issueNumber: number,
	commentId?: number,
): string {
	if (source === "body" || commentId === undefined) {
		return `issue-${issueNumber}`;
	}
	return source === "review_comment"
		? `review-comment-${commentId}`
		: `comment-${commentId}`;
}

function toTrigger(
	item: Omit<Trigger, "key" | "text" | "task">,
	rawText: string,
	triggerPhrase: string,
): Trigger {
	const text = sanitizeInput(rawText);
	return {
		key: triggerKey(item.source, item.issueNumber, item.commentId),
		...item,
		text,
		task: extractTask(text, triggerPhrase),
	};
}

export function triggerFromInfo(
	info: TriggerInfo,
	triggerPhrase: string,
): Trigger {
	return toTrigger(
		{
			source: info.source,
			issueNumber: info.issueNumber,
			...(info.commentId === undefined ? {} : { commentId: info.commentId }),
			author: info.author,
			createdAt: info.createdAt ?? new Date().toISOString(),
			...(info.url ? { url: info.url } : {}),
		},
		info.triggerText,
		triggerPhrase,
	);
}

/**
 * The comments that mention the trigger phrase and whose authors may run pi. Questions from extensions and their
 * `/answer` replies are never triggers, even when they mention the phrase.
 */
export function triggersFromComments(
	comments: GitHubComment[],
	source: Exclude<TriggerSource, "body">,
	issueNumber: number,
	filter: TriggerFilter,
): Trigger[] {
	return comments.flatMap(
		({ id, body, user, author_association, created_at, html_url }) => {
			const text = body ?? "";
			if (
				!(user && hasTrigger(text, filter.triggerPhrase)) ||
				isQuestionComment(text)
			) {
				return [];
			}
			const author: GitHubUser = {
				login: user.login,
				type: toUserType(user.type),
			};
			if (!validatePermissions(author, author_association, filter)) {
				return [];
			}
			const item = {
				source,
				issueNumber,
				commentId: id,
				author,
				createdAt: created_at,
				url: html_url,
			};
			return [toTrigger(item, body ?? "", filter.triggerPhrase)];
		},
	);
}

async function triggersSince(
	client: GitHubClient,
	info: Pick<TriggerInfo, "issueNumber" | "isPullRequest">,
	filter: TriggerFilter,
	since: Date,
): Promise<Trigger[]> {
	const iso = since.toISOString();
	const comments = await client.listIssueComments(info.issueNumber, iso);
	const found = triggersFromComments(
		comments,
		"comment",
		info.issueNumber,
		filter,
	);
	if (info.isPullRequest) {
		const reviews = await client.listReviewComments(info.issueNumber, iso);
		found.push(
			...triggersFromComments(
				reviews,
				"review_comment",
				info.issueNumber,
				filter,
			),
		);
	}
	// `since` filters by update time; keep only comments created since.
	return found.filter(
		(trigger) => Date.parse(trigger.createdAt) >= since.getTime(),
	);
}

/**
 * Every trigger on the thread created after `since` (comments a cancelled or still-pending run never handled,
 * and ones posted while this run works), plus `current`, oldest first and without duplicates.
 */
export async function collectTriggers(
	client: GitHubClient,
	info: Pick<TriggerInfo, "issueNumber" | "isPullRequest">,
	filter: TriggerFilter,
	since: Date | undefined,
	current?: Trigger,
): Promise<Trigger[]> {
	const found = since ? await triggersSince(client, info, filter, since) : [];
	const byKey = new Map<string, Trigger>();
	for (const trigger of current ? [current, ...found] : found) {
		if (!byKey.has(trigger.key)) {
			byKey.set(trigger.key, trigger);
		}
	}
	return [...byKey.values()].toSorted(
		(a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
	);
}
