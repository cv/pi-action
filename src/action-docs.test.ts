import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ACTION_YML = readFileSync("action.yml", "utf-8");
const README = readFileSync("README.md", "utf-8");
const ACTION_INPUT_NAME_PATTERN = /^ {2}(\w+):$/gmu;
const README_INPUT_NAME_PATTERN = /^\| `([^`]+)` \|/gmu;

function compareStrings(left: string, right: string): number {
	return left.localeCompare(right);
}

function getActionInputNames(): string[] {
	const inputsBlock = ACTION_YML.slice(
		ACTION_YML.indexOf("inputs:"),
		ACTION_YML.indexOf("outputs:") === -1
			? ACTION_YML.indexOf("runs:")
			: ACTION_YML.indexOf("outputs:"),
	);
	return [...inputsBlock.matchAll(ACTION_INPUT_NAME_PATTERN)].flatMap(
		(match) => (match[1] ? [match[1]] : []),
	);
}

function getReadmeInputNames(): string[] {
	const inputTableStart = README.indexOf(
		"| Input | Description | Required | Default |",
	);
	if (inputTableStart === -1) {
		throw new Error("README input table not found");
	}
	const nextHeading = README.slice(inputTableStart).indexOf("\n### Examples");
	const inputTable = README.slice(
		inputTableStart,
		nextHeading === -1 ? undefined : inputTableStart + nextHeading,
	);
	return [...inputTable.matchAll(README_INPUT_NAME_PATTERN)].flatMap((match) =>
		match[1] ? [match[1]] : [],
	);
}

describe("action input documentation", () => {
	it("documents every action.yml input in the README inputs table", () => {
		expect(getReadmeInputNames().sort(compareStrings)).toEqual(
			getActionInputNames().sort(compareStrings),
		);
	});
});
