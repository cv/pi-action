import { type AgentConfig, runAgent } from "./agent.js";
import type { PIContext } from "./context.js";
import type { AgentResult } from "./types.js";

const EMPTY_RESPONSE_ERROR = "Agent returned empty response";

export interface EmptyResponseRetryLogger {
	warning: (msg: string) => void;
}

function shouldRetryEmptyResponse(
	result: AgentResult,
): result is Extract<AgentResult, { success: false }> {
	return !result.success && result.error === EMPTY_RESPONSE_ERROR;
}

export async function runAgentWithEmptyResponseRetry(
	piContext: PIContext,
	agentConfig: AgentConfig,
	log: EmptyResponseRetryLogger,
): Promise<AgentResult> {
	const result = await runAgent(piContext, agentConfig);
	if (!shouldRetryEmptyResponse(result)) {
		return result;
	}

	log.warning(
		"Agent returned empty response from first attempt. Re-prompting for a summary.",
	);
	const firstError = result.error;
	const firstSession = result.session;
	const retryContext: PIContext = {
		...piContext,
		task: `IMPORTANT: You completed your work but did not provide a final text summary. This summary is REQUIRED. Please now write a plain-text summary of what you accomplished, including:
+- What changes were made and why
+- Which files were modified
+- Any errors encountered or remaining issues
+- Confirmation that your work is complete
+
+Do NOT call any tools - just provide the text summary.`,
	};
	const retryResult = await runAgent(retryContext, {
		...agentConfig,
		toolNames: [],
	});

	if (retryResult.success) {
		const retrySuccess = {
			success: true,
			response: retryResult.response,
		} as const;
		const session = firstSession ?? retryResult.session;
		return session ? { ...retrySuccess, session } : retrySuccess;
	}

	const retryFailure = {
		success: false,
		error: `Agent failed to provide a response after two attempts. First attempt: ${firstError}. Retry attempt: ${retryResult.error}.`,
	} as const;
	const session = firstSession ?? retryResult.session;
	return session ? { ...retryFailure, session } : retryFailure;
}
