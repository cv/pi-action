/**
 * Safely extracts error message from unknown error value
 */
export declare function getErrorMessage(error: unknown): string;
/**
 * Wraps a promise with a timeout. Rejects with TimeoutError if the timeout is exceeded.
 */
export declare class TimeoutError extends Error {
    readonly timeoutMs: number;
    constructor(message: string, timeoutMs: number);
}
export declare function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message?: string): Promise<T>;
/** Compare dotted versions numerically: "22.19.0" >= "22.9.1". */
export declare function nodeVersionAtLeast(version: string, minimum: string): boolean;
