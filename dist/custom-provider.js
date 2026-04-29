import { DEFAULTS } from "./defaults.js";
import { getInputOrDefault, parseBooleanInput, parseModelInputModes, parseOptionalBooleanInput, parsePositiveIntegerInput, } from "./inputs.js";
function createCompatConfig(readInput) {
    const supportsDeveloperRole = parseOptionalBooleanInput(readInput("compat_supports_developer_role"));
    const supportsReasoningEffort = parseOptionalBooleanInput(readInput("compat_supports_reasoning_effort"));
    const compat = {
        ...(supportsDeveloperRole === undefined ? {} : { supportsDeveloperRole }),
        ...(supportsReasoningEffort === undefined
            ? {}
            : { supportsReasoningEffort }),
    };
    return Object.keys(compat).length > 0 ? compat : undefined;
}
export function readCustomProviderConfig(readInput) {
    const baseUrl = readInput("provider_base_url").trim();
    if (!baseUrl) {
        return undefined;
    }
    const apiKey = readInput("provider_api_key").trim();
    const modelName = readInput("model_name").trim();
    const compat = createCompatConfig(readInput);
    return {
        baseUrl,
        api: getInputOrDefault(readInput, "provider_api", DEFAULTS.customProviderApi),
        ...(apiKey ? { apiKey } : {}),
        authHeader: parseBooleanInput(readInput("provider_auth_header"), DEFAULTS.customProviderAuthHeader),
        ...(modelName ? { modelName } : {}),
        reasoning: parseBooleanInput(readInput("model_reasoning"), DEFAULTS.customModelReasoning),
        input: parseModelInputModes(readInput("model_input"), ["text"]),
        contextWindow: parsePositiveIntegerInput(readInput("model_context_window"), DEFAULTS.customModelContextWindow),
        maxTokens: parsePositiveIntegerInput(readInput("model_max_tokens"), DEFAULTS.customModelMaxTokens),
        ...(compat ? { compat } : {}),
    };
}
