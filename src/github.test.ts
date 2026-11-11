import { describe, expect, it, vi } from "vitest";

import { createGitHubClient, extractTriggerInfo } from "./github.ts";

const user = (login: string, type = "User") => ({ login, type });

describe("extractTriggerInfo", () => {
	it.each([
		[
			"an issue without a user",
			{ issue: { number: 1, title: "t", body: "@pi x" } },
		],
		[
			"a comment without a user",
			{
				issue: {
					number: 1,
					title: "t",
					body: "",
					user: { login: "a", type: "User" },
				},
				comment: { id: 2, body: "@pi x" },
			},
		],
	])("skips %s (webhook payloads are not trusted)", (_name, payload) => {
		expect(extractTriggerInfo(payload)).toBeNull();
	});

	it("extracts an issue comment", () => {
		const payload = {
			comment: {
				id: 123,
				body: "@pi do something",
				user: user("testuser"),
				author_association: "MEMBER",
				created_at: "2026-02-02T00:00:00Z",
				html_url: "https://github.com/o/r/issues/42#issuecomment-123",
			},
			issue: {
				number: 42,
				title: "Test Issue",
				body: "Issue body",
				user: user("issueauthor"),
				author_association: "OWNER",
			},
		};
		expect(extractTriggerInfo(payload)).toStrictEqual({
			triggerText: "@pi do something",
			author: user("testuser"),
			authorAssociation: "MEMBER",
			issueNumber: 42,
			issueTitle: "Test Issue",
			issueBody: "Issue body",
			commentId: 123,
			isPullRequest: false,
			source: "comment",
			createdAt: "2026-02-02T00:00:00Z",
			url: "https://github.com/o/r/issues/42#issuecomment-123",
		});
	});

	it("extracts a PR review comment", () => {
		const payload = {
			comment: {
				id: 456,
				body: "@pi review this",
				user: user("reviewer"),
				author_association: "COLLABORATOR",
			},
			pull_request: {
				number: 99,
				title: "Add feature",
				body: "PR description",
				user: user("prauthor"),
				author_association: "CONTRIBUTOR",
			},
		};
		expect(extractTriggerInfo(payload)).toStrictEqual({
			triggerText: "@pi review this",
			author: user("reviewer"),
			authorAssociation: "COLLABORATOR",
			issueNumber: 99,
			issueTitle: "Add feature",
			issueBody: "PR description",
			commentId: 456,
			isPullRequest: true,
			source: "review_comment",
		});
	});

	it("treats issue comments on pull requests as pull request triggers", () => {
		const payload = {
			comment: {
				id: 789,
				body: "@pi review this PR",
				user: user("dependabot[bot]", "Bot"),
				author_association: "NONE",
			},
			issue: {
				number: 100,
				title: "PR as issue",
				body: "PR body",
				user: user("prauthor"),
				author_association: "CONTRIBUTOR",
				pull_request: { url: "https://api.github.com/repos/o/r/pulls/100" },
			},
		};
		expect(extractTriggerInfo(payload)).toMatchObject({
			author: user("dependabot[bot]", "Bot"),
			issueNumber: 100,
			isPullRequest: true,
			source: "comment",
		});
	});

	it.each([
		["issue", false],
		["pull_request", true],
	])("extracts an opened %s", (key, isPullRequest) => {
		const subject = {
			number: 5,
			title: "New",
			body: "@pi please help",
			user: user("creator"),
			author_association: "OWNER",
		};
		expect(extractTriggerInfo({ [key]: subject })).toStrictEqual({
			triggerText: "@pi please help",
			author: user("creator"),
			authorAssociation: "OWNER",
			issueNumber: 5,
			issueTitle: "New",
			issueBody: "@pi please help",
			isPullRequest,
			source: "body",
		});
	});

	it.each([null, ""])(
		"ignores payloads without a trigger text (body %o)",
		(body) => {
			expect(extractTriggerInfo({})).toBeNull();
			const issue = { number: 1, title: "t", body, user: user("u") };
			expect(extractTriggerInfo({ issue })).toBeNull();
		},
	);
});

