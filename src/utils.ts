/**
 * Safely extracts error message from unknown error value
 */
export function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	if (error && typeof error === "object" && "message" in error) {
		return String(error.message);
	}
	return "Unknown error";
}

/**
 * Wraps a promise with a timeout. Rejects with TimeoutError if the timeout is exceeded.
 */
export class TimeoutError extends Error {
	constructor(
		message: string,
		public readonly timeoutMs: number,
	) {
		super(message);
		this.name = "TimeoutError";
	}
}

export function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message?: string,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			reject(
				new TimeoutError(
					message ?? `Operation timed out after ${timeoutMs}ms`,
					timeoutMs,
				),
			);
		}, timeoutMs);

		promise
			.then((result) => {
				clearTimeout(timeoutId);
				resolve(result);
			})
			.catch((error) => {
				clearTimeout(timeoutId);
				reject(error);
			});
	});
}

/** Compare dotted versions numerically: "22.19.0" >= "22.9.1". */
export function nodeVersionAtLeast(version: string, minimum: string): boolean {
	const a = version.split(".").map((n) => Number.parseInt(n, 10) || 0);
	const b = minimum.split(".").map((n) => Number.parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) {
			return diff > 0;
		}
	}
	return true;
}
