import type { Api, Model } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { type EntryId, type EntryRecord, type Submission } from "@earendil-works/pi-durable";
export declare const POSTED_KIND = "pi-action.posted";
export declare const COMMENT_KIND = "pi-action.comment";
export declare const threadRef: (issueNumber: number) => string;
export interface ThreadLogger {
    info: (msg: string) => void;
    warning: (msg: string) => void;
}
export interface ThreadOptions {
    cwd: string;
    issueNumber: number;
    models: Models;
    model: Model<Api>;
    log: ThreadLogger;
    remote?: string;
}
export interface ThreadInput {
    /** Stable per GitHub item, e.g. `comment-123`: resubmitting it returns the same submission. */
    key: string;
    content: string;
    data: {
        author: string;
        url?: string;
        source: string;
    };
}
/**
 * One GitHub issue or PR as a durable pi conversation, stored in git on refs/pi/threads/<n> and pushed to the
 * remote at every turn boundary.
 */
export declare class Thread {
    readonly ref: string;
    readonly isNew: boolean;
    /** When the thread's first commit was made; undefined for a new thread. */
    readonly startedAt: Date | undefined;
    private readonly storage;
    private readonly sync;
    private readonly harness;
    private readonly root;
    private readonly log;
    private closed;
    private constructor();
    static open(options: ThreadOptions): Promise<Thread>;
    /** The newest local commit of the thread. */
    get tip(): string | undefined;
    /** Comments arriving while a run works join it (steer); otherwise they start one. */
    submit(input: ThreadInput): Promise<Submission>;
    answerText(answer: EntryId): Promise<string>;
    entries(): Promise<EntryRecord[]>;
    /** Results already posted to GitHub (`answer-<entryId>`, `error-<submissionId>`), with their comment URLs. */
    postedResults(): Promise<Map<string, string>>;
    markPosted(key: string, url: string): Promise<void>;
    abort(): Promise<void>;
    /** Push what is committed so far; throws if the remote moved under us. */
    push(): Promise<void>;
    close(): Promise<void>;
}
