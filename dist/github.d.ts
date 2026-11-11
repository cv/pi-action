import type { GitHubComment, GitHubReaction, OctokitClient, RepoRef, TriggerInfo, TriggerSource } from "./types.js";
export interface GitHubContext {
    repo: RepoRef;
}
export declare function extractTriggerInfo(payload: Record<string, unknown>): TriggerInfo | null;
export interface PostedComment {
    id: number;
    url: string;
}
export interface GitHubClient {
    addReactionToComment(commentId: number, reaction: GitHubReaction, source?: TriggerSource): Promise<void>;
    addReactionToIssue(issueNumber: number, reaction: GitHubReaction): Promise<void>;
    createComment(issueNumber: number, body: string): Promise<PostedComment>;
    getPullRequestDiff(pullNumber: number): Promise<string>;
    /** Every comment on an issue or PR conversation, oldest first; `since` filters by last update. */
    listIssueComments(issueNumber: number, since?: string): Promise<GitHubComment[]>;
    /** Every review comment on a PR, oldest first. */
    listReviewComments(pullNumber: number, since?: string): Promise<GitHubComment[]>;
}
export declare function createGitHubClient(octokit: OctokitClient, context: GitHubContext): GitHubClient;
export declare function addReaction(client: GitHubClient, trigger: Pick<TriggerInfo, "isCommentEvent" | "commentId" | "issueNumber" | "source">, reaction: GitHubReaction): Promise<void>;
