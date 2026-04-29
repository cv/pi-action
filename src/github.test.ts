import { describe, expect, it, vi } from "vitest";
import {
	addReaction,
	createGitHubClient,
	extractTriggerInfo,
	type GitHubContext,
} from "./github.js";
import { createMockGitHubClient, createTriggerInfo } from "./test-helpers.js";

describe("extractTriggerInfo", () => {
	describe("comment events", () => {
		it("extracts info from issue comment", () => {
			const payload = {
				comment: {
					id: 123,
					body: "@pi do something",
					user: { login: "testuser", type: "User" },
					author_association: "MEMBER",
				},
				issue: {
					number: 42,
					title: "Test Issue",
					body: "Issue body",
					user: { login: "issueauthor", type: "User" },
					author_association: "OWNER",
				},
			};

			const result = extractTriggerInfo(payload);
			expect(result).toEqual({
				isCommentEvent: true,
				triggerText: "@pi do something",
				author: { login: "testuser", type: "User" },
				authorAssociation: "MEMBER",
				issueNumber: 42,
				issueTitle: "Test Issue",
				issueBody: "Issue body",
				commentId: 123,
				isPullRequest: false,
			});
		});

		it("extracts info from PR review comment", () => {
			const payload = {
				comment: {
					id: 456,
					body: "@pi review this",
					user: { login: "reviewer", type: "User" },
					author_association: "COLLABORATOR",
				},
				pull_request: {
					number: 99,
					title: "Add feature",
					body: "PR description",
					user: { login: "prauthor", type: "User" },
					author_association: "CONTRIBUTOR",
				},
			};

			const result = extractTriggerInfo(payload);
			expect(result).toEqual({
				isCommentEvent: true,
				triggerText: "@pi review this",
				author: { login: "reviewer", type: "User" },
				authorAssociation: "COLLABORATOR",
				issueNumber: 99,
				issueTitle: "Add feature",
				issueBody: "PR description",
				commentId: 456,
				isPullRequest: true,
			});
		});

		it("treats issue comments on pull requests as pull request triggers", () => {
			const payload = {
				comment: {
					id: 789,
					body: "@pi review this PR",
					user: { login: "reviewer", type: "User" },
					author_association: "MEMBER",
				},
				issue: {
					number: 100,
					title: "PR as issue",
					body: "PR body",
					user: { login: "prauthor", type: "User" },
					author_association: "CONTRIBUTOR",
					pull_request: {
						url: "https://api.github.com/repos/test/repo/pulls/100",
					},
				},
			};

			const result = extractTriggerInfo(payload);

			expect(result).toEqual(
				expect.objectContaining({
					isCommentEvent: true,
					issueNumber: 100,
					isPullRequest: true,
				}),
			);
		});
	});

	describe("opened events", () => {
		it("extracts info from opened issue", () => {
			const payload = {
				issue: {
					number: 1,
					title: "New Issue",
					body: "@pi help me with this",
					user: { login: "creator", type: "User" },
					author_association: "OWNER",
				},
			};

			const result = extractTriggerInfo(payload);
			expect(result).toEqual({
				isCommentEvent: false,
				triggerText: "@pi help me with this",
				author: { login: "creator", type: "User" },
				authorAssociation: "OWNER",
				issueNumber: 1,
				issueTitle: "New Issue",
				issueBody: "@pi help me with this",
				commentId: undefined,
				isPullRequest: false,
			});
		});

		it("extracts info from opened PR", () => {
			const payload = {
				pull_request: {
					number: 5,
					title: "New PR",
					body: "@pi please review",
					user: { login: "contributor", type: "User" },
					author_association: "CONTRIBUTOR",
				},
			};

			const result = extractTriggerInfo(payload);
			expect(result).toEqual({
				isCommentEvent: false,
				triggerText: "@pi please review",
				author: { login: "contributor", type: "User" },
				authorAssociation: "CONTRIBUTOR",
				issueNumber: 5,
				issueTitle: "New PR",
				issueBody: "@pi please review",
				commentId: undefined,
				isPullRequest: true,
			});
		});
	});

	describe("edge cases", () => {
		it("returns null for empty payload", () => {
			expect(extractTriggerInfo({})).toBeNull();
		});

		it("returns null when issue body is missing", () => {
			const payload = {
				issue: {
					number: 1,
					title: "No body",
					body: null,
					user: { login: "user", type: "User" },
					author_association: "OWNER",
				},
			};
			expect(extractTriggerInfo(payload)).toBeNull();
		});

		it("handles empty issue body", () => {
			const payload = {
				issue: {
					number: 1,
					title: "Empty body",
					body: "",
					user: { login: "user", type: "User" },
					author_association: "OWNER",
				},
			};
			// Empty string is falsy, so returns null
			expect(extractTriggerInfo(payload)).toBeNull();
		});

		it("handles bot users", () => {
			const payload = {
				comment: {
					id: 789,
					body: "@pi automated task",
					user: { login: "dependabot[bot]", type: "Bot" },
					author_association: "NONE",
				},
				issue: {
					number: 10,
					title: "Dependency update",
					body: "Update deps",
					user: { login: "dependabot[bot]", type: "Bot" },
					author_association: "NONE",
				},
			};

			const result = extractTriggerInfo(payload);
			expect(result?.author.type).toBe("Bot");
			expect(result?.author.login).toBe("dependabot[bot]");
		});
	});
});

