import { describe, expect, it } from "vitest";
import { readCustomProviderConfig } from "./custom-provider.js";
import { DEFAULTS } from "./defaults.js";

function createInputReader(
	values: Record<string, string>,
): (name: string) => string {
	return (name) => values[name] ?? "";
}

describe("readCustomProviderConfig", () => {
	it("returns undefined when provider_base_url is empty", () => {
		expect(readCustomProviderConfig(createInputReader({}))).toBeUndefined();
	});

	it("reads a single custom provider/model config from flat inputs", () => {
		const config = readCustomProviderConfig(
			createInputReader({
				provider_base_url: "https://inference-api.nvidia.com",
				provider_api: "openai-responses",
				provider_api_key: "NVIDIA_API_KEY",
				provider_auth_header: "true",
				model_name: "GPT-5.5 (OpenAI)",
				model_reasoning: "true",
				model_input: "text,image",
				model_context_window: "1050000",
				model_max_tokens: "16384",
				compat_supports_developer_role: "false",
				compat_supports_reasoning_effort: "false",
			}),
		);

		expect(config).toEqual({
			baseUrl: "https://inference-api.nvidia.com",
			api: "openai-responses",
			apiKey: "NVIDIA_API_KEY",
			authHeader: true,
			modelName: "GPT-5.5 (OpenAI)",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_050_000,
			maxTokens: 16_384,
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
			},
		});
	});

	it("uses defaults for optional custom provider/model inputs", () => {
		const config = readCustomProviderConfig(
			createInputReader({ provider_base_url: "http://localhost:11434/v1" }),
		);

		expect(config).toEqual({
			baseUrl: "http://localhost:11434/v1",
			api: DEFAULTS.customProviderApi,
			authHeader: DEFAULTS.customProviderAuthHeader,
			reasoning: DEFAULTS.customModelReasoning,
			input: [DEFAULTS.customModelInput],
			contextWindow: DEFAULTS.customModelContextWindow,
			maxTokens: DEFAULTS.customModelMaxTokens,
		});
	});
});
