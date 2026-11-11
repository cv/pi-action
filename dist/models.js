import { execSync } from "node:child_process";
import { InMemoryCredentialStore, } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createProvider, } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
/** The model APIs a models.json custom provider may use here. */
const CUSTOM_APIS = {
    "anthropic-messages": anthropicMessagesApi,
    "openai-completions": openAICompletionsApi,
    "openai-responses": openAIResponsesApi,
};
const isCustomApi = (api) => typeof api === "string" && api in CUSTOM_APIS;
function parseJson(text, what) {
    try {
        return JSON.parse(text);
    }
    catch (error) {
        throw new Error(`${what} is not valid JSON: ${error.message}`);
    }
}
/** Seed a credential store from auth.json; refreshed OAuth tokens live only for this run. */
export async function credentialsFromAuthJson(authJson) {
    const store = new InMemoryCredentialStore();
    if (!authJson?.trim()) {
        return store;
    }
    const parsed = parseJson(authJson, "pi_auth_json");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("pi_auth_json must be an object of provider credentials");
    }
    for (const [providerId, credential] of Object.entries(parsed)) {
        const type = credential?.type;
        if (type === "api_key" || type === "oauth") {
            await store.modify(providerId, async () => credential);
        }
    }
    return store;
}
/** models.json apiKey: "!command", an environment variable name, or the key itself. */
export function resolveApiKey(value, env = process.env) {
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
function customModel(providerId, config, model, log) {
    const api = model.api ?? config.api;
    const baseUrl = model.baseUrl ?? config.baseUrl;
    if (!(isCustomApi(api) && baseUrl)) {
        log?.(`models_json: skipping ${providerId}/${model.id} (api ${api ?? "unset"})`);
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
    };
}
function customProvider(id, config, models, env) {
    const apis = [...new Set(models.map((m) => m.api))];
    return createProvider({
        id,
        baseUrl: config.baseUrl,
        headers: config.headers,
        auth: {
            apiKey: {
                name: `${id} API key`,
                resolve: ({ credential }) => {
                    const apiKey = credential?.key ?? resolveApiKey(config.apiKey, env);
                    return Promise.resolve(apiKey ? { auth: { apiKey }, source: "models_json" } : undefined);
                },
            },
        },
        models,
        api: Object.fromEntries(apis.map((api) => [api, CUSTOM_APIS[api]()])),
    });
}
/** Build providers for models.json's custom providers (the APIs in CUSTOM_APIS; others are skipped). */
export function customProviders(modelsJson, options = {}) {
    if (!modelsJson?.trim()) {
        return [];
    }
    const parsed = parseJson(modelsJson, "models_json");
    const providers = [];
    for (const [id, config] of Object.entries(parsed?.providers ?? {})) {
        const models = (config.models ?? []).flatMap((model) => customModel(id, config, model, options.log) ?? []);
        if (models.length > 0) {
            providers.push(customProvider(id, config, models, options.env));
        }
    }
    return providers;
}
/** Every built-in provider plus models.json's, with auth.json credentials. */
export async function createActionModels(options = {}) {
    const models = builtinModels({
        credentials: await credentialsFromAuthJson(options.authJson),
    });
    for (const provider of customProviders(options.modelsJson, options)) {
        models.setProvider(provider);
    }
    return models;
}
export function findModel(models, provider, modelId) {
    const model = models.getModel(provider, modelId);
    if (!model) {
        const known = models
            .getModels(provider)
            .map((m) => m.id)
            .slice(0, 20);
        throw new Error(`Model not found: ${provider}/${modelId}${known.length > 0 ? ` (known: ${known.join(", ")})` : " (unknown provider)"}`);
    }
    return model;
}
