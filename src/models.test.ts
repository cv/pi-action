import { describe, expect, it } from "vitest";

import { createActionModels, findModel } from "./models.ts";
import type { CustomProviderConfig } from "./types.ts";

const KNOWN_MODELS = /known: /u;
const UNKNOWN_PROVIDER = /unknown provider/u;

const NVIDIA: CustomProviderConfig = {
	baseUrl: "https://inference.example.com",
	api: "openai-responses",
	authHeader: false,
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 1_050_000,
	maxTokens: 16_384,
};

describe("createActionModels / findModel", () => {
	it("has the built-in catalog", async () => {
		const models = await createActionModels({
			provider: "anthropic",
			model: "claude-sonnet-5-5",
		});
		expect(findModel(models, "anthropic", "claude-sonnet-5-5").provider).toBe(
			"anthropic",
		);
		expect(() => findModel(models, "anthropic", "claude-nope")).toThrow(
			KNOWN_MODELS,
		);
		expect(() => findModel(models, "nobody", "x")).toThrow(UNKNOWN_PROVIDER);
	});

	it("keeps api_key in memory as the provider's credential", async () => {
		const models = await createActionModels({
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			apiKey: "sk-ant-test",
		});
		const auth = await models.getAuth("anthropic");
		expect(auth?.auth.apiKey).toBe("sk-ant-test");
	});

	it("adds the custom provider, keyed by api_key", async () => {
		const models = await createActionModels({
			provider: "nvidia",
			model: "openai/openai/gpt-5.5",
			apiKey: "nv-key",
			customProvider: NVIDIA,
		});
		const model = findModel(models, "nvidia", "openai/openai/gpt-5.5");
		expect(model).toMatchObject({
			api: "openai-responses",
			baseUrl: "https://inference.example.com",
			contextWindow: 1_050_000,
		});
		expect((await models.getAuth(model))?.auth.apiKey).toBe("nv-key");
	});
});
