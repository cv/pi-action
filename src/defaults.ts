/**
 * Centralized default values for action inputs.
 * These are the source of truth - action.yml should match these values.
 */

export const DEFAULTS = {
	triggerPhrase: "@pi",
	timeout: 1800,
	provider: "anthropic",
	model: "claude-sonnet-5-5",
	pollInterval: 15,
} as const;

/** pi-durable's engines field. */
export const MIN_NODE_VERSION = "22.19.0";
