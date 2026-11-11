import { extractTask, hasTrigger } from "./context.js";
import type { GitHubClient } from "./github.js";
import { sanitizeInput, validatePermissions } from "./security.js";
import type {
	GitHubComment,
	GitHubUser,
	TriggerInfo,
	TriggerSource,
} from "./types.js";

/** One request for pi: an issue/PR body or comment that mentions the trigger phrase. */
export interface Trigger {
	/** Stable per GitHub item; used as the submission's requestId so it is answered once. */
	key: string;
	source: TriggerSource;
	issueNumber: number;
	commentId?: number;
	author: GitHubUser;
	text: string;
	task: string;
	createdAt: string;
	url?: string;
}

/** Who may run pi, as configured by the trigger_phrase and allowed_* inputs. */
export interface TriggerFilter {
	triggerPhrase: string;
	allowedBots: string[];
	allowedUsers: string[];
	allowedAssociations: string[];
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

export function triggerFromInfo(
	info: TriggerInfo,
	triggerPhrase: string,
): Trigger {
	const source = info.source ?? (info.isCommentEvent ? "comment" : "body");
	const text = sanitizeInput(info.triggerText);
	return {
		key: triggerKey(source, info.issueNumber, info.commentId),
		source,
		issueNumber: info.issueNumber,
		...(info.commentId === undefined ? {} : { commentId: info.commentId }),
		author: info.author,
		text,
		task: extractTask(text, triggerPhrase),
		createdAt: info.createdAt ?? new Date().toISOString(),
		...(info.url ? { url: info.url } : {}),
	};
}

function commentAuthor(
	comment: GitHubComment,
	filter: TriggerFilter,
): GitHubUser | undefined {
	const { user } = comment;
	if (!(user && hasTrigger(comment.body ?? "", filter.triggerPhrase))) {
		return;
	}
	const author: GitHubUser = {
		login: user.login,
		type: user.type as GitHubUser["type"],
	};
	const permitted = validatePermissions({
		authorAssociation: comment.author_association,
		authorLogin: author.login,
		isBot: author.type === "Bot",
		allowedBots: filter.allowedBots,
		allowedUsers: filter.allowedUsers,
		allowedAssociations: filter.allowedAssociations,
	});
	return permitted ? author : undefined;
}

/** The comments that mention the trigger phrase and whose authors may run pi. */
export function triggersFromComments(
	comments: GitHubComment[],
	source: Exclude<TriggerSource, "body">,
	issueNumber: number,
	filter: TriggerFilter,
): Trigger[] {
	return comments.flatMap((comment) => {
		const author = commentAuthor(comment, filter);
		if (!author) {
			return [];
		}
		const text = sanitizeInput(comment.body ?? "");
		return [
			{
				key: triggerKey(source, issueNumber, comment.id),
				source,
				issueNumber,
				commentId: comment.id,
				author,
				text,
				task: extractTask(text, filter.triggerPhrase),
				createdAt: comment.created_at,
				url: comment.html_url,
			},
		];
	});
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
	return [...byKey.values()].sort(
		(a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
	);
}
