/**
 * Test helper functions to reduce duplication in test files
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { DEFAULTS } from "./defaults.js";
import type { GitHubClient } from "./github.js";
import type { ActionInputs } from "./run.js";
import type { GitHubComment, ModelConfig, TriggerInfo } from "./types.js";

const since = (list: GitHubComment[], iso?: string) =>
	iso
		? list.filter((c) => Date.parse(c.created_at) >= Date.parse(iso))
		: [...list];

/**
 * Creates a mock GitHub client with all required methods. `comments` and `reviewComments` back the list
 * methods (live arrays: tests may push to them), and posted comment bodies are recorded in `posted`.
 */
export function createMockGitHubClient(
	comments: GitHubComment[] = [],
	reviewComments: GitHubComment[] = [],
): GitHubClient & { posted: string[] } {
	const posted: string[] = [];
	return {
		posted,
		addReactionToComment: vi.fn(),
		addReactionToIssue: vi.fn(),
		createComment: vi.fn((_issue: number, body: string) => {
			posted.push(body);
			return Promise.resolve({
				id: 1000 + posted.length,
				url: `https://github.com/o/r/issues/1#c${posted.length}`,
			});
		}),
		getPullRequest: vi.fn().mockResolvedValue({
			number: 1,
			title: "Test PR",
			body: "PR body",
			user: { login: "user", type: "User" },
			author_association: "OWNER",
		}),
		getPullRequestDiff: vi.fn().mockResolvedValue(""),
		getPullRequestReviewComments: vi.fn().mockResolvedValue([]),
		listIssueComments: vi.fn((_issue: number, iso?: string) =>
			Promise.resolve(since(comments, iso)),
		),
		listReviewComments: vi.fn((_pr: number, iso?: string) =>
			Promise.resolve(since(reviewComments, iso)),
		),
	};
}

export function createComment(
	overrides: Partial<GitHubComment> = {},
): GitHubComment {
	return {
		id: 1,
		body: "@pi do something",
		user: { login: "user", type: "User" },
		author_association: "MEMBER",
		created_at: "2026-01-01T00:00:00Z",
		html_url: "https://github.com/o/r/issues/1#issuecomment-1",
		...overrides,
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
 * Creates a ModelConfig object with sensible defaults and optional overrides
 */
function createModelConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
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
		allowedUsers: [],
		allowedAssociations: [...DEFAULTS.allowedAssociations],
		modelConfig: createModelConfig(),
		githubToken: "test-token",
		apiKey: undefined,
		customProvider: undefined,
		promptTemplate: undefined,
		outputMode: DEFAULTS.outputMode,
		prompt: undefined,
		prNumber: undefined,
		pollInterval: DEFAULTS.pollInterval,
		...overrides,
	};
}

/** A fresh, empty git repository in a temp directory. */
export function tempRepo(): {
	dir: string;
	git: (...args: string[]) => string;
	cleanup: () => void;
} {
	const dir = mkdtempSync(join(tmpdir(), "git-pi-durable-"));
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
	git("init", "-q", "-b", "main");
	return {
		dir,
		git,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}
