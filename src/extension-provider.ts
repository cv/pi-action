import { spawnSync } from "node:child_process";

import {
	type Api,
	type ApiKeyAuth,
	type ApiStreamOptions,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type AuthResult,
	lazyStream,
	type Model,
	type ModelAuth,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import type {
	Provider,
	RefreshModelsContext,
} from "@earendil-works/pi-ai/models";

import { isRecord } from "./utils.ts";

type Env = Record<string, string | undefined>;
type StreamSimple = (
	model: Model<Api>,
	context: TranscriptContext,
	options?: unknown,
) => unknown;
type RefreshModels = (context: RefreshModelsContext) => unknown;

/** A chat model as an extension declares it (pi's `ProviderModelConfig`); omitted fields get pi's defaults. */
interface ModelDefinition {
	id: string;
	name?: string | undefined;
	api?: string | undefined;
	baseUrl?: string | undefined;
	reasoning?: boolean | undefined;
	input?: ("text" | "image")[] | undefined;
	cost?: Model<Api>["cost"] | undefined;
	contextWindow?: number | undefined;
	maxTokens?: number | undefined;
	headers?: Record<string, string> | undefined;
	/** Metadata passed through unchanged: compat, thinkingLevelMap, promptCache, ... */
	extra: Record<string, unknown>;
}

/** pi's legacy `pi.registerProvider(name, config)` form, checked field by field. */
export interface ExtensionProviderConfig {
	name?: string | undefined;
	baseUrl?: string | undefined;
	apiKey?: string | undefined;
	api?: string | undefined;
	headers?: Record<string, string> | undefined;
	authHeader?: boolean | undefined;
	models?: ModelDefinition[] | undefined;
	streamSimple?: StreamSimple | undefined;
	refreshModels?: RefreshModels | undefined;
	/** Fields pi-action cannot use on a runner (oauth, images, classifiers). */
	ignored: string[];
}

const PASSTHROUGH_MODEL_FIELDS = [
	"compat",
	"thinkingLevelMap",
	"promptCache",
	"inputLimits",
	"samplingParams",
	"samplingParamsByThinkingLevel",
] as const;
const IGNORED_CONFIG_FIELDS = ["oauth", "images", "classifiers"] as const;
const CONFIG_VALUE_REFERENCE =
	/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*)|([$!]))/gu;
const COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

function optionalBoolean(
	where: string,
	record: Record<string, unknown>,
	key: string,
): boolean | undefined {
	const value = record[key];
	if (value !== undefined && typeof value !== "boolean") {
		throw new Error(`${where}: "${key}" must be a boolean`);
	}
	return value;
}

function optionalString(
	where: string,
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new TypeError(`${where}: "${key}" must be a string`);
	}
	return value;
}

function optionalNumber(
	where: string,
	record: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || !(value > 0)) {
		throw new Error(`${where}: "${key}" must be a positive number`);
	}
	return value;
}

function optionalStringRecord(
	where: string,
	record: Record<string, unknown>,
	key: string,
): Record<string, string> | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}
	if (
		!(
			isRecord(value) &&
			Object.values(value).every((v) => typeof v === "string")
		)
	) {
		throw new Error(`${where}: "${key}" must map names to strings`);
	}
	return Object.fromEntries(
		Object.entries(value).flatMap(([k, v]) =>
			typeof v === "string" ? [[k, v]] : [],
		),
	);
}

function optionalFunction(
	where: string,
	record: Record<string, unknown>,
	key: string,
): ((...args: unknown[]) => unknown) | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "function") {
		throw new TypeError(`${where}: "${key}" must be a function`);
	}
	return (...args: unknown[]): unknown => Reflect.apply(value, record, args);
}

