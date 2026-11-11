import type { GitHubClient } from "./github.js";
import type { GitHubComment, GitHubUser, TriggerInfo, TriggerSource } from "./types.js";
/** One request for pi: an issue/PR body or comment that mentions the trigger phrase. */
export interface Trigger {
    /** Stable per GitHub item; used as the submission's requestId so it is answered once. */
    key: string;
    source: TriggerSource;
    issueNumber: number;
    commentId?: number;
    author: GitHubUser;
    text: string;
    task: string;
    createdAt: string;
    url?: string;
}
export interface TriggerFilter {
    triggerPhrase: string;
    allowedBots: string[];
}
export declare function triggerKey(source: TriggerSource, issueNumber: number, commentId?: number): string;
export declare function triggerFromInfo(info: TriggerInfo, triggerPhrase: string): Trigger;
/** The comments that mention the trigger phrase and whose authors may run pi. */
export declare function triggersFromComments(comments: GitHubComment[], source: Exclude<TriggerSource, "body">, issueNumber: number, filter: TriggerFilter): Trigger[];
/**
 * Every trigger on the thread created after `since` (comments a cancelled or still-pending run never handled,
 * and ones posted while this run works), plus `current`, oldest first and without duplicates.
 */
export declare function collectTriggers(client: GitHubClient, info: Pick<TriggerInfo, "issueNumber" | "isPullRequest">, filter: TriggerFilter, since: Date | undefined, current?: Trigger): Promise<Trigger[]>;
