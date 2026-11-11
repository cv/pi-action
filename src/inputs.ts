// Reading the action's inputs (see action.yml) into ActionInputs. Empty or invalid values fall back to DEFAULTS.
import type {
	CustomProviderConfig,
	ModelInputMode,
} from "./custom-provider.ts";
import { DEFAULTS } from "./defaults.ts";

export type InputReader = (name: string) => string;

export interface ActionInputs {
	triggerPhrase: string;
	allowedBots: string[];
	allowedUsers: string[];
	allowedAssociations: string[];
	provider: string;
	model: string;
	/** Seconds before the run is aborted. */
	timeout: number;
	githubToken: string | undefined;
	/** The provider's key, kept in memory for this run only. */
	apiKey: string | undefined;
	customProvider: CustomProviderConfig | undefined;
	promptTemplate: string | undefined;
	outputMode: "comment" | "output";
	prompt: string | undefined;
	prNumber: number | undefined;
	/** Seconds between checks for new comments while pi works. */
	pollInterval: number;
	/** pi extensions to load (npm specs or workspace paths) for the providers they register. */
	extensions: string[];
	/** Whether pi-durable extensions may load and run the repository's own configuration (`trust_project`). */
	trustProject: boolean;
	/** The agent directory for pi-durable extensions; a temp dir when unset. */
	agentDir: string | undefined;
}

const TRUE_VALUES = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "n", "off"]);
const MODEL_INPUT_MODES: ReadonlySet<string> = new Set<ModelInputMode>([
	"text",
	"image",
]);
const INTEGER_PATTERN = /^\d+$/u;
const LINE_BREAK = /\r?\n/u;
/** A `#` at the start of a line or after whitespace starts a comment; `github:owner/repo#ref` keeps its `#`. */
const EXTENSION_COMMENT = /(?:^|\s)#.*$/u;
const COMPAT_INPUTS = {
	supportsDeveloperRole: "compat_supports_developer_role",
	supportsReasoningEffort: "compat_supports_reasoning_effort",
	forceAdaptiveThinking: "compat_force_adaptive_thinking",
} as const;

export function parseCsv(value: string): string[] {
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/**
 * pi extension specs, newline- or comma-separated. Blank lines are skipped, and so are `#` comments: whole lines, or
 * the rest of a line after a spec (`pkg@1.2.3  # why`). Comments are removed before the commas split the line.
 */
export function parseExtensionSpecs(value: string): string[] {
	return value
		.split(LINE_BREAK)
		.flatMap((line) => line.replace(EXTENSION_COMMENT, "").split(","))
		.map((spec) => spec.trim())
		.filter((spec) => spec !== "" && !spec.startsWith("#"));
}

/** true/1/yes/y/on or false/0/no/n/off, in any case; undefined for anything else. */
export function parseBoolean(value: string): boolean | undefined {
	const normalized = value.trim().toLowerCase();
	if (TRUE_VALUES.has(normalized)) {
		return true;
	}
	return FALSE_VALUES.has(normalized) ? false : undefined;
}

export function parsePositiveInteger(value: string): number | undefined {
	const normalized = value.trim();
	const parsed = INTEGER_PATTERN.test(normalized)
		? Number.parseInt(normalized, 10)
		: 0;
	return parsed > 0 ? parsed : undefined;
}

function parseModelInputModes(value: string): ModelInputMode[] {
	const modes = parseCsv(value).filter((mode): mode is ModelInputMode =>
		MODEL_INPUT_MODES.has(mode),
	);
	return modes.length > 0 ? modes : [DEFAULTS.customModelInput];
}

function readCompat(readInput: InputReader): CustomProviderConfig["compat"] {
	const compat = Object.fromEntries(
		Object.entries(COMPAT_INPUTS).flatMap(([key, name]) => {
			const value = parseBoolean(readInput(name));
			return value === undefined ? [] : [[key, value]];
		}),
	);
	return Object.keys(compat).length > 0 ? compat : undefined;
}

/** The single custom provider/model from the flat provider_* and model_* inputs; undefined without a base URL. */
export function readCustomProviderConfig(
	readInput: InputReader,
): CustomProviderConfig | undefined {
	const baseUrl = readInput("provider_base_url").trim();
	if (!baseUrl) {
		return undefined;
	}
	const apiKey = readInput("provider_api_key").trim();
	const modelName = readInput("model_name").trim();
	const compat = readCompat(readInput);
	return {
		baseUrl,
		api: readInput("provider_api") || DEFAULTS.customProviderApi,
		...(apiKey ? { apiKey } : {}),
		authHeader:
			parseBoolean(readInput("provider_auth_header")) ??
			DEFAULTS.customProviderAuthHeader,
		...(modelName ? { modelName } : {}),
		reasoning:
			parseBoolean(readInput("model_reasoning")) ??
			DEFAULTS.customModelReasoning,
		input: parseModelInputModes(readInput("model_input")),
		contextWindow:
			parsePositiveInteger(readInput("model_context_window")) ??
			DEFAULTS.customModelContextWindow,
		maxTokens:
			parsePositiveInteger(readInput("model_max_tokens")) ??
			DEFAULTS.customModelMaxTokens,
		...(compat ? { compat } : {}),
	};
}

export function readActionInputs(
	readInput: InputReader,
	env: Record<string, string | undefined> = process.env,
): ActionInputs {
	return {
		triggerPhrase: readInput("trigger_phrase") || DEFAULTS.triggerPhrase,
		allowedBots: parseCsv(readInput("allowed_bots")),
		allowedUsers: parseCsv(readInput("allowed_users")),
		allowedAssociations: parseCsv(
			readInput("allowed_associations") ||
				DEFAULTS.allowedAssociations.join(","),
		),
		provider: readInput("provider") || DEFAULTS.provider,
		model: readInput("model") || DEFAULTS.model,
		timeout: parsePositiveInteger(readInput("timeout")) ?? DEFAULTS.timeout,
		githubToken: readInput("github_token") || env["GITHUB_TOKEN"],
		apiKey: readInput("api_key") || undefined,
		customProvider: readCustomProviderConfig(readInput),
		promptTemplate: readInput("prompt_template") || undefined,
		outputMode:
			readInput("output_mode") === "output" ? "output" : DEFAULTS.outputMode,
		prompt: readInput("prompt") || undefined,
		prNumber: parsePositiveInteger(readInput("pr_number")),
		pollInterval:
			parsePositiveInteger(readInput("poll_interval")) ?? DEFAULTS.pollInterval,
		extensions: parseExtensionSpecs(readInput("extensions")),
		trustProject:
			parseBoolean(readInput("trust_project")) ?? DEFAULTS.trustProject,
		agentDir: readInput("agent_dir").trim() || undefined,
	};
}
