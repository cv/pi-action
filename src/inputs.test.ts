import { describe, expect, it } from "vitest";

import { DEFAULTS } from "./defaults.ts";
import {
	parseBoolean,
	parseCsv,
	parseExtensionSpecs,
	parsePositiveInteger,
	readActionInputs,
	readCustomProviderConfig,
} from "./inputs.ts";
import { createActionInputs } from "./test-helpers.ts";

const reader =
	(values: Record<string, string>) =>
	(name: string): string =>
		values[name] ?? "";

describe("readActionInputs", () => {
	it("uses defaults and the GITHUB_TOKEN fallback", () => {
		expect(
			readActionInputs(reader({}), { GITHUB_TOKEN: "env-token" }),
		).toStrictEqual(createActionInputs({ githubToken: "env-token" }));
	});

	it("reads every input", () => {
		const inputs = readActionInputs(
			reader({
				github_token: "input-token",
				api_key: "sk-test",
				trigger_phrase: "@assistant",
				allowed_bots: "dependabot[bot], renovate[bot]",
				allowed_users: "@alice, Bob",
				allowed_associations: "OWNER,COLLABORATOR",
				timeout: "60",
				poll_interval: "5",
				provider: "nvidia",
				model: "openai/openai/gpt-5.5",
				provider_base_url: "https://inference-api.nvidia.com",
				prompt_template: "Task: {{task}}",
				output_mode: "output",
				prompt: "Generate release notes",
				pr_number: "42",
				extensions: "@acme/pi-provider@1.2.3\n./ext.ts",
				trust_project: "true",
				agent_dir: " .pi/agent ",
			}),
			{ GITHUB_TOKEN: "env-token" },
		);
		expect(inputs).toStrictEqual({
			triggerPhrase: "@assistant",
			allowedBots: ["dependabot[bot]", "renovate[bot]"],
			allowedUsers: ["@alice", "Bob"],
			allowedAssociations: ["OWNER", "COLLABORATOR"],
			provider: "nvidia",
			model: "openai/openai/gpt-5.5",
			timeout: 60,
			githubToken: "input-token",
			apiKey: "sk-test",
			customProvider: expect.objectContaining({
				baseUrl: "https://inference-api.nvidia.com",
			}),
			promptTemplate: "Task: {{task}}",
			outputMode: "output",
			prompt: "Generate release notes",
			prNumber: 42,
			pollInterval: 5,
			extensions: ["@acme/pi-provider@1.2.3", "./ext.ts"],
			trustProject: true,
			agentDir: ".pi/agent",
			worktreeSnapshots: true,
			worktreeLimits: {
				maxFileBytes: 10 * 1024 * 1024,
				maxTotalBytes: 100 * 1024 * 1024,
				exclude: [],
			},
		});
	});
});

describe("parseExtensionSpecs", () => {
	it("splits lines and commas, skipping blanks and comments", () => {
		expect(
			parseExtensionSpecs(
				"pi-foo@1.2.3, @acme/pi-bar\n\n  # a comment\n./local/ext.ts\n",
			),
		).toStrictEqual(["pi-foo@1.2.3", "@acme/pi-bar", "./local/ext.ts"]);
		expect(parseExtensionSpecs("")).toStrictEqual([]);
	});

	it("drops comments after a spec, also with commas, and keeps the # of a git ref", () => {
		expect(
			parseExtensionSpecs(
				"github:cv/pit#v0.35.0   # pit's typescript tool, pinned\r\na, b\t# two\n#c\nd,#e\n",
			),
		).toStrictEqual(["github:cv/pit#v0.35.0", "a", "b", "d"]);
	});
});

