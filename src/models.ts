import { execSync } from "node:child_process";
import {
	type Api,
	type Credential,
	InMemoryCredentialStore,
	type Model,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
	type MutableModels,
	type Provider,
	createProvider,
} from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

/** The model APIs a models.json custom provider may use here. */
const CUSTOM_APIS = {
	"anthropic-messages": anthropicMessagesApi,
	"openai-completions": openAICompletionsApi,
	"openai-responses": openAIResponsesApi,
} as const;
type CustomApi = keyof typeof CUSTOM_APIS;

const isCustomApi = (api: unknown): api is CustomApi =>
	typeof api === "string" && api in CUSTOM_APIS;

interface CustomModelConfig {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: Model<Api>["cost"];
	headers?: Record<string, string>;
	[key: string]: unknown;
}

interface CustomProviderConfig {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	headers?: Record<string, string>;
	models?: CustomModelConfig[];
}

export interface ModelSetupOptions {
	/** Contents of pi's ~/.pi/agent/auth.json: { [providerId]: Credential }. */
	authJson?: string;
	/** Contents of pi's ~/.pi/agent/models.json: { providers: { [id]: CustomProviderConfig } }. */
	modelsJson?: string;
	env?: NodeJS.ProcessEnv;
	log?: (message: string) => void;
}

function parseJson(text: string, what: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`${what} is not valid JSON: ${(error as Error).message}`);
	}
}

/** Seed a credential store from auth.json; refreshed OAuth tokens live only for this run. */
export async function credentialsFromAuthJson(
	authJson: string | undefined,
): Promise<InMemoryCredentialStore> {
	const store = new InMemoryCredentialStore();
	if (!authJson?.trim()) {
		return store;
	}
	const parsed = parseJson(authJson, "pi_auth_json");
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("pi_auth_json must be an object of provider credentials");
	}
	for (const [providerId, credential] of Object.entries(parsed)) {
		const type = (credential as { type?: unknown })?.type;
		if (type === "api_key" || type === "oauth") {
			await store.modify(providerId, async () => credential as Credential);
		}
	}
	return store;
}

/** models.json apiKey: "!command", an environment variable name, or the key itself. */
export function resolveApiKey(
	value: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (!value) {
		return undefined;
	}
	if (value.startsWith("!")) {
		return execSync(value.slice(1), { encoding: "utf8" }).trim() || undefined;
	}
	if (/^[A-Z][A-Z0-9_]*$/.test(value)) {
		return env[value];
	}
	return value;
}

type Log = ModelSetupOptions["log"];

function customModel(
	providerId: string,
	config: CustomProviderConfig,
	model: CustomModelConfig,
	log: Log,
): Model<CustomApi> | undefined {
	const api = model.api ?? config.api;
	const baseUrl = model.baseUrl ?? config.baseUrl;
	if (!(isCustomApi(api) && baseUrl)) {
		log?.(
			`models_json: skipping ${providerId}/${model.id} (api ${api ?? "unset"})`,
		);
		return undefined;
	}
	return {
		...model,
		id: model.id,
		name: model.name ?? model.id,
		api,
		provider: providerId,
		baseUrl,
		input: model.input ?? ["text"],
		reasoning: model.reasoning ?? false,
		cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow ?? 200_000,
		maxTokens: model.maxTokens ?? 16_384,
	} as Model<CustomApi>;
}

function customProvider(
	id: string,
	config: CustomProviderConfig,
	models: Model<CustomApi>[],
	env: NodeJS.ProcessEnv | undefined,
): Provider {
	const apis = [...new Set(models.map((m) => m.api))];
	return createProvider<CustomApi>({
		id,
		baseUrl: config.baseUrl,
		headers: config.headers,
		auth: {
			apiKey: {
				name: `${id} API key`,
				resolve: ({ credential }) => {
					const apiKey = credential?.key ?? resolveApiKey(config.apiKey, env);
					return Promise.resolve(
						apiKey ? { auth: { apiKey }, source: "models_json" } : undefined,
					);
				},
			},
		},
		models,
		api: Object.fromEntries(apis.map((api) => [api, CUSTOM_APIS[api]()])),
	}) as Provider;
}

/** Build providers for models.json's custom providers (the APIs in CUSTOM_APIS; others are skipped). */
export function customProviders(
	modelsJson: string | undefined,
	options: Pick<ModelSetupOptions, "env" | "log"> = {},
): Provider[] {
	if (!modelsJson?.trim()) {
		return [];
	}
	const parsed = parseJson(modelsJson, "models_json") as {
		providers?: Record<string, CustomProviderConfig>;
	};
	const providers: Provider[] = [];
	for (const [id, config] of Object.entries(parsed?.providers ?? {})) {
		const models = (config.models ?? []).flatMap(
			(model) => customModel(id, config, model, options.log) ?? [],
		);
		if (models.length > 0) {
			providers.push(customProvider(id, config, models, options.env));
		}
	}
	return providers;
}

/** Every built-in provider plus models.json's, with auth.json credentials. */
export async function createActionModels(
	options: ModelSetupOptions = {},
): Promise<MutableModels> {
	const models = builtinModels({
		credentials: await credentialsFromAuthJson(options.authJson),
	});
	for (const provider of customProviders(options.modelsJson, options)) {
		models.setProvider(provider);
	}
	return models;
}

export function findModel(
	models: MutableModels,
	provider: string,
	modelId: string,
): Model<Api> {
	const model = models.getModel(provider, modelId);
	if (!model) {
		const known = models
			.getModels(provider)
			.map((m) => m.id)
			.slice(0, 20);
		throw new Error(
			`Model not found: ${provider}/${modelId}${known.length > 0 ? ` (known: ${known.join(", ")})` : " (unknown provider)"}`,
		);
	}
	return model;
}
