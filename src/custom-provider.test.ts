import { describe, expect, it } from "vitest";

import { createCustomProvider, resolveApiKey } from "./custom-provider.ts";

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
		env: async () => undefined,
		fileExists: async () => false,
	};
	const { signal } = new AbortController();

	it("describes one model with the configured API and limits", () => {
		const provider = createCustomProvider("nvidia", "gpt", true, config);
		expect(provider.getModels()).toStrictEqual([
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
		await expect(resolve?.({ ctx, signal })).resolves.toStrictEqual({
			auth: {
				apiKey: "from-env",
				headers: { Authorization: "Bearer from-env" },
			},
			source: "action inputs",
		});
		await expect(
			resolve?.({
				ctx,
				signal,
				credential: { type: "api_key", key: "stored" },
			}),
		).resolves.toMatchObject({ auth: { apiKey: "stored" } });
		const unset = createCustomProvider(
			"nvidia",
			"gpt",
			false,
			{ ...config, apiKey: "NV_KEY" },
			{},
		);
		await expect(
			unset.auth.apiKey?.resolve({ ctx, signal }),
		).resolves.toBeUndefined();
	});

	it("omits the header unless provider_auth_header is set", async () => {
		const provider = createCustomProvider(
			"p",
			"m",
			false,
			{ ...config, authHeader: false, apiKey: "lit-key" },
			{},
		);
		await expect(
			provider.auth.apiKey?.resolve({ ctx, signal }),
		).resolves.toStrictEqual({
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
