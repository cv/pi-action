import type {
	GitHubComment,
	GitHubReaction,
	GitHubUser,
	OctokitClient,
	RepoRef,
	TriggerInfo,
	TriggerSource,
} from "./types.js";

export interface GitHubContext {
	repo: RepoRef;
}

function triggerSource(
	payload: Record<string, unknown>,
	comment: Record<string, unknown> | undefined,
): TriggerSource {
	if (!comment) {
		return "body";
	}
	// Review comments belong to a review and arrive with pull_request, not issue.
	return !payload.issue && "pull_request_review_id" in comment
		? "review_comment"
		: "comment";
}

export function extractTriggerInfo(
	payload: Record<string, unknown>,
): TriggerInfo | null {
	const comment = payload.comment as Record<string, unknown> | undefined;
	const issue = (payload.issue || payload.pull_request) as
		| Record<string, unknown>
		| undefined;

	if (!issue) {
		return null;
	}

	const isCommentEvent = !!comment;
	const origin = comment ?? issue;
	const triggerText = origin.body as string;
	const author = origin.user as GitHubUser;
	const authorAssociation = origin.author_association as string;

	if (!(triggerText && author)) {
		return null;
	}

	return {
		isCommentEvent,
		triggerText,
		author,
		authorAssociation,
		issueNumber: issue.number as number,
		issueTitle: issue.title as string,
		issueBody: (issue.body as string) || "",
		commentId: comment?.id as number | undefined,
		isPullRequest: !!(payload.pull_request || issue.pull_request),
		source: triggerSource(payload, comment),
		createdAt: origin.created_at as string | undefined,
		url: origin.html_url as string | undefined,
	};
}

export interface PostedComment {
	id: number;
	url: string;
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
	getPullRequestDiff(pullNumber: number): Promise<string>;
	/** Every comment on an issue or PR conversation, oldest first; `since` filters by last update. */
	listIssueComments(
		issueNumber: number,
		since?: string,
	): Promise<GitHubComment[]>;
	/** Every review comment on a PR, oldest first. */
	listReviewComments(
		pullNumber: number,
		since?: string,
	): Promise<GitHubComment[]>;
}

const PAGE_SIZE = 100;

async function listAll(
	fetchPage: (page: number) => Promise<{ data: GitHubComment[] }>,
): Promise<GitHubComment[]> {
	const all: GitHubComment[] = [];
	for (let page = 1; ; page++) {
		const { data } = await fetchPage(page);
		all.push(...data);
		if (data.length < PAGE_SIZE) {
			return all;
		}
	}
}

export function createGitHubClient(
	octokit: OctokitClient,
	context: GitHubContext,
): GitHubClient {
	const { owner, name: repo } = context.repo;

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

		async getPullRequestDiff(pullNumber: number): Promise<string> {
			const { data: diff } = await octokit.rest.pulls.get({
				owner,
				repo,
				pull_number: pullNumber,
				mediaType: { format: "diff" },
			});
			return diff as unknown as string;
		},

		listIssueComments(issueNumber: number, since?: string) {
			return listAll((page) =>
				octokit.rest.issues.listComments({
					owner,
					repo,
					issue_number: issueNumber,
					since,
					per_page: PAGE_SIZE,
					page,
				}),
			);
		},

		listReviewComments(pullNumber: number, since?: string) {
			return listAll((page) =>
				octokit.rest.pulls.listReviewComments({
					owner,
					repo,
					pull_number: pullNumber,
					since,
					per_page: PAGE_SIZE,
					page,
				}),
			);
		},
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
