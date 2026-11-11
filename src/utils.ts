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
	if (typeof error === "object" && error !== null && "message" in error) {
		return String(error.message);
	}
	return "Unknown error";
}

/**
 * Wraps a promise with a timeout. Rejects with TimeoutError if the timeout is exceeded.
 */
export class TimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(message: string, timeoutMs: number) {
		super(message);
		this.name = "TimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

export async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message?: string,
): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timeoutId = setTimeout(() => {
			reject(
				new TimeoutError(
					message ?? `Operation timed out after ${timeoutMs}ms`,
					timeoutMs,
				),
			);
		}, timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timeoutId);
	}
}
