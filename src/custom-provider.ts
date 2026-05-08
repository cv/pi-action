import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { DEFAULTS } from "./defaults.js";
import {
	getInputOrDefault,
	type InputReader,
	parseBooleanInput,
	parseModelInputModes,
	parseOptionalBooleanInput,
	parsePositiveIntegerInput,
} from "./inputs.js";
import type {
	CustomProviderCompatConfig,
	CustomProviderConfig,
} from "./types.js";
import { getErrorMessage } from "./utils.js";

function createCompatConfig(
	readInput: InputReader,
): CustomProviderCompatConfig | undefined {
	const supportsDeveloperRole = parseOptionalBooleanInput(
		readInput("compat_supports_developer_role"),
	);
	const supportsReasoningEffort = parseOptionalBooleanInput(
		readInput("compat_supports_reasoning_effort"),
	);
	const compat: CustomProviderCompatConfig = {
		...(supportsDeveloperRole === undefined ? {} : { supportsDeveloperRole }),
		...(supportsReasoningEffort === undefined
			? {}
			: { supportsReasoningEffort }),
	};
	return Object.keys(compat).length > 0 ? compat : undefined;
}

export function registerCustomProvider(
	modelRegistry: ModelRegistry,
	provider: string,
	model: string,
	apiKey: string | undefined,
	customProvider: CustomProviderConfig | undefined,
): string | undefined {
	if (!customProvider) {
		return;
	}

	const providerApiKey = customProvider.apiKey ?? (apiKey ? provider : "");
	if (!providerApiKey) {
		return "api_key or provider_api_key is required when provider_base_url is set";
	}

	try {
		modelRegistry.registerProvider(provider, {
			baseUrl: customProvider.baseUrl,
			api: customProvider.api,
			apiKey: providerApiKey,
			authHeader: customProvider.authHeader,
			models: [
				{
					id: model,
					name: customProvider.modelName ?? model,
					reasoning: customProvider.reasoning,
					input: customProvider.input,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: customProvider.contextWindow,
					maxTokens: customProvider.maxTokens,
					...(customProvider.compat ? { compat: customProvider.compat } : {}),
				},
			],
		});
	} catch (error) {
		return getErrorMessage(error);
	}
	return;
}

export function readCustomProviderConfig(
	readInput: InputReader,
): CustomProviderConfig | undefined {
	const baseUrl = readInput("provider_base_url").trim();
	if (!baseUrl) {
		return;
	}

	const apiKey = readInput("provider_api_key").trim();
	const modelName = readInput("model_name").trim();
	const compat = createCompatConfig(readInput);

	return {
		baseUrl,
		api: getInputOrDefault(
			readInput,
			"provider_api",
			DEFAULTS.customProviderApi,
		),
		...(apiKey ? { apiKey } : {}),
		authHeader: parseBooleanInput(
			readInput("provider_auth_header"),
			DEFAULTS.customProviderAuthHeader,
		),
		...(modelName ? { modelName } : {}),
		reasoning: parseBooleanInput(
			readInput("model_reasoning"),
			DEFAULTS.customModelReasoning,
		),
		input: parseModelInputModes(readInput("model_input"), ["text"]),
		contextWindow: parsePositiveIntegerInput(
			readInput("model_context_window"),
			DEFAULTS.customModelContextWindow,
		),
		maxTokens: parsePositiveIntegerInput(
			readInput("model_max_tokens"),
			DEFAULTS.customModelMaxTokens,
		),
		...(compat ? { compat } : {}),
	};
}
