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
 * Session interface for session sharing
 */
export interface Session {
    exportToHtml: (outputPath?: string) => string | Promise<string>;
}
/**
 * Model configuration - commonly passed together
 */
export interface ModelConfig {
    provider: string;
    model: string;
    timeout: number;
}
export type ModelInputMode = "text" | "image";
export interface CustomProviderCompatConfig {
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
}
/**
 * Single custom provider/model definition, exposed as flat action inputs.
 */
export interface CustomProviderConfig {
    baseUrl: string;
    api: string;
    apiKey?: string;
    authHeader: boolean;
    modelName?: string;
    reasoning: boolean;
    input: ModelInputMode[];
    contextWindow: number;
    maxTokens: number;
    compat?: CustomProviderCompatConfig;
}
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
}
export type AgentResult = {
    success: true;
    response: string;
    session?: Session;
} | {
    success: false;
    error: string;
    session?: Session;
};
export interface OctokitClient {
    rest: {
        reactions: {
            createForIssueComment: (params: {
                owner: string;
                repo: string;
                comment_id: number;
                content: GitHubReaction;
            }) => Promise<unknown>;
            createForIssue: (params: {
                owner: string;
                repo: string;
                issue_number: number;
                content: GitHubReaction;
            }) => Promise<unknown>;
        };
        issues: {
            createComment: (params: {
                owner: string;
                repo: string;
                issue_number: number;
                body: string;
            }) => Promise<unknown>;
        };
        pulls: {
            get: (params: {
                owner: string;
                repo: string;
                pull_number: number;
                mediaType: {
                    format: string;
                };
            }) => Promise<{
                data: unknown;
            }>;
        };
        gists: {
            create: (params: {
                files: Record<string, {
                    content: string;
                }>;
                public?: boolean;
                description?: string;
            }) => Promise<{
                data: {
                    html_url?: string;
                };
            }>;
        };
    };
}
