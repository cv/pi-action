import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "./agent.js";
import { runAgentWithEmptyResponseRetry } from "./empty-response-retry.js";
import { createAgentConfig, createPIContext } from "./test-helpers.js";

vi.mock("./agent.js", () => ({
	runAgent: vi.fn(),
}));

describe("runAgentWithEmptyResponseRetry", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns the first result when it is not an empty-response failure", async () => {
		vi.mocked(runAgent).mockResolvedValue({
			success: true,
			response: "Done",
		});

		const result = await runAgentWithEmptyResponseRetry(
			createPIContext(),
			createAgentConfig(),
			{ warning: vi.fn() },
		);

		expect(result).toEqual({ success: true, response: "Done" });
		expect(runAgent).toHaveBeenCalledTimes(1);
	});

	it("returns a combined failure when the retry also fails", async () => {
		vi.mocked(runAgent)
			.mockResolvedValueOnce({
				success: false,
				error: "Agent returned empty response",
			})
			.mockResolvedValueOnce({
				success: false,
				error: "Retry failed",
			});

		const result = await runAgentWithEmptyResponseRetry(
			createPIContext(),
			createAgentConfig(),
			{ warning: vi.fn() },
		);

		expect(result).toEqual({
			success: false,
			error:
				"Agent failed to provide a response after two attempts. First attempt: Agent returned empty response. Retry attempt: Retry failed.",
		});
	});

	it("preserves the first session when retry succeeds", async () => {
		const firstSession = { exportToHtml: vi.fn(), exportToJsonl: vi.fn() };
		vi.mocked(runAgent)
			.mockResolvedValueOnce({
				success: false,
				error: "Agent returned empty response",
				session: firstSession,
			})
			.mockResolvedValueOnce({
				success: true,
				response: "Summary",
			});

		const result = await runAgentWithEmptyResponseRetry(
			createPIContext(),
			createAgentConfig(),
			{ warning: vi.fn() },
		);

		expect(result).toEqual({
			success: true,
			response: "Summary",
			session: firstSession,
		});
	});

	it("preserves the retry session when first session is absent", async () => {
		const retrySession = { exportToHtml: vi.fn(), exportToJsonl: vi.fn() };
		vi.mocked(runAgent)
			.mockResolvedValueOnce({
				success: false,
				error: "Agent returned empty response",
			})
			.mockResolvedValueOnce({
				success: false,
				error: "Retry failed",
				session: retrySession,
			});

		const result = await runAgentWithEmptyResponseRetry(
			createPIContext(),
			createAgentConfig(),
			{ warning: vi.fn() },
		);

		expect(result).toEqual({
			success: false,
			error:
				"Agent failed to provide a response after two attempts. First attempt: Agent returned empty response. Retry attempt: Retry failed.",
			session: retrySession,
		});
	});
});
