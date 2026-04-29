import { describe, expect, it } from "vitest";
import { readActionInputs } from "./action-inputs.js";
import { DEFAULTS } from "./defaults.js";

function createInputReader(
	values: Record<string, string>,
): (name: string) => string {
	return (name) => values[name] ?? "";
}

describe("readActionInputs", () => {
	it("uses defaults and GitHub token env fallback", () => {
		const inputs = readActionInputs(createInputReader({}), {
			GITHUB_TOKEN: "env-token",
		});

		expect(inputs).toEqual({
			triggerPhrase: DEFAULTS.triggerPhrase,
			allowedBots: [],
			modelConfig: {
				provider: DEFAULTS.provider,
				model: DEFAULTS.model,
				timeout: DEFAULTS.timeout,
			},
			githubToken: "env-token",
			gistToken: undefined,
			apiKey: undefined,
			customProvider: undefined,
			promptTemplate: undefined,
			shareSession: DEFAULTS.shareSession,
			outputMode: DEFAULTS.outputMode,
			prompt: undefined,
			prNumber: undefined,
		});
	});

	it("reads all action input groups", () => {
		const inputs = readActionInputs(
			createInputReader({
				github_token: "input-token",
				gist_token: "gist-token",
				api_key: "sk-test",
				trigger_phrase: "@assistant",
				allowed_bots: "dependabot[bot], renovate[bot]",
				timeout: "60",
				provider: "nvidia",
				model: "openai/openai/gpt-5.5",
				provider_base_url: "https://inference-api.nvidia.com",
				provider_api: "openai-responses",
				model_reasoning: "true",
				model_input: "text,image",
				prompt_template: "Task: {{task}}",
				share_session: "false",
				output_mode: "output",
				prompt: "Generate release notes",
				pr_number: "42",
			}),
			{ GITHUB_TOKEN: "env-token" },
		);

		expect(inputs.githubToken).toBe("input-token");
		expect(inputs.gistToken).toBe("gist-token");
		expect(inputs.apiKey).toBe("sk-test");
		expect(inputs.triggerPhrase).toBe("@assistant");
		expect(inputs.allowedBots).toEqual(["dependabot[bot]", "renovate[bot]"]);
		expect(inputs.modelConfig).toEqual({
			provider: "nvidia",
			model: "openai/openai/gpt-5.5",
			timeout: 60,
		});
		expect(inputs.customProvider).toEqual(
			expect.objectContaining({
				baseUrl: "https://inference-api.nvidia.com",
				api: "openai-responses",
				reasoning: true,
				input: ["text", "image"],
			}),
		);
		expect(inputs.promptTemplate).toBe("Task: {{task}}");
		expect(inputs.shareSession).toBe(false);
		expect(inputs.outputMode).toBe("output");
		expect(inputs.prompt).toBe("Generate release notes");
		expect(inputs.prNumber).toBe(42);
	});
});
