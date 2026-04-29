export type InputReader = (name: string) => string;
export declare function getInputOrDefault(readInput: InputReader, name: string, defaultValue: string): string;
export declare function parseCsvInput(value: string): string[];
export declare function parseBooleanInput(value: string, defaultValue: boolean): boolean;
export declare function parsePositiveIntegerInput(value: string, defaultValue: number): number;
