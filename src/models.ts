import {
	type Api,
	InMemoryCredentialStore,
	type Model,
} from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { createCustomProvider } from "./custom-provider.ts";
import { composeExtensionProvider } from "./extension-provider.ts";
import type { ExtensionProvider } from "./extensions.ts";
import type { ActionInputs } from "./inputs.ts";
import type { Log } from "./types.ts";

/** The providers the `extensions` input registered, and what their configs resolve against. */
export interface ExtensionModels {
	/** In registration order. */
	providers: readonly ExtensionProvider[];
	env: Record<string, string | undefined>;
	log: Pick<Log, "warning">;
}

/** Each extension provider replaces (or overrides) the provider of its id; dynamic ones fetch their models. */
async function addExtensionProviders(
	models: MutableModels,
	{ providers, env, log }: ExtensionModels,
): Promise<void> {
	for (const entry of providers) {
		models.setProvider(
			entry.kind === "provider"
				? entry.provider
				: composeExtensionProvider(
						entry.id,
						models.getProvider(entry.id),
						entry.config,
						env,
					),
		);
	}
	const dynamic = [
		...new Set(
			providers
				.map((entry) => models.getProvider(entry.id))
				.flatMap((provider) => (provider?.refreshModels ? [provider.id] : [])),
		),
	];
	if (dynamic.length === 0) {
		return;
	}
	const { errors } = await models.refresh({ providers: dynamic });
	for (const [id, error] of errors) {
		log.warning(
			`Could not list the models of provider ${id}: ${error.message}`,
		);
	}
}

/**
 * Every built-in provider (keys from api_key or the usual environment variables), the providers extensions
 * registered, and the custom provider, if provider_base_url is set. Nothing is read from or written to ~/.pi.
 */
export async function createActionModels(
	inputs: Pick<
		ActionInputs,
		"provider" | "model" | "apiKey" | "customProvider"
	>,
	extensions?: ExtensionModels,
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
	if (extensions) {
		await addExtensionProviders(models, extensions);
	}
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
