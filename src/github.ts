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
	RepoRef,
	TriggerInfo,
	TriggerSource,
} from "./types.ts";

type SupportedWebhookPayload =
	| IssueCommentCreatedEvent
	| IssuesOpenedEvent
	| PullRequestOpenedEvent
	| PullRequestReviewCommentCreatedEvent;

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

export function extractTriggerInfo(
	event: Record<string, unknown>,
): TriggerInfo | null {
	if (!isSupportedWebhookPayload(event)) {
		return null;
	}
	const payload: SupportedWebhookPayload = event;
	const subject =
		"pull_request" in payload ? payload.pull_request : payload.issue;
	const comment = "comment" in payload ? payload.comment : undefined;
	const origin = comment ?? subject;
	// Review comments arrive with pull_request (and no issue) and belong to a review.
	let source: TriggerSource = "body";
	if (comment) {
		source = "issue" in payload ? "comment" : "review_comment";
	}
	const triggerText = origin.body ?? "";
	if (triggerText === "") {
		return null;
	}
	return {
		triggerText,
		author: origin.user,
		authorAssociation: origin.author_association,
		issueNumber: subject.number,
		issueTitle: subject.title,
		issueBody: subject.body ?? "",
		...(comment ? { commentId: comment.id } : {}),
		isPullRequest: "pull_request" in payload || "pull_request" in subject,
		source,
		...(origin.created_at ? { createdAt: origin.created_at } : {}),
		...(origin.html_url ? { url: origin.html_url } : {}),
	};
}

/** What a reaction goes on: the comment, or the issue/PR itself for a body trigger. */
export type ReactionTarget = Pick<
	TriggerInfo,
	"source" | "issueNumber" | "commentId"
>;

export interface GitHubClient {
	addReaction: (
		target: ReactionTarget,
		reaction: GitHubReaction,
	) => Promise<void>;
	createComment: (
		issueNumber: number,
		body: string,
	) => Promise<{ id: number; url: string }>;
	/** One issue/PR conversation comment, as it is now. */
	getComment: (commentId: number) => Promise<GitHubComment>;
	updateComment: (commentId: number, body: string) => Promise<void>;
	/** A user's role on the repository: `admin`, `maintain`, `write`, `triage`, `read`, or `none`. */
	getCollaboratorPermission: (login: string) => Promise<string>;
	getPullRequest: (
		pullNumber: number,
	) => Promise<{ number: number; title: string; body: string }>;
	getPullRequestDiff: (pullNumber: number) => Promise<string>;
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

async function listAll(
	since: string | undefined,
	fetchPage: (params: {
		since?: string;
		per_page: number;
		page: number;
	}) => Promise<{ data: GitHubComment[] }>,
): Promise<GitHubComment[]> {
	const all: GitHubComment[] = [];
	for (let page = 1; ; page += 1) {
		// oxlint-disable-next-line eslint/no-await-in-loop -- pages are fetched until a short one
		const { data } = await fetchPage({
			...(since ? { since } : {}),
			per_page: PAGE_SIZE,
			page,
		});
		all.push(...data);
		if (data.length < PAGE_SIZE) {
			return all;
		}
	}
}

export function createGitHubClient(
	octokit: OctokitClient,
	{ owner, name: repo }: RepoRef,
): GitHubClient {
	const { reactions, issues, pulls, repos } = octokit.rest;
	return {
		async addReaction({ source, issueNumber, commentId }, content) {
			if (source === "body" || commentId === undefined) {
				await reactions.createForIssue({
					owner,
					repo,
					issue_number: issueNumber,
					content,
				});
				return;
			}
			const params = { owner, repo, comment_id: commentId, content };
			await (source === "review_comment"
				? reactions.createForPullRequestReviewComment(params)
				: reactions.createForIssueComment(params));
		},

		async createComment(issueNumber, body) {
			const { data } = await issues.createComment({
				owner,
				repo,
				issue_number: issueNumber,
				body,
			});
			return { id: data.id, url: data.html_url };
		},

		async getComment(commentId) {
			const { data } = await issues.getComment({
				owner,
				repo,
				comment_id: commentId,
			});
			return data;
		},

		async updateComment(commentId, body) {
			await issues.updateComment({
				owner,
				repo,
				comment_id: commentId,
				body,
			});
		},

		async getCollaboratorPermission(login) {
			const { data } = await repos.getCollaboratorPermissionLevel({
				owner,
				repo,
				username: login,
			});
			return data.role_name ?? data.permission;
		},

		async getPullRequest(pullNumber) {
			const { data } = await pulls.get({
				owner,
				repo,
				pull_number: pullNumber,
			});
			return { number: data.number, title: data.title, body: data.body ?? "" };
		},

		async getPullRequestDiff(pullNumber) {
			const { data: diff } = await pulls.get({
				owner,
				repo,
				pull_number: pullNumber,
				mediaType: { format: "diff" },
			});
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the diff media type returns text; Octokit still types it as a PR
			return diff as unknown as string;
		},

		async listIssueComments(issueNumber, since) {
			return listAll(since, async (params) =>
				issues.listComments({
					owner,
					repo,
					issue_number: issueNumber,
					...params,
				}),
			);
		},

		async listReviewComments(pullNumber, since) {
			return listAll(since, async (params) =>
				pulls.listReviewComments({
					owner,
					repo,
					pull_number: pullNumber,
					...params,
				}),
			);
		},
	};
}
