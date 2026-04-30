import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "./defaults.js";

const ACTION_YML = readFileSync("action.yml", "utf-8");
const README = readFileSync("README.md", "utf-8");
const NEXT_ACTION_INPUT_PATTERN = /\n {2}\w/u;
const ACTION_DEFAULT_PATTERN = /\n {4}default: ['"]?([^'"\n]+)['"]?/u;
const REGEXP_SPECIAL_CHARS_PATTERN = /[.*+?^${}()|[\]\\]/gu;

const DEFAULT_CASES = [
	["trigger_phrase", DEFAULTS.triggerPhrase],
	["allowed_associations", DEFAULTS.allowedAssociations.join(",")],
	["timeout", String(DEFAULTS.timeout)],
	["provider", DEFAULTS.provider],
	["model", DEFAULTS.model],
	["provider_api", DEFAULTS.customProviderApi],
	["provider_auth_header", String(DEFAULTS.customProviderAuthHeader)],
	["model_reasoning", String(DEFAULTS.customModelReasoning)],
	["model_input", DEFAULTS.customModelInput],
	["model_context_window", String(DEFAULTS.customModelContextWindow)],
	["model_max_tokens", String(DEFAULTS.customModelMaxTokens)],
	["share_session", String(DEFAULTS.shareSession)],
	["output_mode", DEFAULTS.outputMode],
] as const;

function getActionInputDefault(inputName: string): string {
	const inputStart = ACTION_YML.indexOf(`  ${inputName}:`);
	if (inputStart === -1) {
		throw new Error(`Input ${inputName} not found in action.yml`);
	}

	const nextInputStart = ACTION_YML.slice(inputStart + 1).search(
		NEXT_ACTION_INPUT_PATTERN,
	);
	const inputBlock =
		nextInputStart === -1
			? ACTION_YML.slice(inputStart)
			: ACTION_YML.slice(inputStart, inputStart + 1 + nextInputStart);
	const defaultMatch = inputBlock.match(ACTION_DEFAULT_PATTERN);
	const defaultValue = defaultMatch?.[1];
	if (defaultValue === undefined) {
		throw new Error(`Input ${inputName} has no default in action.yml`);
	}
	return defaultValue;
}

function getReadmeInputDefault(inputName: string): string {
	const escapedInputName = inputName.replace(
		REGEXP_SPECIAL_CHARS_PATTERN,
		"\\$&",
	);
	const defaultMatch = README.match(
		new RegExp(
			`\\| \`${escapedInputName}\` \\|[^\\n]*\\| \`([^\`]+)\` \\|`,
			"u",
		),
	);
	const defaultValue = defaultMatch?.[1];
	if (defaultValue === undefined) {
		throw new Error(`Input ${inputName} not found in README inputs table`);
	}
	return defaultValue;
}

describe("input defaults", () => {
	it.each(
		DEFAULT_CASES,
	)("keeps %s default in sync across source, action.yml, and README", (inputName, expectedDefault) => {
		expect(getActionInputDefault(inputName)).toBe(expectedDefault);
		expect(getReadmeInputDefault(inputName)).toBe(expectedDefault);
	});
});
