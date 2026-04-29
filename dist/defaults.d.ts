/**
 * Centralized default values for action inputs.
 * These are the source of truth - action.yml should match these values.
 */
export declare const DEFAULTS: {
    readonly triggerPhrase: "@pi";
    readonly timeout: 1800;
    readonly shareSession: true;
    readonly provider: "anthropic";
    readonly model: "claude-sonnet-4-20250514";
    readonly customProviderApi: "openai-completions";
    readonly customProviderAuthHeader: false;
    readonly customModelReasoning: false;
    readonly customModelInput: "text";
    readonly customModelContextWindow: 128000;
    readonly customModelMaxTokens: 16384;
};
