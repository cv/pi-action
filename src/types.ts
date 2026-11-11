/** The logging that every part of a run needs. */
export interface Log {
	info: (msg: string) => void;
	warning: (msg: string) => void;
}

/** A question a pi-durable extension asks its user; `key` is stable for the same question (pit derives it). */
export type UiQuestion =
	| { kind: "confirm"; key: string; title: string; message: string }
	| { kind: "select"; key: string; title: string; options: string[] }
	| { kind: "input"; key: string; title: string; placeholder?: string };

/** Someone's answer to a question, delivered to the thread as a `ui.answer` entry. */
export interface UiAnswer {
	key: string;
	kind: UiQuestion["kind"];
	/** `true`/`false` for confirm, the option for select, the text for input. */
	answer: boolean | string;
	/** Who answered (a GitHub login). */
	by: string;
	/** The question's comment. */
	url: string;
	title: string;
}

/**
 * The UI pi-action gives pi-durable extensions: an asynchronous host (the interface `pit/durable` defines). `ask`
 * posts the question on the issue or PR and returns at once; the answer arrives in a later run as a `ui.answer` entry
 * (see github-ui.ts and answers.ts).
 */
export interface DurableUi {
	ask: (question: UiQuestion) => Promise<{ url?: string }>;
	notify: (message: string, level?: "info" | "warning" | "error") => void;
}

/** What a pi-durable extension package's `createPiDurableExtension(options)` receives from pi-action. */
export interface DurableHostOptions {
	/** The workspace (the checked-out repository). */
	cwd: string;
	/** The extension's agent directory (user-level state): the `agent_dir` input, else a temp dir. */
	agentDir: string;
	/** The `trust_project` input: whether the extension may load and run the repository's own configuration. */
	trustProject: boolean;
	/** GitHub comments as dialogs; omitted in output mode and for direct prompts. */
	ui?: DurableUi;
	log: Log;
}

export type GitHubReaction =
	| "+1"
	| "-1"
	| "laugh"
	| "confused"
	| "heart"
	| "hooray"
	| "rocket"
	| "eyes";

export interface GitHubUser {
	login: string;
	type: "User" | "Bot" | "Organization";
}

/**
 * Repository reference with clearer naming (avoids repo.repo)
 */
export interface RepoRef {
	owner: string;
	name: string;
}

/** Where a trigger came from: an issue/PR body, an issue comment, or a PR review comment. */
export type TriggerSource = "body" | "comment" | "review_comment";

/** The issue, PR, or comment of the webhook event that started the run. */
export interface TriggerInfo {
	triggerText: string;
	author: GitHubUser;
	authorAssociation: string;
	issueNumber: number;
	issueTitle: string;
	issueBody: string;
	commentId?: number;
	isPullRequest: boolean;
	source: TriggerSource;
	createdAt?: string;
	url?: string;
}

/** An issue or review comment as listed by the REST API. */
export interface GitHubComment {
	id: number;
	body?: string | null;
	user?: { login: string; type: string } | null;
	author_association: string;
	created_at: string;
	html_url: string;
	path?: string | null;
	line?: number | null;
}

type Params<T> = { owner: string; repo: string; [key: string]: unknown } & T;

interface ListParams {
	since?: string;
	per_page?: number;
	page?: number;
}

/** The fields of Octokit's pull request object that pi-action reads. */
interface OctokitPullRequest {
	number: number;
	title: string;
	body: string | null;
}

/** The part of Octokit that pi-action uses. */
export interface OctokitClient {
	rest: {
		reactions: {
			createForIssueComment: (
				params: Params<{ comment_id: number; content: GitHubReaction }>,
			) => Promise<unknown>;
			createForPullRequestReviewComment: (
				params: Params<{ comment_id: number; content: GitHubReaction }>,
			) => Promise<unknown>;
			createForIssue: (
				params: Params<{ issue_number: number; content: GitHubReaction }>,
			) => Promise<unknown>;
		};
		issues: {
			createComment: (
				params: Params<{ issue_number: number; body: string }>,
			) => Promise<{ data: { id: number; html_url: string } }>;
			listComments: (
				params: Params<{ issue_number: number } & ListParams>,
			) => Promise<{ data: GitHubComment[] }>;
			getComment: (
				params: Params<{ comment_id: number }>,
			) => Promise<{ data: GitHubComment }>;
			updateComment: (
				params: Params<{ comment_id: number; body: string }>,
			) => Promise<unknown>;
		};
		repos: {
			getCollaboratorPermissionLevel: (
				params: Params<{ username: string }>,
			) => Promise<{ data: { permission: string; role_name?: string } }>;
		};
		pulls: {
			get: (
				params: Params<{
					pull_number: number;
					mediaType?: { format: string };
				}>,
			) => Promise<{ data: OctokitPullRequest }>;
			listReviewComments: (
				params: Params<{ pull_number: number } & ListParams>,
			) => Promise<{ data: GitHubComment[] }>;
		};
	};
}
