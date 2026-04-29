/**
 * Test helper functions to reduce duplication in test files
 */
import { vi } from "vitest";
import type { AgentConfig } from "./agent.js";
import type { PIContext } from "./context.js";
import { DEFAULTS } from "./defaults.js";
import type { GitHubClient } from "./github.js";
import type { ModelConfig, RepoRef, TriggerInfo } from "./types.js";

/**
 * Creates a mock GitHub client with all required methods
 */
export function createMockGitHubClient(): GitHubClient {
	return {
		addReactionToComment: vi.fn(),
		addReactionToIssue: vi.fn(),
		createComment: vi.fn(),
		getPullRequest: vi.fn().mockResolvedValue({
			number: 1,
			title: "Test PR",
			body: "PR body",
			user: { login: "user", type: "User" },
			author_association: "OWNER",
		}),
		getPullRequestDiff: vi.fn().mockResolvedValue(""),
		getPullRequestReviewComments: vi.fn().mockResolvedValue([]),
		createGist: vi.fn().mockResolvedValue("https://gist.github.com/test123"),
	};
}

/**
 * Creates a TriggerInfo object with sensible defaults and optional overrides
 */
export function createTriggerInfo(
	overrides: Partial<TriggerInfo> = {},
): TriggerInfo {
	return {
		isCommentEvent: false,
		triggerText: "@pi test",
		author: { login: "user", type: "User" },
		authorAssociation: "OWNER",
		issueNumber: 1,
		issueTitle: "Test",
		issueBody: "Body",
		isPullRequest: false,
		...overrides,
	};
}

/**
 * Creates a PIContext object with sensible defaults and optional overrides
 */
export function createPIContext(overrides: Partial<PIContext> = {}): PIContext {
	return {
		type: "issue",
		title: "Test Issue",
		body: "Issue body",
		number: 1,
		triggerComment: "@pi do something",
		task: "do something",
		...overrides,
	};
}

/**
 * Creates an AgentConfig object with sensible defaults and optional overrides
 */
export function createAgentConfig(
	overrides: Partial<AgentConfig> = {},
): AgentConfig {
	return {
		provider: DEFAULTS.provider,
		model: DEFAULTS.model,
		timeout: DEFAULTS.timeout,
		cwd: "/test/dir",
		...overrides,
	};
}

/**
 * Creates a ModelConfig object with sensible defaults and optional overrides
 */
export function createModelConfig(
	overrides: Partial<ModelConfig> = {},
): ModelConfig {
	return {
		provider: DEFAULTS.provider,
		model: DEFAULTS.model,
		timeout: DEFAULTS.timeout,
		...overrides,
	};
}

/**
 * Creates a RepoRef object with sensible defaults and optional overrides
 */
export function createRepoRef(overrides: Partial<RepoRef> = {}): RepoRef {
	return {
		owner: "testowner",
		name: "testrepo",
		...overrides,
	};
}

/**
 * Creates a mock session for pi agent testing
 */
export function createMockSession() {
	return {
		subscribe: vi.fn(),
		prompt: vi.fn(),
	};
}
