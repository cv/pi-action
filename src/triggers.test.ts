import { describe, expect, it } from "vitest";
import {
	createComment,
	createMockGitHubClient,
	createTriggerInfo,
} from "./test-helpers.js";
import {
	collectTriggers,
	triggerFromInfo,
	triggerKey,
	triggersFromComments,
} from "./triggers.js";

const filter = { triggerPhrase: "@pi", allowedBots: ["renovate[bot]"] };

describe("triggerKey", () => {
	it("is stable per GitHub item", () => {
		expect(triggerKey("body", 4)).toBe("issue-4");
		expect(triggerKey("comment", 4, 9)).toBe("comment-9");
		expect(triggerKey("review_comment", 4, 9)).toBe("review-comment-9");
		expect(triggerKey("comment", 4)).toBe("issue-4");
	});
});

describe("triggerFromInfo", () => {
	it("sanitizes the text and extracts the task", () => {
		const trigger = triggerFromInfo(
			createTriggerInfo({
				isCommentEvent: true,
				commentId: 5,
				source: "comment",
				triggerText: "<!-- hidden --> @pi fix the build",
				createdAt: "2026-01-02T00:00:00Z",
			}),
			"@pi",
		);
		expect(trigger).toMatchObject({
			key: "comment-5",
			task: "fix the build",
			text: "@pi fix the build",
		});
		expect(
			triggerFromInfo(createTriggerInfo({ issueNumber: 3 }), "@pi").key,
		).toBe("issue-3");
	});
});

describe("triggersFromComments", () => {
	it("keeps mentions from people with write access and allowed bots", () => {
		const comments = [
			createComment({ id: 1, body: "@pi one" }),
			createComment({ id: 2, body: "no mention" }),
			createComment({
				id: 3,
				body: "@pi outsider",
				author_association: "NONE",
			}),
			createComment({
				id: 4,
				body: "@pi bot",
				user: { login: "renovate[bot]", type: "Bot" },
			}),
			createComment({
				id: 5,
				body: "@pi other bot",
				user: { login: "evil[bot]", type: "Bot" },
			}),
			createComment({ id: 6, body: "@pi ghost", user: null }),
		];
		expect(
			triggersFromComments(comments, "comment", 1, filter).map(
				(t) => t.commentId,
			),
		).toEqual([1, 4]);
	});
});

describe("collectTriggers", () => {
	it("returns only the current trigger for a new thread", async () => {
		const gh = createMockGitHubClient([createComment({ id: 1 })]);
		const current = triggerFromInfo(createTriggerInfo(), "@pi");
		expect(
			await collectTriggers(
				gh,
				{ issueNumber: 1, isPullRequest: false },
				filter,
				undefined,
				current,
			),
		).toEqual([current]);
		expect(gh.listIssueComments).not.toHaveBeenCalled();
	});

	it("merges issue and review comments since the thread began, oldest first, without duplicates", async () => {
		const gh = createMockGitHubClient(
			[
				createComment({ id: 1, created_at: "2025-12-31T00:00:00Z" }),
				createComment({ id: 3, created_at: "2026-01-03T00:00:00Z" }),
				createComment({ id: 2, created_at: "2026-01-02T00:00:00Z" }),
			],
			[createComment({ id: 9, created_at: "2026-01-02T12:00:00Z" })],
		);
		const current = triggerFromInfo(
			createTriggerInfo({
				isCommentEvent: true,
				commentId: 3,
				source: "comment",
				createdAt: "2026-01-03T00:00:00Z",
			}),
			"@pi",
		);
		const found = await collectTriggers(
			gh,
			{ issueNumber: 1, isPullRequest: true },
			filter,
			new Date("2026-01-01T00:00:00Z"),
			current,
		);
		expect(found.map((t) => t.key)).toEqual([
			"comment-2",
			"review-comment-9",
			"comment-3",
		]);
		expect(found[2]).toBe(current);
	});
});
