/**
 * Centralized default values for action inputs.
 * These are the source of truth - action.yml should match these values.
 */

export const DEFAULTS = {
	triggerPhrase: "@pi",
	allowedAssociations: ["OWNER", "MEMBER"],
	timeout: 1800,
	shareSession: true,
	provider: "anthropic",
	model: "claude-sonnet-4-20250514",
	customProviderApi: "openai-completions",
	customProviderAuthHeader: false,
	customModelReasoning: false,
	customModelInput: "text",
	customModelContextWindow: 128_000,
	customModelMaxTokens: 16_384,
	outputMode: "comment",
} as const;
