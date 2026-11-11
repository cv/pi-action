import type { Batch } from "./git-storage.js";
export declare class GitSyncConflictError extends Error {
    readonly ref: string;
    constructor(ref: string, detail: string);
}
export type GitRunner = (args: readonly string[], cwd: string) => Promise<{
    stdout: string;
    stderr: string;
}>;
export interface GitSyncOptions {
    /** The work tree (or git dir) to run git in. */
    readonly repo: string;
    readonly ref: string;
    /** Default "origin". */
    readonly remote?: string;
    readonly log?: (message: string) => void;
    /** Runs git; injectable for tests. Rejects with { stdout, stderr } attached on a nonzero exit. */
    readonly git?: GitRunner;
}
/** A model response or tool result was stored: the end of a turn (or of one of its tool calls). */
export declare function isTurnBoundary(batches: readonly Batch[]): boolean;
/**
 * Pushes are fast-forward only, so a concurrent writer on the same ref makes the later push fail
 * (GitSyncConflictError) instead of overwriting the other's history. Pushes are coalesced: at most one runs,
 * and the newest scheduled tip goes next.
 */
export declare class GitSync {
    readonly ref: string;
    readonly remote: string;
    private readonly repo;
    private readonly log;
    private readonly git;
    /** What the remote ref is known to point at. */
    private remoteTip;
    private wanted;
    private running;
    private failure;
    constructor(options: GitSyncOptions);
    /** The remote tip as of the last fetch or push. */
    get pushed(): string | undefined;
    /** The error that stopped pushing, if any. */
    get error(): Error | undefined;
    /**
     * Make the local ref equal the remote one (creating, moving, or deleting it). Returns the remote tip, undefined
     * when the remote has no such ref yet.
     */
    fetch(): Promise<string | undefined>;
    /** Push `tip` soon; resolves when it (or a newer scheduled tip) is pushed. */
    schedule(tip: string): Promise<void>;
    /** Push `tip` now (after any push in flight); throws why pushing stopped, if it did. */
    flush(tip: string | undefined): Promise<void>;
    private drain;
}
export declare const runGit: GitRunner;
