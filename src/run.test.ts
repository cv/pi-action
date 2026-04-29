import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "./defaults.js";
import { type ActionDependencies, run } from "./run.js";
import {
	createActionInputs,
	createIssuePayload,
	createMockGitHubClient,
	createModelConfig,
	createPullRequestPayload,
	createRepoRef,
} from "./test-helpers.js";

// Mock the agent module
vi.mock("./agent.js", () => ({
	runAgent: vi.fn(),
}));

// Mock the share module
vi.mock("./share.js", () => ({
	shareSession: vi.fn(),
}));

import { runAgent } from "./agent.js";
import { shareSession } from "./share.js";
import type { CustomProviderConfig } from "./types.js";

describe("run", () => {
	function createMockDeps(
		overrides: Partial<ActionDependencies> = {},
	): ActionDependencies {
		return {
			inputs: createActionInputs(),
			context: {
				payload: {},
				repo: createRepoRef(),
			},
			createClient: vi.fn(() => createMockGitHubClient()),
			log: {
				info: vi.fn(),
				warning: vi.fn(),
				error: vi.fn(),
				setFailed: vi.fn(),
				setOutput: vi.fn(),
			},
			cwd: "/test/cwd",
			...overrides,
		};
	}

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("skips when no issue or PR in payload", async () => {
		const deps = createMockDeps();
		await run(deps);
		expect(deps.log.info).toHaveBeenCalledWith(
			"No issue or pull_request in payload, skipping",
		);
	});

	it("skips when trigger phrase not found", async () => {
		const deps = createMockDeps({
			context: {
				payload: {
					issue: {
						number: 1,
						title: "Test",
						body: "No trigger here",
						user: { login: "user", type: "User" },
						author_association: "OWNER",
					},
				},
				repo: { owner: "testowner", name: "testrepo" },
			},
		});

		await run(deps);
		expect(deps.log.info).toHaveBeenCalledWith(
			'No trigger phrase "@pi" found, skipping',
		);
	});

	it("warns and skips when user lacks permission", async () => {
		const deps = createMockDeps({
			context: {
				payload: {
					issue: {
						number: 1,
						title: "Test",
						body: "@pi do something",
						user: { login: "stranger", type: "User" },
						author_association: "NONE",
					},
				},
				repo: { owner: "testowner", name: "testrepo" },
			},
		});

		await run(deps);
		expect(deps.log.warning).toHaveBeenCalledWith(
			"User stranger (NONE) does not have permission",
		);
	});

	it("allows bots in allowedBots list", async () => {
		const mockClient = createMockGitHubClient();
		const deps = createMockDeps({
			inputs: {
				triggerPhrase: DEFAULTS.triggerPhrase,
				allowedBots: ["dependabot[bot]"],
				modelConfig: createModelConfig(),
				githubToken: "test-token",
				apiKey: undefined,
				customProvider: undefined,
				promptTemplate: undefined,
				shareSession: DEFAULTS.shareSession,
				outputMode: "comment",
				prompt: undefined,
				prNumber: undefined,
			},
			context: {
				payload: {
					comment: {
						id: 123,
						body: "@pi update deps",
						user: { login: "dependabot[bot]", type: "Bot" },
						author_association: "NONE",
					},
					issue: {
						number: 1,
						title: "Dependency Update",
						body: "Update deps",
						user: { login: "dependabot[bot]", type: "Bot" },
						author_association: "NONE",
					},
				},
				repo: createRepoRef(),
			},
			createClient: vi.fn(() => mockClient),
		});

		vi.mocked(runAgent).mockResolvedValue({
			success: true,
			response: "Done",
		});

		await run(deps);

		// Should not have logged a warning about permissions
		expect(deps.log.warning).not.toHaveBeenCalled();
		// Should have proceeded to add reaction
		expect(mockClient.addReactionToComment).toHaveBeenCalledWith(123, "eyes");
	});

	it("fails when github_token is missing", async () => {
		const deps = createMockDeps({
			inputs: {
				triggerPhrase: DEFAULTS.triggerPhrase,
				allowedBots: [],
				modelConfig: createModelConfig(),
				githubToken: undefined,
				apiKey: undefined,
				customProvider: undefined,
				promptTemplate: undefined,
				shareSession: DEFAULTS.shareSession,
				outputMode: "comment",
				prompt: undefined,
				prNumber: undefined,
			},
			context: {
				payload: {
					issue: {
						number: 1,
						title: "Test",
						body: "@pi do something",
						user: { login: "user", type: "User" },
						author_association: "OWNER",
					},
				},
				repo: createRepoRef(),
			},
		});

		await run(deps);
		expect(deps.log.setFailed).toHaveBeenCalledWith("github_token is required");
	});

	it("runs agent and posts success response", async () => {
		const mockClient = createMockGitHubClient();
		const deps = createMockDeps({
			context: {
				payload: createIssuePayload({ number: 42, body: "@pi help me" }),
				repo: createRepoRef(),
			},
			createClient: vi.fn(() => mockClient),
		});

		vi.mocked(runAgent).mockResolvedValue({
			success: true,
			response: "Here is your help!",
		});

		await run(deps);

		expect(mockClient.addReactionToIssue).toHaveBeenCalledWith(42, "eyes");
		expect(runAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "issue",
				title: "Test Issue",
				task: "help me",
			}),
			expect.objectContaining({
				provider: DEFAULTS.provider,
				model: DEFAULTS.model,
				timeout: DEFAULTS.timeout,
				cwd: "/test/cwd",
			}),
		);
		expect(mockClient.addReactionToIssue).toHaveBeenCalledWith(42, "rocket");
		expect(mockClient.createComment).toHaveBeenCalledWith(
			42,
			"### 🤖 pi Response\n\nHere is your help!",
		);
	});

	it("passes api_key through to the agent config", async () => {
		const mockClient = createMockGitHubClient();
		const deps = createMockDeps({
			inputs: {
				triggerPhrase: DEFAULTS.triggerPhrase,
				allowedBots: [],
				modelConfig: createModelConfig(),
				githubToken: "test-token",
				apiKey: "sk-test",
				customProvider: undefined,
				promptTemplate: undefined,
				shareSession: DEFAULTS.shareSession,
				outputMode: "comment",
				prompt: undefined,
				prNumber: undefined,
			},
			context: {
				payload: {
					issue: {
						number: 42,
						title: "Test Issue",
						body: "@pi help me",
						user: { login: "user", type: "User" },
						author_association: "OWNER",
					},
				},
				repo: createRepoRef(),
			},
			createClient: vi.fn(() => mockClient),
		});

		vi.mocked(runAgent).mockResolvedValue({
			success: true,
			response: "Done",
		});

		await run(deps);

		expect(runAgent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ apiKey: "sk-test" }),
		);
	});

	it("passes custom provider config through to the agent config", async () => {
		const mockClient = createMockGitHubClient();
		const customProvider: CustomProviderConfig = {
			baseUrl: "https://inference-api.nvidia.com",
			api: "openai-responses",
			authHeader: false,
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1050000,
			maxTokens: 16384,
		};
		const deps = createMockDeps({
			inputs: {
				triggerPhrase: DEFAULTS.triggerPhrase,
				allowedBots: [],
				modelConfig: createModelConfig(),
				githubToken: "test-token",
				apiKey: "sk-test",
				customProvider,
				promptTemplate: undefined,
				shareSession: DEFAULTS.shareSession,
				outputMode: "comment",
				prompt: undefined,
				prNumber: undefined,
			},
			context: {
				payload: {
					issue: {
						number: 42,
						title: "Test Issue",
						body: "@pi help me",
						user: { login: "user", type: "User" },
						author_association: "OWNER",
					},
				},
				repo: createRepoRef(),
			},
			createClient: vi.fn(() => mockClient),
		});

		vi.mocked(runAgent).mockResolvedValue({
			success: true,
			response: "Done",
		});

		await run(deps);

		expect(runAgent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ customProvider }),
		);
	});

	it("runs agent and posts error response on failure", async () => {
		const mockClient = createMockGitHubClient();
		const deps = createMockDeps({
			context: {
				payload: {
					issue: {
						number: 42,
						title: "Test Issue",
						body: "@pi do something",
						user: { login: "user", type: "User" },
						author_association: "MEMBER",
					},
				},
				repo: createRepoRef(),
			},
			createClient: vi.fn(() => mockClient),
		});

		vi.mocked(runAgent).mockResolvedValue({
			success: false,
			error: "Model not found",
		});

		await run(deps);

		expect(deps.log.error).toHaveBeenCalledWith(
			"pi execution failed: Model not found",
		);
		expect(mockClient.addReactionToIssue).toHaveBeenCalledWith(42, "confused");
		expect(mockClient.createComment).toHaveBeenCalledWith(
			42,
			"### ❌ pi Error\n\nFailed to process request: Model not found",
		);
	});

	it("fetches PR diff for pull requests", async () => {
		const mockClient = createMockGitHubClient();
		mockClient.getPullRequestDiff = vi
			.fn()
			.mockResolvedValue("+added\n-removed");
		const deps = createMockDeps({
			context: {
				payload: {
					pull_request: {
						number: 99,
						title: "Add Feature",
						body: "@pi review",
						user: { login: "contributor", type: "User" },
						author_association: "COLLABORATOR",
					},
				},
				repo: createRepoRef(),
			},
			createClient: vi.fn(() => mockClient),
		});

		vi.mocked(runAgent).mockResolvedValue({
			success: true,
			response: "LGTM!",
		});

		await run(deps);

		expect(mockClient.getPullRequestDiff).toHaveBeenCalledWith(99);
		expect(runAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "pull_request",
				diff: "+added\n-removed",
			}),
			expect.anything(),
		);
	});

	it("handles comment events", async () => {
		const mockClient = createMockGitHubClient();
		const deps = createMockDeps({
			context: {
				payload: {
					comment: {
						id: 123,
						body: "@pi format code",
						user: { login: "reviewer", type: "User" },
						author_association: "MEMBER",
					},
					issue: {
						number: 42,
						title: "Code Review",
						body: "Please review",
						user: { login: "author", type: "User" },
						author_association: "OWNER",
					},
				},
				repo: createRepoRef(),
			},
			createClient: vi.fn(() => mockClient),
		});

		vi.mocked(runAgent).mockResolvedValue({
			success: true,
			response: "Code formatted!",
		});

		await run(deps);

		// Should add reaction to comment, not issue
		expect(mockClient.addReactionToComment).toHaveBeenCalledWith(123, "eyes");
		expect(mockClient.addReactionToComment).toHaveBeenCalledWith(123, "rocket");
		expect(mockClient.addReactionToIssue).not.toHaveBeenCalled();
	});

	it("sanitizes input before processing", async () => {
		const mockClient = createMockGitHubClient();
		const deps = createMockDeps({
			context: {
				payload: {
					issue: {
						number: 1,
						title: "Test",
						body: "@pi <!-- hidden --> do something\u200B",
						user: { login: "user", type: "User" },
						author_association: "OWNER",
					},
				},
				repo: createRepoRef(),
			},
			createClient: vi.fn(() => mockClient),
		});

		vi.mocked(runAgent).mockResolvedValue({
			success: true,
			response: "Done",
		});

		await run(deps);

		expect(runAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				task: "do something",
				triggerComment: "@pi  do something", // HTML comment and invisible char removed
			}),
			expect.anything(),
		);
	});

	it("shares session when shareSession is enabled", async () => {
		const mockClient = createMockGitHubClient();
		const mockSession = { exportToHtml: vi.fn(), exportToJsonl: vi.fn() };

		// Mock shareSession to return a result
		vi.mocked(shareSession).mockResolvedValue({
			artifactName: "pi-session-test",
			artifactDir: "/tmp/pi-session-test",
			artifactUrl: "https://github.com/cv/pi-action/actions/runs/1",
		});

		const deps = createMockDeps({
			context: {
				payload: {
					issue: {
						number: 1,
						title: "Test Issue",
						body: "@pi test task",
						user: { login: "user", type: "User" },
						author_association: "OWNER",
					},
				},
				repo: createRepoRef(),
			},
			createClient: vi.fn(() => mockClient),
			inputs: {
				...createMockDeps().inputs,
				shareSession: true,
			},
		});

		vi.mocked(runAgent).mockResolvedValue({
			success: true,
			response: "Task completed!",
			session: mockSession,
		});

		await run(deps);

		// Check that comment includes session link
		expect(mockClient.createComment).toHaveBeenCalledWith(
			1,
			expect.stringContaining(
				"📎 [Download session artifact](https://github.com/cv/pi-action/actions/runs/1)",
			),
		);
	});

	it("works without session sharing when shareSession is disabled", async () => {
		const mockClient = createMockGitHubClient();

		const deps = createMockDeps({
			context: {
				payload: {
					issue: {
						number: 1,
						title: "Test Issue",
						body: "@pi test task",
						user: { login: "user", type: "User" },
						author_association: "OWNER",
					},
				},
				repo: createRepoRef(),
			},
			createClient: vi.fn(() => mockClient),
			inputs: {
				...createMockDeps().inputs,
				shareSession: false,
			},
		});

		vi.mocked(runAgent).mockResolvedValue({
			success: true,
			response: "Task completed!",
		});

		await run(deps);

		// Check that comment does not include session link
		expect(mockClient.createComment).toHaveBeenCalledWith(
			1,
			"### 🤖 pi Response\n\nTask completed!",
		);
	});

	it("shares session on error response when session is available", async () => {
		const mockClient = createMockGitHubClient();
		const mockSession = { exportToHtml: vi.fn(), exportToJsonl: vi.fn() };

		// Mock shareSession to return a result
		vi.mocked(shareSession).mockResolvedValue({
			artifactName: "pi-session-error",
			artifactDir: "/tmp/pi-session-error",
			artifactUrl: "https://github.com/cv/pi-action/actions/runs/1",
		});

		const deps = createMockDeps({
			context: {
				payload: {
					issue: {
						number: 1,
						title: "Test Issue",
						body: "@pi test task",
						user: { login: "user", type: "User" },
						author_association: "OWNER",
					},
				},
				repo: createRepoRef(),
			},
			createClient: vi.fn(() => mockClient),
			inputs: {
				...createMockDeps().inputs,
				shareSession: true,
			},
		});

		vi.mocked(runAgent).mockResolvedValue({
			success: false,
			error: "Something went wrong",
			session: mockSession,
		});

		await run(deps);

		// Check that error comment includes session link
		expect(mockClient.createComment).toHaveBeenCalledWith(
			1,
			expect.stringContaining(
				"📎 [Download session artifact](https://github.com/cv/pi-action/actions/runs/1)",
			),
		);
		expect(mockClient.createComment).toHaveBeenCalledWith(
			1,
			expect.stringContaining("### ❌ pi Error"),
		);
	});

	it("posts response without session link when sharing fails", async () => {
		const mockClient = createMockGitHubClient();
		const mockSession = { exportToHtml: vi.fn(), exportToJsonl: vi.fn() };

		// Mock shareSession to return null (failure)
		vi.mocked(shareSession).mockResolvedValue(null);

		const deps = createMockDeps({
			context: {
				payload: {
					issue: {
						number: 1,
						title: "Test Issue",
						body: "@pi test task",
						user: { login: "user", type: "User" },
						author_association: "OWNER",
					},
				},
				repo: createRepoRef(),
			},
			createClient: vi.fn(() => mockClient),
			inputs: {
				...createMockDeps().inputs,
				shareSession: true,
			},
		});

		vi.mocked(runAgent).mockResolvedValue({
			success: true,
			response: "Task completed!",
			session: mockSession,
		});

		await run(deps);

		// Should still post the response without session link
		expect(mockClient.createComment).toHaveBeenCalledWith(
			1,
			"### 🤖 pi Response\n\nTask completed!",
		);
	});

	it("posts response without session link when no session is returned", async () => {
		const mockClient = createMockGitHubClient();

		const deps = createMockDeps({
			context: {
				payload: {
					issue: {
						number: 1,
						title: "Test Issue",
						body: "@pi test task",
						user: { login: "user", type: "User" },
						author_association: "OWNER",
					},
				},
				repo: createRepoRef(),
			},
			createClient: vi.fn(() => mockClient),
			inputs: {
				...createMockDeps().inputs,
				shareSession: true,
			},
		});

		// No session returned (undefined)
		vi.mocked(runAgent).mockResolvedValue({
			success: true,
			response: "Task completed!",
		});

		await run(deps);

		// shareSession should not be called when no session
		expect(shareSession).not.toHaveBeenCalled();
		// Should still post the response without session link
		expect(mockClient.createComment).toHaveBeenCalledWith(
			1,
			"### 🤖 pi Response\n\nTask completed!",
		);
	});

	it("logs warning when session sharing throws", async () => {
		const mockClient = createMockGitHubClient();
		const mockSession = { exportToHtml: vi.fn(), exportToJsonl: vi.fn() };

		// Mock shareSession to throw an error
		vi.mocked(shareSession).mockRejectedValue(
			new Error("Artifact upload error"),
		);

		const deps = createMockDeps({
			context: {
				payload: {
					issue: {
						number: 1,
						title: "Test Issue",
						body: "@pi test task",
						user: { login: "user", type: "User" },
						author_association: "OWNER",
					},
				},
				repo: createRepoRef(),
			},
			createClient: vi.fn(() => mockClient),
			inputs: {
				...createMockDeps().inputs,
				shareSession: true,
			},
		});

		vi.mocked(runAgent).mockResolvedValue({
			success: true,
			response: "Task completed!",
			session: mockSession,
		});

		await run(deps);

		// Should log warning
		expect(deps.log.warning).toHaveBeenCalledWith(
			expect.stringContaining("Failed to share session"),
		);
		// Should still post the response without session link
		expect(mockClient.createComment).toHaveBeenCalledWith(
			1,
			"### 🤖 pi Response\n\nTask completed!",
		);
	});

	it("in output mode, sets outputs instead of posting comments", async () => {
		const mockClient = createMockGitHubClient();
		const deps = createMockDeps({
			context: {
				payload: {
					issue: {
						number: 42,
						title: "Test Issue",
						body: "@pi help me",
						user: { login: "user", type: "User" },
						author_association: "OWNER",
					},
				},
				repo: createRepoRef(),
			},
			createClient: vi.fn(() => mockClient),
			inputs: {
				...createMockDeps().inputs,
				outputMode: "output",
			},
		});
		vi.mocked(runAgent).mockResolvedValue({
			success: true,
			response: "Here is your help!",
		});

		await run(deps);

		expect(mockClient.createComment).not.toHaveBeenCalled();
		expect(mockClient.addReactionToIssue).not.toHaveBeenCalled();
		expect(deps.log.setOutput).toHaveBeenCalledWith("success", "true");
		expect(deps.log.setOutput).toHaveBeenCalledWith(
			"response",
			"Here is your help!",
		);
	});

	it("uses direct prompt when output mode has no issue context", async () => {
		const mockClient = createMockGitHubClient();
		const deps = createMockDeps({
			createClient: vi.fn(() => mockClient),
			inputs: {
				...createMockDeps().inputs,
				outputMode: "output",
				prompt: "Generate release notes",
			},
		});
		vi.mocked(runAgent).mockResolvedValue({
			success: true,
			response: "Release notes",
		});

		await run(deps);

		expect(runAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "direct",
				task: "Generate release notes",
			}),
			expect.anything(),
		);
		expect(deps.log.setOutput).toHaveBeenCalledWith(
			"response",
			"Release notes",
		);
	});

	it("loads PR context from pr_number", async () => {
		const mockClient = createMockGitHubClient();
		mockClient.getPullRequest = vi.fn().mockResolvedValue({
			number: 99,
			title: "Add feature",
			body: "PR body",
			user: { login: "author", type: "User" },
			author_association: "OWNER",
		});
		mockClient.getPullRequestDiff = vi.fn().mockResolvedValue("+added");
		const deps = createMockDeps({
			createClient: vi.fn(() => mockClient),
			inputs: {
				...createMockDeps().inputs,
				outputMode: "output",
				prNumber: 99,
				prompt: "Review this PR",
			},
		});
		vi.mocked(runAgent).mockResolvedValue({
			success: true,
			response: "LGTM",
		});

		await run(deps);

		expect(mockClient.getPullRequest).toHaveBeenCalledWith(99);
		expect(mockClient.getPullRequestDiff).toHaveBeenCalledWith(99);
		expect(runAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "pull_request",
				number: 99,
				task: "Review this PR",
				diff: "+added",
			}),
			expect.anything(),
		);
	});

	it("includes PR review comments in PR context", async () => {
		const mockClient = createMockGitHubClient();
		mockClient.getPullRequestDiff = vi.fn().mockResolvedValue("+added");
		mockClient.getPullRequestReviewComments = vi.fn().mockResolvedValue([
			{
				id: 1,
				body: "Please simplify",
				user: { login: "reviewer", type: "User" },
				path: "src/file.ts",
				line: 12,
				created_at: "2026-04-29T00:00:00Z",
			},
		]);
		const deps = createMockDeps({
			context: {
				payload: createPullRequestPayload({ number: 42 }),
				repo: createRepoRef(),
			},
			createClient: vi.fn(() => mockClient),
		});
		vi.mocked(runAgent).mockResolvedValue({
			success: true,
			response: "Reviewed",
		});

		await run(deps);

		expect(runAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				reviewComments: expect.stringContaining("Please simplify"),
			}),
			expect.anything(),
		);
	});

	it("retries once when the agent returns an empty response", async () => {
		const mockClient = createMockGitHubClient();
		const deps = createMockDeps({
			context: {
				payload: {
					issue: {
						number: 1,
						title: "Test Issue",
						body: "@pi do work",
						user: { login: "user", type: "User" },
						author_association: "OWNER",
					},
				},
				repo: createRepoRef(),
			},
			createClient: vi.fn(() => mockClient),
		});
		vi.mocked(runAgent)
			.mockResolvedValueOnce({
				success: false,
				error: "Agent returned empty response",
			})
			.mockResolvedValueOnce({
				success: true,
				response: "Summary after retry",
			});

		await run(deps);

		expect(runAgent).toHaveBeenCalledTimes(2);
		expect(runAgent).toHaveBeenLastCalledWith(
			expect.objectContaining({
				task: expect.stringContaining("final text summary"),
			}),
			expect.objectContaining({ toolNames: [] }),
		);
		expect(mockClient.createComment).toHaveBeenCalledWith(
			1,
			"### 🤖 pi Response\n\nSummary after retry",
		);
	});
});
