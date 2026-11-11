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
