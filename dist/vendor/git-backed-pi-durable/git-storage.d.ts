import type { Context } from "@earendil-works/chord/context";
import { type Id, type Seq, type Storage, type StorageWrite } from "@earendil-works/pi-durable";
import { GitRepo, type Signature } from "./git.js";
export declare const FORMAT_VERSION = 1;
export interface GitStorageOptions {
    /** A work tree, `.git` dir, or bare repository. It must exist. */
    readonly repo: string;
    /** The ref holding the log, e.g. `refs/pi/threads/42`. */
    readonly ref: string;
    /** Commit author and committer. */
    readonly author?: Signature;
    /** fsync objects and the ref before a commit counts as stored. Default false (like JSONL). */
    readonly fsync?: boolean;
    /** Append to `logs/<ref>`, as git does for branches. Default false (git doesn't log custom refs either). */
    readonly reflog?: boolean;
    /** Open without writing; `commit()` rejects. */
    readonly readOnly?: boolean;
    /**
     * Called after each stored commit() with the new tip and the batches it added, e.g. to push at turn boundaries
     * (see `isTurnBoundary`). Must not throw; errors are swallowed.
     */
    readonly onCommit?: (event: CommitEvent) => void;
}
export interface CommitEvent {
    readonly tip: string;
    readonly batches: readonly Batch[];
}
export interface Batch {
    readonly format: number;
    readonly seq: number;
    readonly writes: readonly StorageWrite[];
}
export declare class GitStorageCorruptionError extends Error {
    constructor(message: string, cause?: unknown);
}
export declare class GitStorageReadOnlyError extends Error {
    constructor();
}
export declare class GitStoragePoisonedError extends Error {
    constructor(cause: unknown);
}
export declare class GitStorage implements Storage {
    readonly repo: GitRepo;
    readonly ref: string;
    private readonly author;
    private readonly reflog;
    private readonly readOnly;
    private readonly onCommit;
    private readonly memory;
    private head;
    private closed;
    private poisonError;
    /** Settles once the batches being written are; memory is ahead of the ref meanwhile. */
    private writing;
    /** Serializes commit() calls. */
    private queue;
    private constructor();
    static open(options: GitStorageOptions): Promise<GitStorage>;
    /** The commit the ref points at, as of the last commit or open; undefined while empty. */
    get tip(): string | undefined;
    private recover;
    commit(batches: readonly (readonly StorageWrite[])[], receive: (index: number, seq: Seq) => void, context: Context): ReturnType<Storage["commit"]>;
    private persist;
    mintId<I extends Id<string>>(): Promise<I>;
    conversation(...args: Parameters<Storage["conversation"]>): Promise<import("@earendil-works/pi-durable").ConversationRecord | undefined>;
    scanConversations(...args: Parameters<Storage["scanConversations"]>): Promise<import("@earendil-works/pi-durable").Page<import("@earendil-works/pi-durable").ConversationRecord, Readonly<Record<string, import("@earendil-works/chord/json").JsonValue>>>>;
    entry: Storage["entry"];
    findLatestHeadMarker(...args: Parameters<Storage["findLatestHeadMarker"]>): Promise<(import("@earendil-works/pi-durable").EntryRecord & {
        readonly head: import("@earendil-works/pi-durable").EntryId;
    }) | undefined>;
    scanEntries(...args: Parameters<Storage["scanEntries"]>): Promise<import("@earendil-works/pi-durable").Page<import("@earendil-works/pi-durable").EntryRecord, Readonly<Record<string, import("@earendil-works/chord/json").JsonValue>>>>;
    task(...args: Parameters<Storage["task"]>): Promise<({
        readonly trace?: import("@earendil-works/pi-telemetry").TelemetryCarrier;
        readonly links?: readonly import("@earendil-works/pi-telemetry").TelemetryCarrier[];
        readonly id: import("@earendil-works/pi-durable").TaskId<import("@earendil-works/chord/json").JsonValue>;
        readonly conversationId: import("@earendil-works/pi-durable").ConversationId;
        readonly kind: string;
        readonly version: number;
        readonly input: import("@earendil-works/chord/json").JsonValue;
        readonly owner?: import("@earendil-works/pi-durable").TaskId;
        readonly background: boolean;
        readonly abortRequested: boolean;
        readonly abortReason?: "restart";
        readonly abandonOnRestart?: true;
        readonly startedAt?: number;
        readonly endedAt?: number;
        readonly restarts?: number;
    } & ({
        readonly state: {
            readonly status: "pending";
            readonly checkpoint: import("@earendil-works/chord/json").JsonValue;
            readonly outcome?: never;
        } | {
            readonly status: "running";
            readonly checkpoint: import("@earendil-works/chord/json").JsonValue;
            readonly outcome?: never;
        } | {
            readonly status: "waiting";
            readonly checkpoint: import("@earendil-works/chord/json").JsonValue;
            readonly on: readonly import("@earendil-works/pi-durable").TaskId[];
            readonly policy: import("@earendil-works/pi-durable").JoinPolicy;
            readonly outcome?: never;
        } | {
            readonly status: "sleeping";
            readonly checkpoint: import("@earendil-works/chord/json").JsonValue;
            readonly until: number;
            readonly outcome?: never;
        };
        readonly memos?: Readonly<Record<string, import("@earendil-works/chord/json").JsonValue>>;
    } | {
        readonly state: {
            readonly status: "completing";
            readonly checkpoint?: never;
            readonly outcome: import("@earendil-works/pi-durable").TaskOutcome<import("@earendil-works/chord/json").JsonValue>;
        } | {
            readonly status: "terminal";
            readonly checkpoint?: never;
            readonly outcome: import("@earendil-works/pi-durable").TaskOutcome<import("@earendil-works/chord/json").JsonValue>;
        };
        readonly memos?: never;
    })) | undefined>;
    scanTasks(...args: Parameters<Storage["scanTasks"]>): Promise<import("@earendil-works/pi-durable").Page<{
        readonly trace?: import("@earendil-works/pi-telemetry").TelemetryCarrier;
        readonly links?: readonly import("@earendil-works/pi-telemetry").TelemetryCarrier[];
        readonly id: import("@earendil-works/pi-durable").TaskId<import("@earendil-works/chord/json").JsonValue>;
        readonly conversationId: import("@earendil-works/pi-durable").ConversationId;
        readonly kind: string;
        readonly version: number;
        readonly input: import("@earendil-works/chord/json").JsonValue;
        readonly owner?: import("@earendil-works/pi-durable").TaskId;
        readonly background: boolean;
        readonly abortRequested: boolean;
        readonly abortReason?: "restart";
        readonly abandonOnRestart?: true;
        readonly startedAt?: number;
        readonly endedAt?: number;
        readonly restarts?: number;
    } & ({
        readonly state: {
            readonly status: "pending";
            readonly checkpoint: import("@earendil-works/chord/json").JsonValue;
            readonly outcome?: never;
        } | {
            readonly status: "running";
            readonly checkpoint: import("@earendil-works/chord/json").JsonValue;
            readonly outcome?: never;
        } | {
            readonly status: "waiting";
            readonly checkpoint: import("@earendil-works/chord/json").JsonValue;
            readonly on: readonly import("@earendil-works/pi-durable").TaskId[];
            readonly policy: import("@earendil-works/pi-durable").JoinPolicy;
            readonly outcome?: never;
        } | {
            readonly status: "sleeping";
            readonly checkpoint: import("@earendil-works/chord/json").JsonValue;
            readonly until: number;
            readonly outcome?: never;
        };
        readonly memos?: Readonly<Record<string, import("@earendil-works/chord/json").JsonValue>>;
    } | {
        readonly state: {
            readonly status: "completing";
            readonly checkpoint?: never;
            readonly outcome: import("@earendil-works/pi-durable").TaskOutcome<import("@earendil-works/chord/json").JsonValue>;
        } | {
            readonly status: "terminal";
            readonly checkpoint?: never;
            readonly outcome: import("@earendil-works/pi-durable").TaskOutcome<import("@earendil-works/chord/json").JsonValue>;
        };
        readonly memos?: never;
    }), Readonly<Record<string, import("@earendil-works/chord/json").JsonValue>>>>;
    submission(...args: Parameters<Storage["submission"]>): Promise<import("@earendil-works/pi-durable").SubmissionRecord | undefined>;
    scanSubmissions(...args: Parameters<Storage["scanSubmissions"]>): Promise<import("@earendil-works/pi-durable").Page<import("@earendil-works/pi-durable").SubmissionRecord, Readonly<Record<string, import("@earendil-works/chord/json").JsonValue>>>>;
    submissionByRequest(...args: Parameters<Storage["submissionByRequest"]>): Promise<import("@earendil-works/pi-durable").SubmissionRecord | undefined>;
    findDocument(...args: Parameters<Storage["findDocument"]>): Promise<import("@earendil-works/pi-durable").DocumentRecord | undefined>;
    document(...args: Parameters<Storage["document"]>): Promise<import("@earendil-works/pi-durable").StoredDocument | undefined>;
    scanDocuments(...args: Parameters<Storage["scanDocuments"]>): Promise<import("@earendil-works/pi-durable").Page<import("@earendil-works/pi-durable").DocumentRecord, Readonly<Record<string, import("@earendil-works/chord/json").JsonValue>>>>;
    close(context: Context): Promise<void>;
    private get store();
    private readable;
    private poison;
    private assertUsable;
}
export declare function openGitStorage(options: GitStorageOptions): Promise<GitStorage>;
