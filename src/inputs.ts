export type InputReader = (name: string) => string;

const TRUE_VALUES = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "n", "off"]);
const INTEGER_PATTERN = /^\d+$/;

export function getInputOrDefault(
	readInput: InputReader,
	name: string,
	defaultValue: string,
): string {
	const value = readInput(name);
	return value || defaultValue;
}

export function parseCsvInput(value: string): string[] {
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

export function parseBooleanInput(
	value: string,
	defaultValue: boolean,
): boolean {
	const normalized = value.trim().toLowerCase();
	if (!normalized) {
		return defaultValue;
	}
	if (TRUE_VALUES.has(normalized)) {
		return true;
	}
	if (FALSE_VALUES.has(normalized)) {
		return false;
	}
	return defaultValue;
}

export function parsePositiveIntegerInput(
	value: string,
	defaultValue: number,
): number {
	const normalized = value.trim();
	if (!INTEGER_PATTERN.test(normalized)) {
		return defaultValue;
	}
	const parsed = Number.parseInt(normalized, 10);
	return parsed > 0 ? parsed : defaultValue;
}
