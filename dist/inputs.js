const TRUE_VALUES = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "n", "off"]);
const MODEL_INPUT_MODES = new Set(["text", "image"]);
const INTEGER_PATTERN = /^\d+$/;
export function getInputOrDefault(readInput, name, defaultValue) {
    const value = readInput(name);
    return value || defaultValue;
}
export function parseCsvInput(value) {
    return value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}
export function parseBooleanInput(value, defaultValue) {
    return parseOptionalBooleanInput(value) ?? defaultValue;
}
export function parseOptionalBooleanInput(value) {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
        return undefined;
    }
    if (TRUE_VALUES.has(normalized)) {
        return true;
    }
    if (FALSE_VALUES.has(normalized)) {
        return false;
    }
    return undefined;
}
export function parsePositiveIntegerInput(value, defaultValue) {
    const normalized = value.trim();
    if (!INTEGER_PATTERN.test(normalized)) {
        return defaultValue;
    }
    const parsed = Number.parseInt(normalized, 10);
    return parsed > 0 ? parsed : defaultValue;
}
export function parseModelInputModes(value, defaultValue) {
    const modes = parseCsvInput(value).filter((mode) => MODEL_INPUT_MODES.has(mode));
    return modes.length > 0 ? modes : defaultValue;
}
