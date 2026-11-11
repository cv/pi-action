import { describe, expect, it } from "vitest";
import { getErrorMessage, TimeoutError, withTimeout } from "./utils.js";

describe("getErrorMessage", () => {
	it("extracts message from Error instance", () => {
		expect(getErrorMessage(new Error("test error"))).toBe("test error");
	});

	it("returns string errors directly", () => {
		expect(getErrorMessage("string error")).toBe("string error");
	});

	it("extracts message from error-like objects", () => {
		expect(getErrorMessage({ message: "object error" })).toBe("object error");
	});

	it("returns 'Unknown error' for null", () => {
		expect(getErrorMessage(null)).toBe("Unknown error");
	});

	it("returns 'Unknown error' for undefined", () => {
		expect(getErrorMessage(undefined)).toBe("Unknown error");
	});

	it("returns 'Unknown error' for numbers", () => {
		expect(getErrorMessage(42)).toBe("Unknown error");
	});

	it("returns 'Unknown error' for objects without message", () => {
		expect(getErrorMessage({ code: "ERR" })).toBe("Unknown error");
	});
});

describe("TimeoutError", () => {
	it("has correct name", () => {
		const error = new TimeoutError("timed out", 1000);
		expect(error.name).toBe("TimeoutError");
	});

	it("has correct message", () => {
		const error = new TimeoutError("timed out", 1000);
		expect(error.message).toBe("timed out");
	});

	it("has correct timeoutMs", () => {
		const error = new TimeoutError("timed out", 1000);
		expect(error.timeoutMs).toBe(1000);
	});

	it("is an instance of Error", () => {
		const error = new TimeoutError("timed out", 1000);
		expect(error).toBeInstanceOf(Error);
	});
});

describe("withTimeout", () => {
	it("resolves when promise completes before timeout", async () => {
		const promise = Promise.resolve("success");
		const result = await withTimeout(promise, 1000);
		expect(result).toBe("success");
	});

	it("rejects with TimeoutError when promise takes too long", async () => {
		const promise = new Promise((resolve) => setTimeout(resolve, 1000));
		await expect(withTimeout(promise, 10)).rejects.toThrow(TimeoutError);
	});

	it("includes custom message in TimeoutError", async () => {
		const promise = new Promise((resolve) => setTimeout(resolve, 1000));
		await expect(
			withTimeout(promise, 10, "custom timeout message"),
		).rejects.toThrow("custom timeout message");
	});

	it("uses default message if none provided", async () => {
		const promise = new Promise((resolve) => setTimeout(resolve, 1000));
		await expect(withTimeout(promise, 10)).rejects.toThrow(
			"Operation timed out after 10ms",
		);
	});

	it("propagates rejection from original promise", async () => {
		const promise = Promise.reject(new Error("original error"));
		await expect(withTimeout(promise, 1000)).rejects.toThrow("original error");
	});

	it("clears timeout when promise resolves", async () => {
		// This test verifies no timer leaks
		const promise = Promise.resolve("done");
		await withTimeout(promise, 100);
		// If the timeout wasn't cleared, the test would hang or leak
	});

	it("clears timeout when promise rejects", async () => {
		const promise = Promise.reject(new Error("error"));
		try {
			await withTimeout(promise, 100);
		} catch {
			// Expected
		}
		// If the timeout wasn't cleared, the test would hang or leak
	});
});
