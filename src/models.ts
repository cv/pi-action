import {
	type Api,
	InMemoryCredentialStore,
	type Model,
} from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createCustomProvider } from "./custom-provider.ts";
import type { CustomProviderConfig } from "./types.ts";

export interface ModelSetupOptions {
	provider: string;
	model: string;
	/** The api_key input: the provider's key, kept in memory for this run only. */
	apiKey?: string | undefined;
	customProvider?: CustomProviderConfig | undefined;
	env?: Record<string, string | undefined>;
}

/**
 * Every built-in provider (keys from api_key or the usual environment variables) plus the custom provider, if
 * provider_base_url is set. Nothing is read from or written to ~/.pi.
 */
export async function createActionModels(
	options: ModelSetupOptions,
): Promise<MutableModels> {
	const credentials = new InMemoryCredentialStore();
	const { apiKey } = options;
	if (apiKey) {
		await credentials.modify(options.provider, () =>
			Promise.resolve({ type: "api_key", key: apiKey }),
		);
	}
	const models = builtinModels({ credentials });
	if (options.customProvider) {
		models.setProvider(
			createCustomProvider(
				options.provider,
				options.model,
				Boolean(apiKey),
				options.customProvider,
				options.env,
			),
		);
	}
	return models;
}

export function findModel(
	models: Pick<MutableModels, "getModel" | "getModels">,
	provider: string,
	modelId: string,
): Model<Api> {
	const model = models.getModel(provider, modelId);
	if (!model) {
		const known = models
			.getModels(provider)
			.map((m) => m.id)
			.slice(0, 20);
		const hint =
			known.length > 0
				? ` (known: ${known.join(", ")})`
				: " (unknown provider)";
		throw new Error(`Model not found: ${provider}/${modelId}${hint}`);
	}
	return model;
}
