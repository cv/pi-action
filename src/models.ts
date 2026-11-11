import {
	type Api,
	InMemoryCredentialStore,
	type Model,
} from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { createCustomProvider } from "./custom-provider.ts";
import type { ActionInputs } from "./inputs.ts";

/**
 * Every built-in provider (keys from api_key or the usual environment variables) plus the custom provider, if
 * provider_base_url is set. Nothing is read from or written to ~/.pi.
 */
export async function createActionModels(
	inputs: Pick<
		ActionInputs,
		"provider" | "model" | "apiKey" | "customProvider"
	>,
): Promise<MutableModels> {
	const { provider, model, apiKey, customProvider } = inputs;
	const credentials = new InMemoryCredentialStore();
	if (apiKey) {
		await credentials.modify(provider, async () => ({
			type: "api_key",
			key: apiKey,
		}));
	}
	const models = builtinModels({ credentials });
	if (customProvider) {
		models.setProvider(
			createCustomProvider(provider, model, Boolean(apiKey), customProvider),
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
