/**
 * Centralized default values for action inputs.
 * These are the source of truth - action.yml should match these values.
 */
export declare const DEFAULTS: {
    readonly triggerPhrase: "@pi";
    readonly timeout: 1800;
    readonly provider: "anthropic";
    readonly model: "claude-sonnet-5-5";
    readonly pollInterval: 15;
};
/** pi-durable's engines field. */
export declare const MIN_NODE_VERSION = "22.19.0";