function parseCost(
	where: string,
	value: unknown,
): Model<Api>["cost"] | undefined {
	if (value === undefined) {
		return undefined;
	}
	const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;
	if (!(isRecord(value) && fields.every((f) => typeof value[f] === "number"))) {
		throw new Error(
			`${where}: "cost" needs numeric input, output, cacheRead and cacheWrite`,
		);
	}
	const [input = 0, output = 0, cacheRead = 0, cacheWrite = 0] = fields.map(
		(f) => Number(value[f]),
	);
	const cost: Model<Api>["cost"] = { input, output, cacheRead, cacheWrite };
	return Object.assign(cost, value);
}

function parseInput(
	where: string,
	value: unknown,
): ("text" | "image")[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	const modes: readonly unknown[] = Array.isArray(value) ? value : [value];
	const parsed = modes.filter(
		(mode): mode is "text" | "image" => mode === "text" || mode === "image",
	);
	if (!Array.isArray(value) || parsed.length !== modes.length) {
		throw new Error(`${where}: "input" must list "text" and/or "image"`);
	}
	return parsed;
}

function parseModelDefinition(
	provider: string,
	value: unknown,
): ModelDefinition | undefined {
	const id: unknown = isRecord(value) ? value["id"] : undefined;
	if (!isRecord(value) || typeof id !== "string" || id === "") {
		throw new Error(`Provider ${provider}: every model needs a string "id"`);
	}
	const where = `Provider ${provider}, model ${id}`;
	if (value["type"] !== undefined && value["type"] !== "chat") {
		return undefined; // image and classifier models: pi-action only chats
	}
	const extra = Object.fromEntries(
		PASSTHROUGH_MODEL_FIELDS.flatMap((key) =>
			isRecord(value[key]) ? [[key, value[key]]] : [],
		),
	);
	return {
		id,
		name: optionalString(where, value, "name"),
		api: optionalString(where, value, "api"),
		baseUrl: optionalString(where, value, "baseUrl"),
		reasoning: optionalBoolean(where, value, "reasoning"),
		input: parseInput(where, value["input"]),
		cost: parseCost(where, value["cost"]),
		contextWindow: optionalNumber(where, value, "contextWindow"),
		maxTokens: optionalNumber(where, value, "maxTokens"),
		headers: optionalStringRecord(where, value, "headers"),
		extra,
	};
}

function parseModelDefinitions(
	provider: string,
	value: unknown,
): ModelDefinition[] {
	if (!Array.isArray(value)) {
		throw new TypeError(`Provider ${provider}: "models" must be an array`);
	}
	return value.flatMap((entry) => {
		const model = parseModelDefinition(provider, entry);
		return model ? [model] : [];
	});
}

/** Checks the config an extension passed to `pi.registerProvider(name, config)`. */
export function parseProviderConfig(
	provider: string,
	value: unknown,
): ExtensionProviderConfig {
	const where = `Provider ${provider}`;
	if (!isRecord(value)) {
		throw new Error(`${where}: the config must be an object`);
	}
	const config: ExtensionProviderConfig = {
		name: optionalString(where, value, "name"),
		baseUrl: optionalString(where, value, "baseUrl"),
		apiKey: optionalString(where, value, "apiKey"),
		api: optionalString(where, value, "api"),
		headers: optionalStringRecord(where, value, "headers"),
		authHeader: optionalBoolean(where, value, "authHeader"),
		models:
			value["models"] === undefined
				? undefined
				: parseModelDefinitions(provider, value["models"]),
		streamSimple: optionalFunction(where, value, "streamSimple"),
		refreshModels: optionalFunction(where, value, "refreshModels"),
		ignored: IGNORED_CONFIG_FIELDS.filter((key) => value[key] !== undefined),
	};
	if (config.streamSimple && !config.api) {
		throw new Error(`${where}: "api" is required with streamSimple`);
	}
	return config;
}

function runCommand(command: string): string | undefined {
	const result = spawnSync("sh", ["-c", command], {
		encoding: "utf8",
		timeout: COMMAND_TIMEOUT_MS,
		stdio: ["ignore", "pipe", "ignore"],
	});
	const output = result.status === 0 ? result.stdout.trim() : "";
	return output || undefined;
}

