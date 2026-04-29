import { describe, expect, it } from "vitest";
import {
	getInputOrDefault,
	parseBooleanInput,
	parseCsvInput,
	parsePositiveIntegerInput,
} from "./inputs.js";

describe("getInputOrDefault", () => {
	it("returns the input value when present", () => {
		expect(getInputOrDefault(() => "openai", "provider", "anthropic")).toBe(
			"openai",
		);
	});

	it("returns the default value when input is empty", () => {
		expect(getInputOrDefault(() => "", "provider", "anthropic")).toBe(
			"anthropic",
		);
	});
});

describe("parseCsvInput", () => {
	it("splits, trims, and removes empty values", () => {
		expect(parseCsvInput("dependabot[bot], renovate[bot],,  ")).toEqual([
			"dependabot[bot]",
			"renovate[bot]",
		]);
	});

	it("returns an empty array for empty input", () => {
		expect(parseCsvInput("")).toEqual([]);
	});
});

describe("parseBooleanInput", () => {
	it.each([
		"true",
		"TRUE",
		"1",
		"yes",
		"y",
		"on",
	])("parses %s as true", (value) => {
		expect(parseBooleanInput(value, false)).toBe(true);
	});

	it.each([
		"false",
		"FALSE",
		"0",
		"no",
		"n",
		"off",
	])("parses %s as false", (value) => {
		expect(parseBooleanInput(value, true)).toBe(false);
	});

	it("returns the default for empty input", () => {
		expect(parseBooleanInput("", true)).toBe(true);
		expect(parseBooleanInput("  ", false)).toBe(false);
	});

	it("returns the default for invalid input", () => {
		expect(parseBooleanInput("maybe", true)).toBe(true);
		expect(parseBooleanInput("maybe", false)).toBe(false);
	});
});

describe("parsePositiveIntegerInput", () => {
	it("parses positive integers", () => {
		expect(parsePositiveIntegerInput("1800", 300)).toBe(1800);
		expect(parsePositiveIntegerInput("001", 300)).toBe(1);
	});

	it.each([
		"",
		"0",
		"-1",
		"1.5",
		"10s",
		"abc",
	])("returns the default for invalid value %s", (value) => {
		expect(parsePositiveIntegerInput(value, 300)).toBe(300);
	});
});