describe("createGitHubClient", () => {
	function setup() {
		const octokit = {
			rest: {
				reactions: {
					createForIssueComment: vi.fn(),
					createForPullRequestReviewComment: vi.fn(),
					createForIssue: vi.fn(),
				},
				issues: {
					createComment: vi.fn().mockResolvedValue({
						data: { id: 7, html_url: "https://github.com/c/7" },
					}),
					listComments: vi.fn(),
					getComment: vi.fn(),
					updateComment: vi.fn(),
				},
				pulls: { get: vi.fn(), listReviewComments: vi.fn() },
				repos: { getCollaboratorPermissionLevel: vi.fn() },
			},
		};
		const client = createGitHubClient(octokit, { owner: "o", name: "r" });
		return { ...octokit.rest, client };
	}
	const page = (n: number, start: number) =>
		Array.from({ length: n }, (_, i) => ({ id: start + i }));

	it("reacts on the issue, an issue comment, or a review comment", async () => {
		const { client, reactions } = setup();
		await client.addReaction({ source: "body", issueNumber: 42 }, "rocket");
		await client.addReaction(
			{ source: "comment", issueNumber: 42, commentId: 1 },
			"eyes",
		);
		await client.addReaction(
			{ source: "review_comment", issueNumber: 42, commentId: 5 },
			"confused",
		);
		expect(reactions.createForIssue).toHaveBeenCalledWith({
			owner: "o",
			repo: "r",
			issue_number: 42,
			content: "rocket",
		});
		expect(reactions.createForIssueComment).toHaveBeenCalledWith({
			owner: "o",
			repo: "r",
			comment_id: 1,
			content: "eyes",
		});
		expect(reactions.createForPullRequestReviewComment).toHaveBeenCalledWith({
			owner: "o",
			repo: "r",
			comment_id: 5,
			content: "confused",
		});
	});

	it("posts a comment and returns its id and URL", async () => {
		const { client, issues } = setup();
		await expect(client.createComment(42, "Hello")).resolves.toStrictEqual({
			id: 7,
			url: "https://github.com/c/7",
		});
		expect(issues.createComment).toHaveBeenCalledWith({
			owner: "o",
			repo: "r",
			issue_number: 42,
			body: "Hello",
		});
	});

	it("gets and updates an issue comment", async () => {
		const { client, issues } = setup();
		const comment = { id: 7, body: "Hi", author_association: "NONE" };
		issues.getComment.mockResolvedValueOnce({ data: comment });
		await expect(client.getComment(7)).resolves.toBe(comment);
		await client.updateComment(7, "Bye");
		expect(issues.getComment).toHaveBeenCalledWith({
			owner: "o",
			repo: "r",
			comment_id: 7,
		});
		expect(issues.updateComment).toHaveBeenCalledWith({
			owner: "o",
			repo: "r",
			comment_id: 7,
			body: "Bye",
		});
	});

	it("reads a user's role on the repository", async () => {
		const { client, repos } = setup();
		repos.getCollaboratorPermissionLevel
			.mockResolvedValueOnce({
				data: { permission: "write", role_name: "maintain" },
			})
			.mockResolvedValueOnce({ data: { permission: "read" } });
		await expect(client.getCollaboratorPermission("ada")).resolves.toBe(
			"maintain",
		);
		await expect(client.getCollaboratorPermission("bob")).resolves.toBe("read");
		expect(repos.getCollaboratorPermissionLevel).toHaveBeenCalledWith({
			owner: "o",
			repo: "r",
			username: "ada",
		});
	});

	it("gets a pull request and its diff", async () => {
		const { client, pulls } = setup();
		pulls.get
			.mockResolvedValueOnce({
				data: { number: 99, title: "Add feature", body: null },
			})
			.mockResolvedValueOnce({ data: "+added line" });
		await expect(client.getPullRequest(99)).resolves.toStrictEqual({
			number: 99,
			title: "Add feature",
			body: "",
		});
		await expect(client.getPullRequestDiff(99)).resolves.toBe("+added line");
		expect(pulls.get).toHaveBeenLastCalledWith({
			owner: "o",
			repo: "r",
			pull_number: 99,
			mediaType: { format: "diff" },
		});
	});

	it("lists every page of issue comments since a time", async () => {
		const { client, issues } = setup();
		issues.listComments
			.mockResolvedValueOnce({ data: page(100, 0) })
			.mockResolvedValueOnce({ data: page(3, 100) });
		await expect(
			client.listIssueComments(42, "2026-01-01T00:00:00Z"),
		).resolves.toHaveLength(103);
		expect(issues.listComments).toHaveBeenLastCalledWith({
			owner: "o",
			repo: "r",
			issue_number: 42,
			since: "2026-01-01T00:00:00Z",
			per_page: 100,
			page: 2,
		});
	});

	it("lists review comments without a since filter", async () => {
		const { client, pulls } = setup();
		pulls.listReviewComments.mockResolvedValueOnce({ data: page(2, 0) });
		await expect(client.listReviewComments(9)).resolves.toHaveLength(2);
		expect(pulls.listReviewComments).toHaveBeenCalledWith({
			owner: "o",
			repo: "r",
			pull_number: 9,
			per_page: 100,
			page: 1,
		});
	});
});
