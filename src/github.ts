import type {
	IssueCommentCreatedEvent,
	IssuesOpenedEvent,
	PullRequestOpenedEvent,
	PullRequestReviewCommentCreatedEvent,
} from "@octokit/webhooks-types";
import type {
	GitHubComment,
	GitHubReaction,
	GitHubUser,
	OctokitClient,
	PullRequestReviewComment,
	RepoRef,
	TriggerInfo,
	TriggerSource,
} from "./types.js";

export interface GitHubContext {
	repo: RepoRef;
}

type SupportedWebhookPayload =
	| IssueCommentCreatedEvent
	| IssuesOpenedEvent
	| PullRequestOpenedEvent
	| PullRequestReviewCommentCreatedEvent;

type TriggerSubject = SupportedWebhookPayload extends infer Payload
	? Payload extends { issue: infer Issue }
		? Issue
		: Payload extends { pull_request: infer PullRequest }
			? PullRequest
			: never
	: never;

type TriggerComment = SupportedWebhookPayload extends infer Payload
	? Payload extends { comment: infer Comment }
		? Comment
		: never
	: never;

function isSupportedWebhookPayload(
	payload: unknown,
): payload is SupportedWebhookPayload {
	return (
		typeof payload === "object" &&
		payload !== null &&
		("issue" in payload || "pull_request" in payload)
	);
}

function getTriggerSubject(payload: SupportedWebhookPayload): TriggerSubject {
	return "pull_request" in payload ? payload.pull_request : payload.issue;
}

function getTriggerComment(
	payload: SupportedWebhookPayload,
): TriggerComment | undefined {
	return "comment" in payload ? payload.comment : undefined;
}

function isPullRequestTrigger(
	payload: SupportedWebhookPayload,
	subject: TriggerSubject,
): boolean {
	return "pull_request" in payload || "pull_request" in subject;
}

function getTriggerSource(
	payload: SupportedWebhookPayload,
	comment: TriggerComment | undefined,
): TriggerSource {
	if (!comment) {
		return "body";
	}
	// Review comments arrive with pull_request (and no issue) and belong to a review.
	return "issue" in payload ? "comment" : "review_comment";
}

export function extractTriggerInfo(
	payload: Record<string, unknown>,
): TriggerInfo | null {
	if (!isSupportedWebhookPayload(payload)) {
		return null;
	}

	const subject = getTriggerSubject(payload);
	const comment = getTriggerComment(payload);
	const triggerText = comment?.body ?? subject.body ?? "";
	const author = comment?.user ?? subject.user;
	const authorAssociation =
		comment?.author_association ?? subject.author_association;

	if (!(triggerText && author)) {
		return null;
	}

	const origin = comment ?? subject;
	return {
		isCommentEvent: Boolean(comment),
		triggerText,
		author,
		authorAssociation,
		issueNumber: subject.number,
		issueTitle: subject.title,
		issueBody: subject.body ?? "",
		...(comment ? { commentId: comment.id } : {}),
		isPullRequest: isPullRequestTrigger(payload, subject),
		source: getTriggerSource(payload, comment),
		...(origin.created_at ? { createdAt: origin.created_at } : {}),
		...(origin.html_url ? { url: origin.html_url } : {}),
	};
}

interface PostedComment {
	id: number;
	url: string;
}

interface PullRequestSummary {
	number: number;
	title: string;
	body: string;
	user: GitHubUser;
	author_association: string;
}

export interface GitHubClient {
	addReactionToComment(
		commentId: number,
		reaction: GitHubReaction,
		source?: TriggerSource,
	): Promise<void>;
	addReactionToIssue(
		issueNumber: number,
		reaction: GitHubReaction,
	): Promise<void>;
	createComment(issueNumber: number, body: string): Promise<PostedComment>;
	getPullRequest(pullNumber: number): Promise<PullRequestSummary>;
	getPullRequestDiff(pullNumber: number): Promise<string>;
	getPullRequestReviewComments(
		pullNumber: number,
	): Promise<PullRequestReviewComment[]>;
	/** Every comment on an issue or PR conversation, oldest first; `since` filters by last update. */
	listIssueComments(
		issueNumber: number,
		since?: string,
	): Promise<GitHubComment[]>;
	/** Every review comment on a PR, oldest first; `since` filters by last update. */
	listReviewComments(
		pullNumber: number,
		since?: string,
	): Promise<GitHubComment[]>;
}

