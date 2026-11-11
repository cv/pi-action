export type GitHubReaction = "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";
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
/**
 * Model configuration - commonly passed together
 */
export interface ModelConfig {
    provider: string;
    model: string;
    timeout: number;
}
/** Where a trigger came from: an issue/PR body, an issue comment, or a PR review comment. */
export type TriggerSource = "body" | "comment" | "review_comment";
export interface TriggerInfo {
    isCommentEvent: boolean;
    triggerText: string;
    author: GitHubUser;
    authorAssociation: string;
    issueNumber: number;
    issueTitle: string;
    issueBody: string;
    commentId?: number;
    isPullRequest: boolean;
    source?: TriggerSource;
    createdAt?: string;
    url?: string;
}
/** A comment as listed by the REST API. */
export interface GitHubComment {
    id: number;
    body?: string | null;
    user?: {
        login: string;
        type: string;
    } | null;
    author_association: string;
    created_at: string;
    html_url: string;
}
type Params<T> = {
    owner: string;
    repo: string;
} & T;
export interface OctokitClient {
    rest: {
        reactions: {
            createForIssueComment: (params: Params<{
                comment_id: number;
                content: GitHubReaction;
            }>) => Promise<unknown>;
            createForPullRequestReviewComment: (params: Params<{
                comment_id: number;
                content: GitHubReaction;
            }>) => Promise<unknown>;
            createForIssue: (params: Params<{
                issue_number: number;
                content: GitHubReaction;
            }>) => Promise<unknown>;
        };
        issues: {
            createComment: (params: Params<{
                issue_number: number;
                body: string;
            }>) => Promise<{
                data: {
                    id: number;
                    html_url: string;
                };
            }>;
            listComments: (params: Params<{
                issue_number: number;
                since?: string;
                per_page?: number;
                page?: number;
            }>) => Promise<{
                data: GitHubComment[];
            }>;
        };
        pulls: {
            get: (params: Params<{
                pull_number: number;
                mediaType: {
                    format: string;
                };
            }>) => Promise<{
                data: unknown;
            }>;
            listReviewComments: (params: Params<{
                pull_number: number;
                since?: string;
                per_page?: number;
                page?: number;
            }>) => Promise<{
                data: GitHubComment[];
            }>;
        };
    };
}
export {};
