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
} from "./types.ts";

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

/** The payload comes from outside: check the parts we read instead of trusting the webhook types. */
function isSupportedWebhookPayload(
	payload: unknown,
): payload is SupportedWebhookPayload {
	if (typeof payload !== "object" || payload === null) {
		return false;
	}
	const subject: unknown =
		Reflect.get(payload, "pull_request") ?? Reflect.get(payload, "issue");
	const comment: unknown = Reflect.get(payload, "comment");
	return hasAuthor(subject) && (comment === undefined || hasAuthor(comment));
}

function hasAuthor(value: unknown): boolean {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const user: unknown = Reflect.get(value, "user");
	return (
		typeof user === "object" &&
		user !== null &&
		typeof Reflect.get(user, "login") === "string"
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

	if (triggerText === "") {
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
	addReactionToComment: (
		commentId: number,
		reaction: GitHubReaction,
		source?: TriggerSource,
	) => Promise<void>;
	addReactionToIssue: (
		issueNumber: number,
		reaction: GitHubReaction,
	) => Promise<void>;
	createComment: (issueNumber: number, body: string) => Promise<PostedComment>;
	getPullRequest: (pullNumber: number) => Promise<PullRequestSummary>;
	getPullRequestDiff: (pullNumber: number) => Promise<string>;
	getPullRequestReviewComments: (
		pullNumber: number,
	) => Promise<PullRequestReviewComment[]>;
	/** Every comment on an issue or PR conversation, oldest first; `since` filters by last update. */
	listIssueComments: (
		issueNumber: number,
		since?: string,
	) => Promise<GitHubComment[]>;
	/** Every review comment on a PR, oldest first; `since` filters by last update. */
	listReviewComments: (
		pullNumber: number,
		since?: string,
	) => Promise<GitHubComment[]>;
}

/** GitHub's user type; anything unexpected (or missing, for deleted users) counts as a plain user. */
export function toUserType(type: string | undefined): GitHubUser["type"] {
	return type === "Bot" || type === "Organization" ? type : "User";
}

const PAGE_SIZE = 100;

function pageParams(since: string | undefined, page: number) {
	return { ...(since ? { since } : {}), per_page: PAGE_SIZE, page };
}

async function listAll(
	fetchPage: (page: number) => Promise<{ data: GitHubComment[] }>,
): Promise<GitHubComment[]> {
	const all: GitHubComment[] = [];
	for (let page = 1; ; page += 1) {
		// oxlint-disable-next-line eslint/no-await-in-loop -- pages are fetched until a short one
		const { data } = await fetchPage(page);
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
			type: toUserType(comment.user?.type),
		},
		...(comment.path ? { path: comment.path } : {}),
		...(typeof comment.line === "number" ? { line: comment.line } : {}),
		created_at: comment.created_at,
	};
}

export function createGitHubClient(
	octokit: OctokitClient,
	context: GitHubContext,
): GitHubClient {
	const { owner, name: repo } = context.repo;
	const listReviewComments = async (pullNumber: number, since?: string) =>
		listAll(async (page) =>
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
			await (source === "review_comment"
				? octokit.rest.reactions.createForPullRequestReviewComment(params)
				: octokit.rest.reactions.createForIssueComment(params));
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
			return {
				number: pullRequest.number,
				title: pullRequest.title,
				body: pullRequest.body ?? "",
				user: {
					login: pullRequest.user.login,
					type: toUserType(pullRequest.user.type),
				},
				author_association: pullRequest.author_association,
			};
		},

		async getPullRequestDiff(pullNumber: number): Promise<string> {
			const { data: diff } = await octokit.rest.pulls.get({
				owner,
				repo,
				pull_number: pullNumber,
				mediaType: { format: "diff" },
			});
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the diff media type returns text; Octokit still types it as a PR
			return diff as unknown as string;
		},

		async getPullRequestReviewComments(pullNumber: number) {
			return (await listReviewComments(pullNumber)).map((comment) =>
				toReviewComment(comment),
			);
		},

		async listIssueComments(issueNumber: number, since?: string) {
			return listAll(async (page) =>
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
	await (trigger.isCommentEvent && trigger.commentId !== undefined
		? client.addReactionToComment(trigger.commentId, reaction, trigger.source)
		: client.addReactionToIssue(trigger.issueNumber, reaction));
}