const PAGE_SIZE = 100;

async function listAll(
	fetchPage: (page: number) => Promise<{ data: unknown }>,
): Promise<GitHubComment[]> {
	const all: GitHubComment[] = [];
	for (let page = 1; ; page += 1) {
		// biome-ignore lint/performance/noAwaitInLoops: pages are fetched until a short one
		const data = (await fetchPage(page)).data as GitHubComment[];
		all.push(...data);
		if (data.length < PAGE_SIZE) {
			return all;
		}
	}
}

function toReviewComment(comment: GitHubComment): PullRequestReviewComment {
	return {
		id: comment.id,
		body: comment.body ?? "",
		user: {
			login: comment.user?.login ?? "ghost",
			type: (comment.user?.type ?? "User") as GitHubUser["type"],
		},
		...(comment.path ? { path: comment.path } : {}),
		...(comment.line ? { line: comment.line } : {}),
		created_at: comment.created_at,
	};
}

export function createGitHubClient(
	octokit: OctokitClient,
	context: GitHubContext,
): GitHubClient {
	const { owner, name: repo } = context.repo;
	const pageParams = (since: string | undefined, page: number) => ({
		...(since ? { since } : {}),
		per_page: PAGE_SIZE,
		page,
	});
	const listReviewComments = (pullNumber: number, since?: string) =>
		listAll((page) =>
			octokit.rest.pulls.listReviewComments({
				owner,
				repo,
				pull_number: pullNumber,
				...pageParams(since, page),
			}),
		);

	return {
		async addReactionToComment(
			commentId: number,
			reaction: GitHubReaction,
			source: TriggerSource = "comment",
		) {
			const params = { owner, repo, comment_id: commentId, content: reaction };
			if (source === "review_comment") {
				await octokit.rest.reactions.createForPullRequestReviewComment(params);
			} else {
				await octokit.rest.reactions.createForIssueComment(params);
			}
		},

		async addReactionToIssue(issueNumber: number, reaction: GitHubReaction) {
			await octokit.rest.reactions.createForIssue({
				owner,
				repo,
				issue_number: issueNumber,
				content: reaction,
			});
		},

		async createComment(issueNumber: number, body: string) {
			const { data } = await octokit.rest.issues.createComment({
				owner,
				repo,
				issue_number: issueNumber,
				body,
			});
			return { id: data.id, url: data.html_url };
		},

		async getPullRequest(pullNumber: number) {
			const { data: pullRequest } = await octokit.rest.pulls.get({
				owner,
				repo,
				pull_number: pullNumber,
			});
			return pullRequest as PullRequestSummary;
		},

		async getPullRequestDiff(pullNumber: number): Promise<string> {
			const { data: diff } = await octokit.rest.pulls.get({
				owner,
				repo,
				pull_number: pullNumber,
				mediaType: { format: "diff" },
			});
			return diff as string;
		},

		async getPullRequestReviewComments(pullNumber: number) {
			return (await listReviewComments(pullNumber)).map(toReviewComment);
		},

		listIssueComments(issueNumber: number, since?: string) {
			return listAll((page) =>
				octokit.rest.issues.listComments({
					owner,
					repo,
					issue_number: issueNumber,
					...pageParams(since, page),
				}),
			);
		},

		listReviewComments,
	};
}

export async function addReaction(
	client: GitHubClient,
	trigger: Pick<
		TriggerInfo,
		"isCommentEvent" | "commentId" | "issueNumber" | "source"
	>,
	reaction: GitHubReaction,
): Promise<void> {
	if (trigger.isCommentEvent && trigger.commentId) {
		await client.addReactionToComment(
			trigger.commentId,
			reaction,
			trigger.source,
		);
	} else {
		await client.addReactionToIssue(trigger.issueNumber, reaction);
	}
}
