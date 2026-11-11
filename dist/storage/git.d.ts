export type ObjectType = "blob" | "tree" | "commit";
export interface GitObject {
    readonly type: string;
    readonly content: Buffer;
}
export interface Signature {
    readonly name: string;
    readonly email: string;
}
export interface Commit {
    readonly tree: string;
    readonly parents: readonly string[];
    readonly message: string;
}
export declare const ZERO: string;
export declare class RefConflictError extends Error {
    readonly ref: string;
    readonly expected: string | undefined;
    readonly actual: string | undefined;
    constructor(ref: string, expected: string | undefined, actual: string | undefined);
}
/** Rough check-ref-format: refs/..., no "..", control chars, spaces, ~^:?*[\\, "@{", ".lock" components. */
export declare function assertRefName(ref: string): void;
export declare class GitRepo {
    /** Where objects and shared refs live (the common dir for linked worktrees). */
    readonly commonDir: string;
    readonly fsync: boolean;
    private catFile;
    private constructor();
    /** Open a repository: a work tree, a `.git` dir, a bare repo, or a linked worktree's `.git` file. */
    static open(path: string, options?: {
        fsync?: boolean;
    }): Promise<GitRepo>;
    static hash(type: ObjectType, content: Buffer): {
        sha: string;
        raw: Buffer;
    };
    writeObject(type: ObjectType, content: Buffer): Promise<string>;
    writeBlob(content: Buffer | string): Promise<string>;
    /** A tree of regular files; names are sorted as git requires. */
    writeTree(files: Readonly<Record<string, string>>): Promise<string>;
    writeCommit(input: {
        tree: string;
        parents: readonly string[];
        author: Signature;
        message: string;
        time?: Date;
    }): Promise<string>;
    readObject(sha: string): Promise<GitObject>;
    readCommit(sha: string): Promise<Commit>;
    readTree(sha: string): Promise<Record<string, string>>;
    readRef(ref: string): Promise<string | undefined>;
    /**
     * Compare-and-swap `ref` from `expected` (undefined: must not exist) to `value`, with git's own lock-file
     * protocol, so a concurrent `git update-ref`, fetch, or another GitStorage sees one winner.
     */
    updateRef(ref: string, value: string, expected: string | undefined, reflogMessage?: string): Promise<void>;
    private appendReflog;
    close(): Promise<void>;
    private objectPath;
}
