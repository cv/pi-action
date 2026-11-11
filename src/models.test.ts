import { describe, expect, it } from "vitest";
import {
	createActionModels,
	credentialsFromAuthJson,
	customProviders,
	findModel,
	resolveApiKey,
} from "./models.js";

const MODELS_JSON = JSON.stringify({
	providers: {
		"inference.nvidia": {
			baseUrl: "https://inference.example.com",
			api: "openai-responses",
			apiKey: "NVIDIA_KEY",
			models: [
				{
					id: "aws/anthropic/opus",
					name: "Opus",
					api: "anthropic-messages",
					contextWindow: 1_000_000,
				},
				{ id: "plain-responses" },
				{ id: "unsupported", api: "google-generative-ai" },
			],
		},
		empty: { baseUrl: "https://x", models: [] },
	},
});

describe("credentialsFromAuthJson", () => {
	it("seeds api_key and oauth credentials and skips unknown entries", async () => {
		const store = await credentialsFromAuthJson(
			JSON.stringify({
				openrouter: { type: "api_key", key: "sk-1" },
				anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 },
				junk: { hello: true },
			}),
		);
		expect(await store.read("openrouter")).toEqual({
			type: "api_key",
			key: "sk-1",
		});
		expect((await store.read("anthropic"))?.type).toBe("oauth");
		expect(await store.read("junk")).toBeUndefined();
	});

	it("accepts nothing and rejects malformed input", async () => {
		expect(await (await credentialsFromAuthJson(undefined)).list()).toEqual([]);
		await expect(credentialsFromAuthJson("{nope")).rejects.toThrow(
			/pi_auth_json is not valid JSON/,
		);
		await expect(credentialsFromAuthJson("[]")).rejects.toThrow(
			/must be an object/,
		);
	});
});

describe("resolveApiKey", () => {
	it("reads env var names, runs !commands, and passes literals through", () => {
		expect(resolveApiKey("MY_KEY", { MY_KEY: "from-env" })).toBe("from-env");
		expect(resolveApiKey("MISSING_KEY", {})).toBeUndefined();
		expect(resolveApiKey("!echo from-command")).toBe("from-command");
		expect(resolveApiKey("sk-literal-123")).toBe("sk-literal-123");
		expect(resolveApiKey(undefined)).toBeUndefined();
	});
});

describe("customProviders", () => {
	it("builds providers for supported APIs and logs the rest", () => {
		const logged: string[] = [];
		const providers = customProviders(MODELS_JSON, {
			log: (m) => logged.push(m),
		});
		expect(providers.map((p) => p.id)).toEqual(["inference.nvidia"]);
		const models = providers[0].getModels();
		expect(models.map((m) => [m.id, m.api, m.baseUrl])).toEqual([
			[
				"aws/anthropic/opus",
				"anthropic-messages",
				"https://inference.example.com",
			],
			["plain-responses", "openai-responses", "https://inference.example.com"],
		]);
		expect(models[0].contextWindow).toBe(1_000_000);
		expect(logged).toEqual([
			"models_json: skipping inference.nvidia/unsupported (api google-generative-ai)",
		]);
		expect(customProviders(undefined)).toEqual([]);
		expect(() => customProviders("nope")).toThrow(
			/models_json is not valid JSON/,
		);
	});

	it("resolves the key from the environment at request time", async () => {
		const [provider] = customProviders(MODELS_JSON, {
			env: { NVIDIA_KEY: "nv-1" },
		});
		const resolve = provider.auth.apiKey?.resolve;
		const signal = new AbortController().signal;
		const ctx = { env: async () => undefined, fileExists: async () => false };
		expect(await resolve?.({ ctx, signal })).toMatchObject({
			auth: { apiKey: "nv-1" },
		});
		expect(
			await resolve?.({
				ctx,
				signal,
				credential: { type: "api_key", key: "stored" },
			}),
		).toMatchObject({
			auth: { apiKey: "stored" },
		});
		const [unset] = customProviders(MODELS_JSON, { env: {} });
		expect(await unset.auth.apiKey?.resolve({ ctx, signal })).toBeUndefined();
	});
});

describe("createActionModels / findModel", () => {
	it("has the built-in catalog plus custom providers", async () => {
		const models = await createActionModels({ modelsJson: MODELS_JSON });
		expect(findModel(models, "anthropic", "claude-sonnet-5-5").provider).toBe(
			"anthropic",
		);
		expect(
			findModel(models, "inference.nvidia", "aws/anthropic/opus").api,
		).toBe("anthropic-messages");
		expect(() => findModel(models, "anthropic", "claude-nope")).toThrow(
			/known: /,
		);
		expect(() => findModel(models, "nobody", "x")).toThrow(/unknown provider/);
	});
});