/**
 * A config value as pi reads it: `!command` (its output), `$NAME` / `${NAME}` (environment variables; undefined
 * when one is unset), `$$` and `$!` for literal `$` and `!`, anything else literally.
 */
export function resolveConfigValue(
	value: string,
	env: Env,
): string | undefined {
	if (value.startsWith("!")) {
		return runCommand(value.slice(1));
	}
	const missing: string[] = [];
	const resolved = value.replaceAll(
		CONFIG_VALUE_REFERENCE,
		(_match, braced?: string, bare?: string, escaped?: string) => {
			if (escaped) {
				return escaped;
			}
			const name = braced ?? bare ?? "";
			const envValue = env[name];
			if (!envValue) {
				missing.push(name);
				return "";
			}
			return envValue;
		},
	);
	return missing.length > 0 ? undefined : resolved;
}

function resolveHeaders(
	provider: string,
	headers: Record<string, string> | undefined,
	env: Env,
): Record<string, string> | undefined {
	if (!headers) {
		return undefined;
	}
	return Object.fromEntries(
		Object.entries(headers).map(([name, raw]) => {
			const value = resolveConfigValue(raw, env);
			if (value === undefined) {
				throw new Error(
					`Provider ${provider}: header ${name} references an unset environment variable`,
				);
			}
			return [name, value];
		}),
	);
}

function toModel(
	provider: string,
	definition: ModelDefinition,
	config: ExtensionProviderConfig,
	env: Env,
): Model<Api> {
	const where = `Provider ${provider}, model ${definition.id}`;
	const api = definition.api ?? config.api;
	if (!api) {
		throw new Error(`${where}: no "api" (set it on the provider or the model)`);
	}
	const baseUrl = definition.baseUrl ?? config.baseUrl;
	if (!baseUrl) {
		throw new Error(`${where}: no "baseUrl"`);
	}
	const headers = resolveHeaders(provider, definition.headers, env);
	const model: Model<Api> = {
		id: definition.id,
		name: definition.name ?? definition.id,
		api,
		provider,
		baseUrl,
		reasoning: definition.reasoning ?? false,
		input: definition.input ?? ["text"],
		cost: definition.cost ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: definition.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: definition.maxTokens ?? DEFAULT_MAX_TOKENS,
		...(headers ? { headers } : {}),
	};
	return Object.assign(model, definition.extra);
}

function isEventStream(
	value: unknown,
): value is AsyncIterable<AssistantMessageEvent> {
	return (
		typeof value === "object" && value !== null && Symbol.asyncIterator in value
	);
}

function withConfiguredHeaders(
	provider: string,
	auth: ModelAuth,
	config: ExtensionProviderConfig,
	env: Env,
): ModelAuth {
	const headers = {
		...auth.headers,
		...resolveHeaders(provider, config.headers, env),
		...(config.authHeader === true && auth.apiKey
			? { Authorization: `Bearer ${auth.apiKey}` }
			: {}),
	};
	return Object.keys(headers).length > 0 ? { ...auth, headers } : auth;
}

/**
 * The provider's key: the api_key input (stored as the provider's credential), else the extension's `apiKey`,
 * else whatever the built-in provider it overrides would use.
 */
function apiKeyAuth(
	provider: string,
	base: Provider | undefined,
	config: ExtensionProviderConfig,
	env: Env,
): ApiKeyAuth {
	const inherited = base?.auth.apiKey;
	return {
		name: inherited?.name ?? `${provider} API key`,
		resolve: async (input) => {
			const stored = input.credential?.key;
			const key =
				stored ??
				(config.apiKey === undefined
					? undefined
					: resolveConfigValue(config.apiKey, env));
			let result: AuthResult | undefined;
			if (inherited) {
				result = await inherited.resolve(
					key === undefined
						? input
						: { ...input, credential: { type: "api_key", key } },
				);
			} else if (key !== undefined) {
				result = {
					auth: { apiKey: key },
					source: stored === undefined ? "extension" : "api_key input",
				};
			}
			return result
				? {
						...result,
						auth: withConfiguredHeaders(provider, result.auth, config, env),
					}
				: undefined;
		},
	};
}

