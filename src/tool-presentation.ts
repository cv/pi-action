// A tool's own form in the workflow log (#80): an optional `present` field on a pi-durable tool. pi-durable does not
// declare it, so pi-action reads it as `unknown` and checks each value it returns.
import type { ToolResultMessage } from "@earendil-works/pi-ai";

import { isRecord } from "./utils.ts";

/** What a tool shows when its call starts: the `🔧` line, and the details in place of its arguments. */
interface PresentedCall {
	title: string;
	body?: string;
}

/** What a tool shows when its call ends: the `↳` line in place of the line count, and the details in place of its output. */
interface PresentedResult {
	summary?: string;
	body?: string;
}

/** A tool's `present` functions, checked: they throw a `TypeError` when the tool returns something else. */
export interface ToolPresentation {
	call?: (args: Record<string, unknown>) => PresentedCall;
	result?: (
		args: Record<string, unknown>,
		result: ToolResultMessage,
	) => PresentedResult;
}

/** `value[key]`: a string, or undefined; any other type is an error. */
function optionalString(
	value: Record<string, unknown>,
	key: string,
	where: string,
): string | undefined {
	const text = value[key];
	if (text === undefined || typeof text === "string") {
		return text;
	}
	throw new TypeError(`${where} returned a ${key} that is not a string`);
}

/** `present[name]` as a function with `present` as `this`, or undefined when it is not a function. */
function method(
	present: Record<string, unknown>,
	name: string,
): ((...args: unknown[]) => unknown) | undefined {
	const fn = present[name];
	if (typeof fn !== "function") {
		return undefined;
	}
	return (...args) => {
		const value: unknown = Reflect.apply(fn, present, args);
		return value;
	};
}

/** The record a `present` function returned; anything else (a promise too) is an error. */
function returned(value: unknown, where: string): Record<string, unknown> {
	if (!isRecord(value) || value instanceof Promise) {
		throw new TypeError(`${where} did not return an object`);
	}
	return value;
}

/**
 * The `present` field of a tool, with checked functions; undefined when the tool has none. The functions get a copy
 * of the arguments, so a tool that changes them does not change what the log shows next.
 */
export function toolPresentation(tool: unknown): ToolPresentation | undefined {
	const present = isRecord(tool) ? tool["present"] : undefined;
	if (!isRecord(present)) {
		return undefined;
	}
	const call = method(present, "call");
	const result = method(present, "result");
	if (call === undefined && result === undefined) {
		return undefined;
	}
	return {
		...(call === undefined
			? {}
			: {
					call: (args) => {
						const value = returned(
							call(structuredClone(args)),
							"present.call()",
						);
						const title = optionalString(value, "title", "present.call()");
						if (title === undefined || title.trim() === "") {
							throw new TypeError("present.call() returned no title");
						}
						const body = optionalString(value, "body", "present.call()");
						return body === undefined ? { title } : { title, body };
					},
				}),
		...(result === undefined
			? {}
			: {
					result: (args, message) => {
						const value = returned(
							result(structuredClone(args), structuredClone(message)),
							"present.result()",
						);
						const summary = optionalString(
							value,
							"summary",
							"present.result()",
						);
						const body = optionalString(value, "body", "present.result()");
						return {
							...(summary === undefined ? {} : { summary }),
							...(body === undefined ? {} : { body }),
						};
					},
				}),
	};
}
