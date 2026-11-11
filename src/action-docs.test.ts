import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const ACTION_YML = readFileSync("action.yml", "utf8");
const INPUTS_DOC = readFileSync("docs/inputs.md", "utf8");
const ACTION_INPUT_NAME_PATTERN = /^ {2}(\w+):$/gmu;
const DOC_INPUT_NAME_PATTERN = /^\| `([^`]+)` \|/gmu;

function compareStrings(left: string, right: string): number {
	return left.localeCompare(right);
}

function getActionInputNames(): string[] {
	const inputsBlock = ACTION_YML.slice(
		ACTION_YML.indexOf("inputs:"),
		ACTION_YML.includes("outputs:")
			? ACTION_YML.indexOf("outputs:")
			: ACTION_YML.indexOf("runs:"),
	);
	return [...inputsBlock.matchAll(ACTION_INPUT_NAME_PATTERN)].flatMap((match) =>
		match[1] ? [match[1]] : [],
	);
}

function getDocumentedInputNames(): string[] {
	const inputTableStart = INPUTS_DOC.indexOf(
		"| Input | Description | Required | Default |",
	);
	if (inputTableStart === -1) {
		throw new Error("docs/inputs.md input table not found");
	}
	const nextHeading = INPUTS_DOC.slice(inputTableStart).indexOf("\n#");
	const inputTable = INPUTS_DOC.slice(
		inputTableStart,
		nextHeading === -1 ? undefined : inputTableStart + nextHeading,
	);
	return [...inputTable.matchAll(DOC_INPUT_NAME_PATTERN)].flatMap((match) =>
		match[1] ? [match[1]] : [],
	);
}

describe("action input documentation", () => {
	it("documents every action.yml input in the docs/inputs.md table", () => {
		expect(getDocumentedInputNames().toSorted(compareStrings)).toStrictEqual(
			getActionInputNames().toSorted(compareStrings),
		);
	});
});
