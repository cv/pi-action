import type {
	IssueCommentCreatedEvent,
	IssuesOpenedEvent,
	PullRequestOpenedEvent,
	PullRequestReviewCommentCreatedEvent,
} from "@octokit/webhooks-types";
import type {
	GitHubReaction,
	OctokitClient,
	PullRequestReviewComment,
	RepoRef,
	TriggerInfo,
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

	return {
		isCommentEvent: !!comment,
		triggerText,
		author,
		authorAssociation,
		issueNumber: subject.number,
		issueTitle: subject.title,
		issueBody: subject.body ?? "",
		...(comment ? { commentId: comment.id } : {}),
		isPullRequest: isPullRequestTrigger(payload, subject),
	};
}

export interface GitHubClient {
	addReactionToComment(
		commentId: number,
		reaction: GitHubReaction,
	): Promise<void>;
	addReactionToIssue(
		issueNumber: number,
		reaction: GitHubReaction,
	): Promise<void>;
	createComment(issueNumber: number, body: string): Promise<void>;
	getPullRequest(pullNumber: number): Promise<{
		number: number;
		title: string;
		body: string;
		user: { login: string; type: "User" | "Bot" | "Organization" };
		author_association: string;
	}>;
	getPullRequestDiff(pullNumber: number): Promise<string>;
	getPullRequestReviewComments(
		pullNumber: number,
	): Promise<PullRequestReviewComment[]>;
	createGist(
		content: string,
		filename: string,
		description: string,
		isPublic?: boolean,
	): Promise<string>;
}

export function createGitHubClient(
	octokit: OctokitClient,
	context: GitHubContext,
): GitHubClient {
	const { owner, name: repo } = context.repo;

	return {
		async addReactionToComment(commentId: number, reaction: GitHubReaction) {
			await octokit.rest.reactions.createForIssueComment({
				owner,
				repo,
				comment_id: commentId,
				content: reaction,
			});
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
			await octokit.rest.issues.createComment({
				owner,
				repo,
				issue_number: issueNumber,
				body,
			});
		},

		async getPullRequest(pullNumber: number) {
			const { data: pullRequest } = await octokit.rest.pulls.get({
				owner,
				repo,
				pull_number: pullNumber,
			});
			return pullRequest as {
				number: number;
				title: string;
				body: string;
				user: { login: string; type: "User" | "Bot" | "Organization" };
				author_association: string;
			};
		},

		async getPullRequestDiff(pullNumber: number): Promise<string> {
			const { data: diff } = await octokit.rest.pulls.get({
				owner,
				repo,
				pull_number: pullNumber,
				mediaType: { format: "diff" },
			});
			return diff as unknown as string;
		},

		async getPullRequestReviewComments(
			pullNumber: number,
		): Promise<PullRequestReviewComment[]> {
			const { data } = await octokit.rest.pulls.listReviewComments({
				owner,
				repo,
				pull_number: pullNumber,
			});
			const comments = data as Array<{
				id: number;
				body: string;
				user: { login: string; type: "User" | "Bot" | "Organization" };
				path?: string;
				line?: number;
				created_at: string;
			}>;
			return comments.map((comment) => ({
				id: comment.id,
				body: comment.body,
				user: comment.user,
				...(comment.path ? { path: comment.path } : {}),
				...(comment.line ? { line: comment.line } : {}),
				created_at: comment.created_at,
			}));
		},

		async createGist(
			content: string,
			filename: string,
			description: string,
			isPublic = false,
		): Promise<string> {
			const { data: gist } = await octokit.rest.gists.create({
				files: { [filename]: { content } },
				public: isPublic,
				description,
			});
			return gist.html_url || "";
		},
	};
}

export async function addReaction(
	client: GitHubClient,
	triggerInfo: TriggerInfo,
	reaction: GitHubReaction,
): Promise<void> {
	if (triggerInfo.isCommentEvent && triggerInfo.commentId) {
		await client.addReactionToComment(triggerInfo.commentId, reaction);
	} else {
		await client.addReactionToIssue(triggerInfo.issueNumber, reaction);
	}
}