describe("readCustomProviderConfig", () => {
	it("returns undefined when provider_base_url is empty", () => {
		expect(readCustomProviderConfig(reader({}))).toBeUndefined();
	});

	it("reads a single custom provider/model config from flat inputs", () => {
		const config = readCustomProviderConfig(
			reader({
				provider_base_url: "https://inference-api.nvidia.com",
				provider_api: "openai-responses",
				provider_api_key: "NVIDIA_API_KEY",
				provider_auth_header: "true",
				model_name: "GPT-5.5 (OpenAI)",
				model_reasoning: "true",
				model_input: "text,image",
				model_context_window: "1050000",
				model_max_tokens: "16384",
				compat_supports_developer_role: "false",
				compat_supports_reasoning_effort: "false",
				compat_force_adaptive_thinking: "true",
			}),
		);
		expect(config).toStrictEqual({
			baseUrl: "https://inference-api.nvidia.com",
			api: "openai-responses",
			apiKey: "NVIDIA_API_KEY",
			authHeader: true,
			modelName: "GPT-5.5 (OpenAI)",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_050_000,
			maxTokens: 16_384,
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				forceAdaptiveThinking: true,
			},
		});
	});

	it("uses defaults for optional or invalid inputs", () => {
		const config = readCustomProviderConfig(
			reader({
				provider_base_url: "http://localhost:11434/v1",
				model_input: "audio",
				compat_supports_developer_role: "maybe",
			}),
		);
		expect(config).toStrictEqual({
			baseUrl: "http://localhost:11434/v1",
			api: DEFAULTS.customProviderApi,
			authHeader: DEFAULTS.customProviderAuthHeader,
			reasoning: DEFAULTS.customModelReasoning,
			input: [DEFAULTS.customModelInput],
			contextWindow: DEFAULTS.customModelContextWindow,
			maxTokens: DEFAULTS.customModelMaxTokens,
		});
	});
});

describe("parsers", () => {
	it("splits CSV, trimming and dropping empty values", () => {
		expect(parseCsv("dependabot[bot], renovate[bot],,  ")).toStrictEqual([
			"dependabot[bot]",
			"renovate[bot]",
		]);
		expect(parseCsv("")).toStrictEqual([]);
	});

	it.each([
		...["true", "TRUE", "1", "yes", "y", " on "].map((v) => [v, true] as const),
		...["false", "FALSE", "0", "no", "n", "off"].map(
			(v) => [v, false] as const,
		),
		...["", "  ", "maybe"].map((v) => [v, undefined] as const),
	])("parses %o as the boolean %s", (value, expected) => {
		expect(parseBoolean(value)).toBe(expected);
	});

	it.each([
		["1800", 1800] as const,
		["001", 1] as const,
		...["", "0", "-1", "1.5", "10s", "abc"].map((v) => [v, undefined] as const),
	])("parses %o as the positive integer %s", (value, expected) => {
		expect(parsePositiveInteger(value)).toBe(expected);
	});
});

describe("working-tree snapshot inputs", () => {
	it("reads the switch and the limits, in MB, with the globs to exclude", () => {
		const inputs = readActionInputs(
			reader({
				worktree_snapshots: "off",
				worktree_snapshot_max_file_mb: "2",
				worktree_snapshot_max_total_mb: "20",
				worktree_snapshot_exclude: ".env*, *.pem\n# keys\nid_rsa*",
			}),
			{},
		);
		expect(inputs.worktreeSnapshots).toBe(false);
		expect(inputs.worktreeLimits).toStrictEqual({
			maxFileBytes: 2 * 1024 * 1024,
			maxTotalBytes: 20 * 1024 * 1024,
			exclude: [".env*", "*.pem", "id_rsa*"],
		});
	});

	it("falls back to the defaults for values that are not valid", () => {
		const inputs = readActionInputs(
			reader({
				worktree_snapshots: "maybe",
				worktree_snapshot_max_file_mb: "-1",
			}),
			{},
		);
		expect(inputs.worktreeSnapshots).toBe(true);
		expect(inputs.worktreeLimits.maxFileBytes).toBe(10 * 1024 * 1024);
		expect(inputs.worktreeLimits.exclude).toStrictEqual([]);
	});
});
