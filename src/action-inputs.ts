import { readCustomProviderConfig } from "./custom-provider.js";
import { DEFAULTS } from "./defaults.js";
import {
	getInputOrDefault,
	type InputReader,
	parseBooleanInput,
	parseCsvInput,
	parsePositiveIntegerInput,
} from "./inputs.js";
import type { ActionInputs } from "./run.js";

const GITHUB_TOKEN_ENV = "GITHUB_TOKEN";

function getOutputMode(readInput: InputReader): "comment" | "output" {
	return readInput("output_mode") === "output" ? "output" : DEFAULTS.outputMode;
}

export function readActionInputs(
	readInput: InputReader,
	env: Record<string, string | undefined> = process.env,
): ActionInputs {
	const prNumber = parsePositiveIntegerInput(readInput("pr_number"), 0);
	return {
		triggerPhrase: getInputOrDefault(
			readInput,
			"trigger_phrase",
			DEFAULTS.triggerPhrase,
		),
		allowedBots: parseCsvInput(readInput("allowed_bots")),
		modelConfig: {
			timeout: parsePositiveIntegerInput(
				readInput("timeout"),
				DEFAULTS.timeout,
			),
			provider: getInputOrDefault(readInput, "provider", DEFAULTS.provider),
			model: getInputOrDefault(readInput, "model", DEFAULTS.model),
		},
		githubToken: readInput("github_token") || env[GITHUB_TOKEN_ENV],
		gistToken: readInput("gist_token") || undefined,
		apiKey: readInput("api_key") || undefined,
		customProvider: readCustomProviderConfig(readInput),
		promptTemplate: readInput("prompt_template") || undefined,
		shareSession: parseBooleanInput(
			readInput("share_session"),
			DEFAULTS.shareSession,
		),
		outputMode: getOutputMode(readInput),
		prompt: readInput("prompt") || undefined,
		prNumber: prNumber > 0 ? prNumber : undefined,
	};
}
