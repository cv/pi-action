/** The message of a thrown value, whatever was thrown. */
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

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A property of an object from outside (JSON, an extension); undefined for anything else. */
export function field(value: unknown, key: string): unknown {
	return isRecord(value) ? value[key] : undefined;
}
