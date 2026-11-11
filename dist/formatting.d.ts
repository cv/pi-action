/**
 * Response formatting utilities for consistent GitHub comment formatting
 */
export interface CommentFooter {
    /** The thread's ref, e.g. refs/pi/threads/42. */
    ref?: string;
    /** Who the response answers, e.g. ["alice", "bob"]. */
    replyTo?: string[];
}
export declare function formatSuccessComment(response: string, info?: CommentFooter): string;
export declare function formatErrorComment(error: string, info?: CommentFooter): string;
