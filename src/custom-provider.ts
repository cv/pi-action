import type { Model } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createProvider, type Provider } from "@earendil-works/pi-ai/models";

export type ModelInputMode = "text" | "image";

/** A single custom provider/model, from the flat provider_* and model_* inputs. */
export interface CustomProviderConfig {
	baseUrl: string;
	api: string;
	apiKey?: string;
	authHeader: boolean;
	modelName?: string;
	reasoning: boolean;
	input: ModelInputMode[];
	contextWindow: number;
	maxTokens: number;
	compat?: {
		supportsDeveloperRole?: boolean;
		supportsReasoningEffort?: boolean;
		forceAdaptiveThinking?: boolean;
	};
}

/** The model APIs a custom provider may use. */
const CUSTOM_APIS = {
	"anthropic-messages": anthropicMessagesApi,
	"openai-completions": openAICompletionsApi,
	"openai-responses": openAIResponsesApi,
} as const;
type CustomApi = keyof typeof CUSTOM_APIS;

const ENV_VAR_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/u;

function isCustomApi(api: string): api is CustomApi {
	return Object.hasOwn(CUSTOM_APIS, api);
}

/** provider_api_key: an environment variable name, or the key itself. */
export function resolveApiKey(
	value: string | undefined,
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	if (!value) {
		return undefined;
	}
	return ENV_VAR_NAME_PATTERN.test(value) ? env[value] : value;
}

/**
 * The provider for a single custom model (provider_base_url and friends). Its key is the api_key input
 * (stored as the provider's credential) or provider_api_key, resolved at request time.
 */
export function createCustomProvider(
	provider: string,
	model: string,
	hasApiKey: boolean,
	config: CustomProviderConfig,
	env: Record<string, string | undefined> = process.env,
): Provider {
	if (!(config.apiKey || hasApiKey)) {
		throw new Error(
			"api_key or provider_api_key is required when provider_base_url is set",
		);
	}
	const { api } = config;
	if (!isCustomApi(api)) {
		throw new Error(
			`Unsupported provider_api "${api}" (supported: ${Object.keys(CUSTOM_APIS).join(", ")})`,
		);
	}
	const customModel = {
		id: model,
		name: config.modelName ?? model,
		api,
		provider,
		baseUrl: config.baseUrl,
		reasoning: config.reasoning,
		input: config.input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: config.contextWindow,
		maxTokens: config.maxTokens,
		...(config.compat ? { compat: config.compat } : {}),
	} as Model<CustomApi>;
	return createProvider<CustomApi>({
		id: provider,
		baseUrl: config.baseUrl,
		auth: {
			apiKey: {
				name: `${provider} API key`,
				resolve: async ({ credential }) => {
					const apiKey = credential?.key ?? resolveApiKey(config.apiKey, env);
					if (!apiKey) {
						return undefined;
					}
					const headers = { Authorization: `Bearer ${apiKey}` };
					return {
						auth: { apiKey, ...(config.authHeader ? { headers } : {}) },
						source: "action inputs",
					};
				},
			},
		},
		models: [customModel],
		api: { [api]: CUSTOM_APIS[api]() },
	});
}
