import { describe, expect, it } from "vitest";

import { getErrorMessage } from "./utils.ts";

describe("getErrorMessage", () => {
	it.each([
		[new Error("test error"), "test error"],
		["string error", "string error"],
		[{ message: "object error" }, "object error"],
		[null, "Unknown error"],
		[undefined, "Unknown error"],
		[42, "Unknown error"],
		[{ code: "ERR" }, "Unknown error"],
	])("turns %o into %s", (error, message) => {
		expect(getErrorMessage(error)).toBe(message);
	});
});