describe("createGitHubClient", () => {
	const mockContext: GitHubContext = {
		repo: {
			owner: "testowner",
			name: "testrepo",
		},
	};

	function createMockOctokit() {
		return {
			rest: {
				reactions: {
					createForIssueComment: vi.fn(),
					createForIssue: vi.fn(),
				},
				issues: {
					createComment: vi.fn(),
				},
				pulls: {
					get: vi.fn(),
					listReviewComments: vi.fn(),
				},
				gists: {
					create: vi.fn(),
				},
			},
		};
	}

	it("addReactionToComment calls correct API", async () => {
		const octokit = createMockOctokit();
		const client = createGitHubClient(octokit, mockContext);

		await client.addReactionToComment(123, "eyes");

		expect(octokit.rest.reactions.createForIssueComment).toHaveBeenCalledWith({
			owner: "testowner",
			repo: "testrepo",
			comment_id: 123,
			content: "eyes",
		});
	});

	it("addReactionToIssue calls correct API", async () => {
		const octokit = createMockOctokit();
		const client = createGitHubClient(octokit, mockContext);

		await client.addReactionToIssue(42, "rocket");

		expect(octokit.rest.reactions.createForIssue).toHaveBeenCalledWith({
			owner: "testowner",
			repo: "testrepo",
			issue_number: 42,
			content: "rocket",
		});
	});

	it("createComment calls correct API", async () => {
		const octokit = createMockOctokit();
		const client = createGitHubClient(octokit, mockContext);

		await client.createComment(42, "Hello world");

		expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
			owner: "testowner",
			repo: "testrepo",
			issue_number: 42,
			body: "Hello world",
		});
	});

	it("getPullRequest calls correct API and returns PR metadata", async () => {
		const octokit = createMockOctokit();
		octokit.rest.pulls.get.mockResolvedValue({
			data: {
				number: 99,
				title: "Add feature",
				body: "PR body",
				user: { login: "author", type: "User" },
				author_association: "OWNER",
			},
		});
		const client = createGitHubClient(octokit, mockContext);

		const pullRequest = await client.getPullRequest(99);

		expect(octokit.rest.pulls.get).toHaveBeenCalledWith({
			owner: "testowner",
			repo: "testrepo",
			pull_number: 99,
		});
		expect(pullRequest.title).toBe("Add feature");
	});

	it("getPullRequestDiff calls correct API and returns diff", async () => {
		const octokit = createMockOctokit();
		octokit.rest.pulls.get.mockResolvedValue({
			data: "+added line\n-removed line",
		});
		const client = createGitHubClient(octokit, mockContext);

		const diff = await client.getPullRequestDiff(99);

		expect(octokit.rest.pulls.get).toHaveBeenCalledWith({
			owner: "testowner",
			repo: "testrepo",
			pull_number: 99,
			mediaType: { format: "diff" },
		});
		expect(diff).toBe("+added line\n-removed line");
	});

	it("getPullRequestReviewComments calls correct API and returns comments", async () => {
		const octokit = createMockOctokit();
		octokit.rest.pulls.listReviewComments.mockResolvedValue({
			data: [
				{
					id: 1,
					body: "Please simplify this",
					user: { login: "reviewer", type: "User" },
					path: "src/file.ts",
					line: 12,
					created_at: "2026-04-29T00:00:00Z",
				},
			],
		});
		const client = createGitHubClient(octokit, mockContext);

		const comments = await client.getPullRequestReviewComments(99);

		expect(octokit.rest.pulls.listReviewComments).toHaveBeenCalledWith({
			owner: "testowner",
			repo: "testrepo",
			pull_number: 99,
		});
		expect(comments).toEqual([
			{
				id: 1,
				body: "Please simplify this",
				user: { login: "reviewer", type: "User" },
				path: "src/file.ts",
				line: 12,
				created_at: "2026-04-29T00:00:00Z",
			},
		]);
	});

	it("omits optional review comment location fields when absent", async () => {
		const octokit = createMockOctokit();
		octokit.rest.pulls.listReviewComments.mockResolvedValue({
			data: [
				{
					id: 2,
					body: "General comment",
					user: { login: "reviewer", type: "User" },
					created_at: "2026-04-29T00:00:00Z",
				},
			],
		});
		const client = createGitHubClient(octokit, mockContext);

		const comments = await client.getPullRequestReviewComments(99);

		expect(comments).toEqual([
			{
				id: 2,
				body: "General comment",
				user: { login: "reviewer", type: "User" },
				created_at: "2026-04-29T00:00:00Z",
			},
		]);
	});
});

describe("addReaction", () => {
	it("adds reaction to comment when isCommentEvent is true", async () => {
		const client = createMockGitHubClient();
		const triggerInfo = createTriggerInfo({
			isCommentEvent: true,
			commentId: 123,
		});

		await addReaction(client, triggerInfo, "eyes");

		expect(client.addReactionToComment).toHaveBeenCalledWith(123, "eyes");
		expect(client.addReactionToIssue).not.toHaveBeenCalled();
	});

	it("adds reaction to issue when isCommentEvent is false", async () => {
		const client = createMockGitHubClient();
		const triggerInfo = createTriggerInfo({
			isCommentEvent: false,
			issueNumber: 42,
		});

		await addReaction(client, triggerInfo, "rocket");

		expect(client.addReactionToIssue).toHaveBeenCalledWith(42, "rocket");
		expect(client.addReactionToComment).not.toHaveBeenCalled();
	});

	it("adds reaction to issue when commentId is undefined", async () => {
		const client = createMockGitHubClient();
		const triggerInfo = createTriggerInfo({
			isCommentEvent: true, // This shouldn't happen in practice, but test the fallback
			issueNumber: 42,
		});

		await addReaction(client, triggerInfo, "confused");

		// When commentId is undefined, should fall back to issue reaction
		expect(client.addReactionToIssue).toHaveBeenCalledWith(42, "confused");
		expect(client.addReactionToComment).not.toHaveBeenCalled();
	});
});
