import { describe, expect, it, vi } from "vitest";
import type { ActionDependencies, ActionInputs } from "./run.js";
import { getRunContext } from "./run-context.js";
import { createActionInputs, createMockGitHubClient } from "./test-helpers.js";

function deps(
	inputs: Partial<ActionInputs>,
	payload: Record<string, unknown> = {},
	gh = createMockGitHubClient(),
): ActionDependencies {
	return {
		inputs: createActionInputs(inputs),
		context: { payload, repo: { owner: "o", name: "r" } },
		createClient: () => gh,
		log: {
			info: vi.fn(),
			warning: vi.fn(),
			error: vi.fn(),
			setFailed: vi.fn(),
			setOutput: vi.fn(),
		},
		cwd: "/tmp",
	};
}

const issue = (body: string, extra: Record<string, unknown> = {}) => ({
	issue: {
		number: 3,
		title: "Bug",
		body,
		user: { login: "owner", type: "User" },
		author_association: "OWNER",
		...extra,
	},
});

describe("getRunContext", () => {
	it("resolves an issue trigger", async () => {
		const context = await getRunContext(deps({}, issue("@pi fix it")));
		expect(context?.piContext).toMatchObject({
			type: "issue",
			number: 3,
			task: "fix it",
		});
		expect(context?.triggerInfo?.issueNumber).toBe(3);
	});

	it("adds the diff and existing review comments for pull requests", async () => {
		const gh = createMockGitHubClient();
		vi.mocked(gh.getPullRequestDiff).mockResolvedValue("+x");
		vi.mocked(gh.getPullRequestReviewComments).mockResolvedValue([
			{
				id: 1,
				body: "nit",
				user: { login: "rev", type: "User" },
				created_at: "2026-01-01T00:00:00Z",
			},
		]);
		const payload = {
			pull_request: {
				number: 5,
				title: "PR",
				body: "@pi review",
				user: { login: "owner", type: "User" },
				author_association: "OWNER",
			},
		};
		const context = await getRunContext(deps({}, payload, gh));
		expect(context?.piContext).toMatchObject({
			type: "pull_request",
			diff: "+x",
		});
		expect(context?.piContext).toHaveProperty(
			"reviewComments",
			expect.stringContaining("nit"),
		);
	});

	it("keeps going without review comments when they cannot be fetched", async () => {
		const gh = createMockGitHubClient();
		vi.mocked(gh.getPullRequestReviewComments).mockRejectedValue(
			new Error("403"),
		);
		const d = deps({ prNumber: 9 }, {}, gh);
		const context = await getRunContext(d);
		expect(context?.piContext).toMatchObject({
			type: "pull_request",
			task: "Please review this pull request",
		});
		expect(d.log.warning).toHaveBeenCalledWith(expect.stringContaining("403"));
	});

	it("resolves pr_number with a prompt", async () => {
		const context = await getRunContext(
			deps({ prNumber: 1, prompt: "Check tests" }),
		);
		expect(context?.piContext).toMatchObject({
			type: "pull_request",
			task: "Check tests",
		});
		expect(context?.triggerInfo).toBeUndefined();
	});

	it("resolves a direct prompt in output mode", async () => {
		const context = await getRunContext(
			deps({ prompt: "Hello", outputMode: "output" }),
		);
		expect(context?.piContext).toEqual({
			type: "direct",
			title: "Direct prompt",
			task: "Hello",
		});
	});

	it("rejects a direct prompt in comment mode", async () => {
		const d = deps({ prompt: "Hello" });
		expect(await getRunContext(d)).toBeNull();
		expect(d.log.setFailed).toHaveBeenCalledWith(
			"prompt requires output_mode: output when no PR number is set",
		);
	});

	it("needs a GitHub token", async () => {
		for (const inputs of [
			{ githubToken: undefined },
			{ githubToken: undefined, prNumber: 1 },
			{ githubToken: undefined, prompt: "x", outputMode: "output" as const },
		]) {
			const d = deps(inputs, issue("@pi go"));
			// biome-ignore lint/performance/noAwaitInLoops: one case at a time
			expect(await getRunContext(d)).toBeNull();
			expect(d.log.setFailed).toHaveBeenCalledWith("github_token is required");
		}
	});

	it("skips payloads without a trigger, without the phrase, or from users without permission", async () => {
		expect(await getRunContext(deps({}, {}))).toBeNull();
		expect(await getRunContext(deps({}, issue("no mention")))).toBeNull();
		const d = deps({}, issue("@pi go", { author_association: "NONE" }));
		expect(await getRunContext(d)).toBeNull();
		expect(d.log.warning).toHaveBeenCalledWith(
			expect.stringContaining("does not have permission"),
		);
	});
});
