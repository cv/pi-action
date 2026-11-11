import { describe, expect, it } from "vitest";
import {
	createCustomProvider,
	readCustomProviderConfig,
	resolveApiKey,
} from "./custom-provider.js";
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

describe("resolveApiKey", () => {
	it("reads environment variable names and passes literal keys through", () => {
		expect(resolveApiKey("MY_KEY", { MY_KEY: "from-env" })).toBe("from-env");
		expect(resolveApiKey("MISSING_KEY", {})).toBeUndefined();
		expect(resolveApiKey("sk-literal-123", {})).toBe("sk-literal-123");
		expect(resolveApiKey(undefined)).toBeUndefined();
	});
});

const UNSUPPORTED_API = /Unsupported provider_api "google-generative-ai"/u;

describe("createCustomProvider", () => {
	const config = {
		baseUrl: "https://inference-api.nvidia.com",
		api: "openai-responses",
		authHeader: true,
		reasoning: true,
		input: ["text" as const],
		contextWindow: 1000,
		maxTokens: 100,
		compat: { supportsDeveloperRole: false },
	};
	const ctx = {
		env: () => Promise.resolve(undefined),
		fileExists: () => Promise.resolve(false),
	};
	const { signal } = new AbortController();

	it("describes one model with the configured API and limits", () => {
		const provider = createCustomProvider("nvidia", "gpt", true, config);
		expect(provider.getModels()).toEqual([
			expect.objectContaining({
				id: "gpt",
				name: "gpt",
				provider: "nvidia",
				api: "openai-responses",
				baseUrl: "https://inference-api.nvidia.com",
				contextWindow: 1000,
				maxTokens: 100,
				compat: { supportsDeveloperRole: false },
			}),
		]);
	});

	it("authenticates with the stored api_key, else provider_api_key, and adds the bearer header", async () => {
		const provider = createCustomProvider(
			"nvidia",
			"gpt",
			false,
			{ ...config, apiKey: "NV_KEY" },
			{ NV_KEY: "from-env" },
		);
		const resolve = provider.auth.apiKey?.resolve;
		expect(await resolve?.({ ctx, signal })).toEqual({
			auth: {
				apiKey: "from-env",
				headers: { Authorization: "Bearer from-env" },
			},
			source: "action inputs",
		});
		expect(
			await resolve?.({
				ctx,
				signal,
				credential: { type: "api_key", key: "stored" },
			}),
		).toMatchObject({ auth: { apiKey: "stored" } });
		const unset = createCustomProvider(
			"nvidia",
			"gpt",
			false,
			{ ...config, apiKey: "NV_KEY" },
			{},
		);
		expect(await unset.auth.apiKey?.resolve({ ctx, signal })).toBeUndefined();
	});

	it("omits the header unless provider_auth_header is set", async () => {
		const provider = createCustomProvider(
			"p",
			"m",
			false,
			{ ...config, authHeader: false, apiKey: "lit-key" },
			{},
		);
		expect(await provider.auth.apiKey?.resolve({ ctx, signal })).toEqual({
			auth: { apiKey: "lit-key" },
			source: "action inputs",
		});
	});

	it("requires a key and a supported API", () => {
		expect(() => createCustomProvider("p", "m", false, config)).toThrow(
			"api_key or provider_api_key is required when provider_base_url is set",
		);
		expect(() =>
			createCustomProvider("p", "m", true, {
				...config,
				api: "google-generative-ai",
			}),
		).toThrow(UNSUPPORTED_API);
	});
});
