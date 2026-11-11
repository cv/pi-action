import type {
	Api,
	Context,
	Model,
	SimpleStreamOptions,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";

import {
	composeExtensionProvider,
	type ExtensionProviderConfig,
	parseProviderConfig,
	resolveConfigValue,
} from "./extension-provider.ts";
import type { ExtensionProvider } from "./extensions.ts";
import { createActionModels, findModel } from "./models.ts";
import { createActionInputs, createLogger } from "./test-helpers.ts";

const MUST_BE = /must be|must map|must list|needs numeric|needs a string/u;
const NEEDS_API = /"api" is required with streamSimple/u;
const NEEDS_MODELS = /"models" is required unless it overrides/u;
const NO_API = /no "api"/u;
const NO_BASE_URL = /no "baseUrl"/u;
const UNSET_HEADER = /header X-Team references an unset environment variable/u;

/** Builds `${NAME}` references without tripping the "curly braces in a string" lint. */
const DOLLAR = "$";

const context = (text: string): Context => ({
	messages: [{ role: "user", content: text, timestamp: Date.now() }],
});

const legacy = (
	id: string,
	config: Record<string, unknown>,
): ExtensionProvider => ({
	id,
	source: "test.ts",
	kind: "config",
	config: parseProviderConfig(id, config),
});

const MODEL = {
	id: "acme-1",
	name: "Acme One",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 64_000,
	maxTokens: 4096,
	compat: { supportsDeveloperRole: false },
};

describe("resolveConfigValue", () => {
	it("reads literals, environment references, escapes, and commands", () => {
		const env = { KEY: "k1", OTHER: "o2", EMPTY: "" };
		expect(resolveConfigValue("plain-key", env)).toBe("plain-key");
		expect(resolveConfigValue("$KEY", env)).toBe("k1");
		expect(resolveConfigValue(`Bearer ${DOLLAR}{KEY}-$OTHER`, env)).toBe(
			"Bearer k1-o2",
		);
		expect(resolveConfigValue("cost$$5 and $!bang", env)).toBe(
			"cost$5 and !bang",
		);
		expect(resolveConfigValue(`${DOLLAR}{not valid} $`, env)).toBe(
			`${DOLLAR}{not valid} $`,
		);
		expect(resolveConfigValue("$MISSING", env)).toBeUndefined();
		expect(resolveConfigValue("$EMPTY", env)).toBeUndefined();
		expect(resolveConfigValue("!echo from-command", env)).toBe("from-command");
		expect(resolveConfigValue("!exit 3", env)).toBeUndefined();
	});
});

describe("parseProviderConfig", () => {
	it("keeps what pi-action uses and lists what it ignores", () => {
		const config = parseProviderConfig("acme", {
			baseUrl: "https://acme.invalid/v1",
			api: "openai-completions",
			apiKey: "$ACME_KEY",
			authHeader: true,
			headers: { "X-Team": "ci" },
			models: [MODEL, { id: "acme-image", type: "image", output: ["image"] }],
			oauth: { name: "Acme SSO" },
			images: {},
		});
		expect(config.models?.map((m) => m.id)).toStrictEqual(["acme-1"]);
		expect(config.ignored).toStrictEqual(["oauth", "images"]);
		expect(config.authHeader).toBe(true);
	});

	it.each([
		["a non-object config", "nope"],
		["a non-string name", { name: 1 }],
		["a non-boolean authHeader", { authHeader: "yes" }],
		["non-string headers", { headers: { A: 1 } }],
		["models that are not a list", { models: {} }],
		["a model without an id", { models: [{ name: "x" }] }],
		["a bad input mode", { models: [{ id: "m", input: ["audio"] }] }],
		["an incomplete cost", { models: [{ id: "m", cost: { input: 1 } }] }],
		["a negative context window", { models: [{ id: "m", contextWindow: -1 }] }],
		["a non-boolean reasoning flag", { models: [{ id: "m", reasoning: 1 }] }],
		["a streamSimple that is not a function", { api: "x", streamSimple: 1 }],
	])("rejects %s", (_name, config) => {
		expect(() => parseProviderConfig("acme", config)).toThrow(MUST_BE);
	});

	it("requires an api for streamSimple", () => {
		expect(() =>
			parseProviderConfig("acme", { streamSimple: () => undefined }),
		).toThrow(NEEDS_API);
	});
});

describe("composeExtensionProvider", () => {
	it("builds models with pi's defaults and the provider's api and baseUrl", () => {
		const provider = composeExtensionProvider(
			"acme",
			undefined,
			parseProviderConfig("acme", {
				baseUrl: "https://acme.invalid/v1",
				api: "openai-completions",
				models: [
					MODEL,
					{ id: "small", headers: { "X-Model": "$MODEL_TAG" } },
					{
						id: "other",
						api: "anthropic-messages",
						baseUrl: "https://b.invalid",
					},
				],
			}),
			{ MODEL_TAG: "tag" },
		);
		const [full, small, other] = provider.getModels();
		expect(full).toMatchObject({
			...MODEL,
			provider: "acme",
			api: "openai-completions",
		});
		expect(small).toStrictEqual({
			id: "small",
			name: "small",
			api: "openai-completions",
			provider: "acme",
			baseUrl: "https://acme.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
			headers: { "X-Model": "tag" },
		});
		expect(other).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://b.invalid",
		});
		expect(provider.refreshModels).toBeUndefined();
	});

	it("needs models, an api, and a baseUrl for a new provider", () => {
		const compose = (config: Record<string, unknown>) =>
			composeExtensionProvider(
				"acme",
				undefined,
				parseProviderConfig("acme", config),
				{},
			);
		expect(() => compose({ baseUrl: "https://a.invalid" })).toThrow(
			NEEDS_MODELS,
		);
		expect(() =>
			compose({ baseUrl: "https://a.invalid", models: [{ id: "m" }] }),
		).toThrow(NO_API);
		expect(() =>
			compose({ api: "openai-completions", models: [{ id: "m" }] }),
		).toThrow(NO_BASE_URL);
	});

	it("resolves the key from the api_key input, else apiKey, with headers", async () => {
		const config = {
			baseUrl: "https://acme.invalid/v1",
			api: "openai-completions",
			apiKey: "$ACME_KEY",
			authHeader: true,
			headers: { "X-Team": "$TEAM" },
			models: [MODEL],
		};
		const env = { ACME_KEY: "from-env", TEAM: "ci" };
		const fromEnv = await createActionModels(
			createActionInputs({ provider: "acme", model: "acme-1" }),
			{ providers: [legacy("acme", config)], env, log: createLogger() },
		);
		await expect(fromEnv.getAuth("acme")).resolves.toStrictEqual({
			auth: {
				apiKey: "from-env",
				headers: { "X-Team": "ci", Authorization: "Bearer from-env" },
			},
			source: "extension",
		});
		const fromInput = await createActionModels(
			createActionInputs({
				provider: "acme",
				model: "acme-1",
				apiKey: "from-input",
			}),
			{ providers: [legacy("acme", config)], env, log: createLogger() },
		);
		expect((await fromInput.getAuth("acme"))?.auth.apiKey).toBe("from-input");
		const unset = await createActionModels(
			createActionInputs({ provider: "acme", model: "acme-1" }),
			{ providers: [legacy("acme", config)], env: {}, log: createLogger() },
		);
		await expect(unset.getAuth("acme")).resolves.toBeUndefined();
		const noHeaderEnv = await createActionModels(
			createActionInputs({ provider: "acme", model: "acme-1", apiKey: "k" }),
			{ providers: [legacy("acme", config)], env: {}, log: createLogger() },
		);
		await expect(noHeaderEnv.getAuth("acme")).rejects.toThrow(UNSET_HEADER);
	});

	it("overrides a built-in provider's endpoint and keeps its models and auth", async () => {
		const models = await createActionModels(
			createActionInputs({
				provider: "anthropic",
				model: "claude-sonnet-5-5",
				apiKey: "sk-ant",
			}),
			{
				providers: [
					legacy("anthropic", {
						baseUrl: "https://gateway.invalid/anthropic",
						headers: { "X-Gateway": "$GW" },
					}),
				],
				env: { GW: "gw-key" },
				log: createLogger(),
			},
		);
		const model = findModel(models, "anthropic", "claude-sonnet-5-5");
		expect(model.baseUrl).toBe("https://gateway.invalid/anthropic");
		const auth = await models.getAuth("anthropic");
		expect(auth?.auth.apiKey).toBe("sk-ant");
		expect(auth?.auth.headers).toMatchObject({ "X-Gateway": "gw-key" });
	});

	it("streams through the extension, the overridden provider, or pi-ai's api", async () => {
		const faux = fauxProvider({ provider: "base", api: "faux-api" });
		const streamSimple = vi.fn(
			(
				model: Model<Api>,
				ctx: TranscriptContext,
				options?: SimpleStreamOptions,
			) => {
				faux.appendResponses([fauxAssistantMessage("from the extension")]);
				return faux.provider.streamSimple(model, ctx, options);
			},
		);
		const custom = composeExtensionProvider(
			"custom",
			undefined,
			parseProviderConfig("custom", {
				baseUrl: "https://c.invalid",
				apiKey: "k",
				api: "custom-api",
				streamSimple,
				models: [
					{ id: "c1" },
					{ id: "c2", api: "no-such-api" },
					{
						id: "c3",
						api: "openai-completions",
						baseUrl: "http://127.0.0.1:9/v1",
					},
				],
			}),
			{},
		);
		const overridden = composeExtensionProvider(
			"base",
			faux.provider,
			parseProviderConfig("base", { baseUrl: "https://moved.invalid" }),
			{},
		);
		const models = createModels();
		models.setProvider(custom);
		models.setProvider(overridden);
		const pick = (provider: string, id: string): Model<Api> =>
			findModel(models, provider, id);

		const viaExtension = await models.complete(
			pick("custom", "c1"),
			context("hi"),
		);
		expect(viaExtension.content).toStrictEqual([
			{ type: "text", text: "from the extension" },
		]);
		expect(streamSimple.mock.calls.map(([model]) => model.id)).toStrictEqual([
			"c1",
		]);

		const [baseModel] = overridden.getModels();
		const baseId = String(baseModel?.id);
		expect(baseModel?.baseUrl).toBe("https://moved.invalid");
		faux.setResponses([fauxAssistantMessage("from the base")]);
		const viaBase = await models.completeSimple(
			pick("base", baseId),
			context("hi"),
		);
		expect(viaBase.content).toStrictEqual([
			{ type: "text", text: "from the base" },
		]);
		faux.setResponses([fauxAssistantMessage("from the base again")]);
		const viaBaseStream = await models.complete(
			pick("base", baseId),
			context("hi"),
		);
		expect(viaBaseStream.content).toStrictEqual([
			{ type: "text", text: "from the base again" },
		]);

		const missing = await models.completeSimple(
			pick("custom", "c2"),
			context("hi"),
		);
		expect(missing.stopReason).toBe("error");
		expect(missing.errorMessage).toContain(
			'no implementation of api "no-such-api"',
		);

		const viaApi = await models.completeSimple(
			pick("custom", "c3"),
			context("hi"),
			{ maxRetries: 0 },
		);
		expect(viaApi.stopReason).toBe("error"); // pi-ai's openai-completions, refused by 127.0.0.1:9
		const viaApiStream = await models.complete(
			pick("custom", "c3"),
			context("hi"),
			{ maxRetries: 0 },
		);
		expect(viaApiStream.stopReason).toBe("error");
	});

	it("reports a streamSimple that returns no stream", async () => {
		const provider = composeExtensionProvider(
			"bad",
			undefined,
			parseProviderConfig("bad", {
				baseUrl: "https://b.invalid",
				apiKey: "k",
				api: "bad-api",
				streamSimple: () => "not a stream",
				models: [{ id: "b1" }],
			}),
			{},
		);
		const models = createModels();
		models.setProvider(provider);
		const result = await models.completeSimple(
			findModel(models, "bad", "b1"),
			context("hi"),
		);
		expect(result.errorMessage).toContain("streamSimple returned no stream");
	});

	it("lists dynamic models with refreshModels and warns when that fails", async () => {
		const log = createLogger();
		const refreshing: ExtensionProviderConfig = parseProviderConfig("live", {
			baseUrl: "http://live.invalid/v1",
			apiKey: "local",
			api: "openai-completions",
			refreshModels: async () => [{ id: "live-1" }, { id: "live-2" }],
		});
		const failing = parseProviderConfig("down", {
			baseUrl: "http://down.invalid/v1",
			apiKey: "local",
			api: "openai-completions",
			models: [{ id: "cached" }],
			refreshModels: async () => {
				throw new Error("connection refused");
			},
		});
		const models = await createActionModels(
			createActionInputs({ provider: "live", model: "live-1" }),
			{
				providers: [
					{ id: "live", source: "t", kind: "config", config: refreshing },
					{ id: "down", source: "t", kind: "config", config: failing },
				],
				env: {},
				log,
			},
		);
		expect(models.getModels("live").map((m) => m.id)).toStrictEqual([
			"live-1",
			"live-2",
		]);
		expect(models.getModels("down").map((m) => m.id)).toStrictEqual(["cached"]);
		expect(log.warning).toHaveBeenCalledWith(
			"Could not list the models of provider down: connection refused",
		);
	});

	it("takes a complete pi-ai Provider as it is", async () => {
		const faux = fauxProvider({ provider: "native", models: [{ id: "n1" }] });
		const models = await createActionModels(
			createActionInputs({ provider: "native", model: "n1" }),
			{
				providers: [
					{
						id: "native",
						source: "t",
						kind: "provider",
						provider: faux.provider,
					},
				],
				env: {},
				log: createLogger(),
			},
		);
		expect(findModel(models, "native", "n1").provider).toBe("native");
	});
});