/**
 * The pi-ai provider for a legacy `pi.registerProvider(name, config)` registration, following the coding agent's
 * composition: models replace the built-in provider's (or, without `models`, keep them with the new `baseUrl`);
 * requests go to the extension's `streamSimple` for its `api`, else the built-in provider, else pi-ai's
 * implementation of the model's `api`.
 */
export function composeExtensionProvider(
	id: string,
	base: Provider | undefined,
	config: ExtensionProviderConfig,
	env: Env,
): Provider {
	const fromDefinitions = (definitions: ModelDefinition[]) =>
		definitions.map((definition) => toModel(id, definition, config, env));
	const { streamSimple, refreshModels } = config;
	// A provider with refreshModels and no models starts empty, like pi's live llama.cpp example.
	let models: Model<Api>[] | undefined;
	if (config.models) {
		models = fromDefinitions(config.models);
	} else if (!base && refreshModels) {
		models = [];
	}
	if (!(models || base)) {
		throw new Error(
			`Provider ${id}: "models" is required unless it overrides a built-in provider`,
		);
	}
	const getModels = (): readonly Model<Api>[] => {
		if (models) {
			return models;
		}
		const builtin = base?.getModels() ?? [];
		const { baseUrl } = config;
		return baseUrl ? builtin.map((model) => ({ ...model, baseUrl })) : builtin;
	};
	const ownsApi = (model: Model<Api>) =>
		base?.getModels().some((entry) => entry.api === model.api) ?? false;
	type Implementation = NonNullable<ReturnType<typeof getApiProvider>>;
	/** The extension's streamSimple for its api, else the overridden provider, else pi-ai's api implementation. */
	const streamWith = (
		model: Model<Api>,
		context: TranscriptContext,
		options: unknown,
		viaBase: (provider: Provider) => AssistantMessageEventStream,
		viaApi: (implementation: Implementation) => AssistantMessageEventStream,
	): AssistantMessageEventStream =>
		lazyStream(model, async () => {
			if (streamSimple && model.api === config.api) {
				const stream = streamSimple(model, context, options);
				if (!isEventStream(stream)) {
					throw new Error(`Provider ${id}: streamSimple returned no stream`);
				}
				return stream;
			}
			if (base && ownsApi(model)) {
				return viaBase(base);
			}
			const implementation = getApiProvider(model.api);
			if (!implementation) {
				throw new Error(
					`Provider ${id}: no implementation of api "${model.api}"`,
				);
			}
			return viaApi(implementation);
		});
	const refresh =
		refreshModels || base?.refreshModels
			? async (context: RefreshModelsContext): Promise<void> => {
					await base?.refreshModels?.(context);
					if (!refreshModels) {
						return;
					}
					const listed: unknown = await refreshModels(context);
					const refreshed = fromDefinitions(parseModelDefinitions(id, listed));
					await context.publish({
						update: () => {
							models = refreshed;
						},
					});
				}
			: undefined;
	const oauth = base?.auth.oauth;
	const baseUrl = config.baseUrl ?? base?.baseUrl;
	return {
		id,
		name: config.name ?? base?.name ?? id,
		...(baseUrl ? { baseUrl } : {}),
		...(base?.headers ? { headers: base.headers } : {}),
		auth: {
			apiKey: apiKeyAuth(id, base, config, env),
			...(oauth ? { oauth } : {}),
		},
		getModels,
		...(refresh ? { refreshModels: refresh } : {}),
		stream: <T extends Api>(
			model: Model<T>,
			context: TranscriptContext,
			options?: ApiStreamOptions<T>,
		) =>
			streamWith(
				model,
				context,
				options,
				(provider) => provider.stream(model, context, options),
				(implementation) => implementation.stream(model, context, options),
			),
		streamSimple: (model, context, options) =>
			streamWith(
				model,
				context,
				options,
				(provider) => provider.streamSimple(model, context, options),
				(implementation) =>
					implementation.streamSimple(model, context, options),
			),
	};
}
