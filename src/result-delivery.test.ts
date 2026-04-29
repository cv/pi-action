import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	postResult,
	setResultOutputs,
	shareSessionForResult,
} from "./result-delivery.js";
import { shareSession } from "./share.js";
import { createMockGitHubClient, createTriggerInfo } from "./test-helpers.js";

vi.mock("./share.js", () => ({
	shareSession: vi.fn(),
}));

describe("result delivery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns undefined share URL when sharing is disabled", async () => {
		const shareUrl = await shareSessionForResult(
			"Issue title",
			{
				success: true,
				response: "Done",
				session: { exportToHtml: vi.fn(), exportToJsonl: vi.fn() },
			},
			false,
			{
				info: vi.fn(),
				warning: vi.fn(),
				error: vi.fn(),
				setFailed: vi.fn(),
				setOutput: vi.fn(),
			},
		);

		expect(shareUrl).toBeUndefined();
		expect(shareSession).not.toHaveBeenCalled();
	});

	it("does not set share_url output when absent", () => {
		const log = {
			info: vi.fn(),
			warning: vi.fn(),
			error: vi.fn(),
			setFailed: vi.fn(),
			setOutput: vi.fn(),
		};

		setResultOutputs(log, { success: true, response: "Done" }, undefined);

		expect(log.setOutput).toHaveBeenCalledWith("success", "true");
		expect(log.setOutput).toHaveBeenCalledWith("response", "Done");
		expect(log.setOutput).not.toHaveBeenCalledWith(
			"share_url",
			expect.anything(),
		);
	});

	it("posts errors with confused reaction", async () => {
		const client = createMockGitHubClient();
		const log = {
			info: vi.fn(),
			warning: vi.fn(),
			error: vi.fn(),
			setFailed: vi.fn(),
			setOutput: vi.fn(),
		};

		await postResult(
			client,
			createTriggerInfo({ issueNumber: 7 }),
			{ success: false, error: "Nope" },
			true,
			log,
		);

		expect(log.error).toHaveBeenCalledWith("pi execution failed: Nope");
		expect(client.addReactionToIssue).toHaveBeenCalledWith(7, "confused");
		expect(client.createComment).toHaveBeenCalledWith(
			7,
			"### ❌ pi Error\n\nFailed to process request: Nope",
		);
	});
});
