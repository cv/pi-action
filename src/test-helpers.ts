/**
 * Test helper functions to reduce duplication in test files
 */
import { vi } from "vitest";
import type { AgentConfig } from "./agent.js";
import type { PIContext } from "./context.js";
import { DEFAULTS } from "./defaults.js";
import type { GitHubClient } from "./github.js";
import type { ActionInputs } from "./run.js";
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
 * Creates ActionInputs with sensible defaults and optional overrides.
 */
export function createActionInputs(
	overrides: Partial<ActionInputs> = {},
): ActionInputs {
	return {
		triggerPhrase: DEFAULTS.triggerPhrase,
		allowedBots: [],
		modelConfig: createModelConfig(),
		githubToken: "test-token",
		apiKey: undefined,
		customProvider: undefined,
		promptTemplate: undefined,
		shareSession: DEFAULTS.shareSession,
		outputMode: DEFAULTS.outputMode,
		prompt: undefined,
		prNumber: undefined,
		...overrides,
	};
}

/**
 * Creates a minimal issue payload for run tests.
 */
export function createIssuePayload(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		issue: {
			number: 1,
			title: "Test Issue",
			body: "@pi do something",
			user: { login: "user", type: "User" },
			author_association: "OWNER",
			...overrides,
		},
	};
}

/**
 * Creates a minimal pull_request payload for run tests.
 */
export function createPullRequestPayload(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		pull_request: {
			number: 1,
			title: "Test PR",
			body: "@pi review",
			user: { login: "user", type: "User" },
			author_association: "OWNER",
			...overrides,
		},
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
		exportToHtml: vi.fn(),
		exportToJsonl: vi.fn(),
		subscribe: vi.fn(),
		prompt: vi.fn(),
	};
}
