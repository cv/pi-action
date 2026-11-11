import { extractTask, hasTrigger } from "./context.js";
import { sanitizeInput, validatePermissions } from "./security.js";
export function triggerKey(source, issueNumber, commentId) {
    if (source === "body" || commentId === undefined) {
        return `issue-${issueNumber}`;
    }
    return source === "review_comment"
        ? `review-comment-${commentId}`
        : `comment-${commentId}`;
}
export function triggerFromInfo(info, triggerPhrase) {
    const source = info.source ?? (info.isCommentEvent ? "comment" : "body");
    const text = sanitizeInput(info.triggerText);
    return {
        key: triggerKey(source, info.issueNumber, info.commentId),
        source,
        issueNumber: info.issueNumber,
        commentId: info.commentId,
        author: info.author,
        text,
        task: extractTask(text, triggerPhrase),
        createdAt: info.createdAt ?? new Date().toISOString(),
        url: info.url,
    };
}
/** The comments that mention the trigger phrase and whose authors may run pi. */
export function triggersFromComments(comments, source, issueNumber, filter) {
    const triggers = [];
    for (const comment of comments) {
        const body = comment.body ?? "";
        const user = comment.user;
        if (!(user && hasTrigger(body, filter.triggerPhrase))) {
            continue;
        }
        const author = {
            login: user.login,
            type: user.type,
        };
        const permitted = validatePermissions({
            authorAssociation: comment.author_association,
            authorLogin: author.login,
            isBot: author.type === "Bot",
            allowedBots: filter.allowedBots,
        });
        if (!permitted) {
            continue;
        }
        const text = sanitizeInput(body);
        triggers.push({
            key: triggerKey(source, issueNumber, comment.id),
            source,
            issueNumber,
            commentId: comment.id,
            author,
            text,
            task: extractTask(text, filter.triggerPhrase),
            createdAt: comment.created_at,
            url: comment.html_url,
        });
    }
    return triggers;
}
/**
 * Every trigger on the thread created after `since` (comments a cancelled or still-pending run never handled,
 * and ones posted while this run works), plus `current`, oldest first and without duplicates.
 */
export async function collectTriggers(client, info, filter, since, current) {
    const found = current ? [current] : [];
    if (since) {
        const iso = since.toISOString();
        const comments = await client.listIssueComments(info.issueNumber, iso);
        found.push(...triggersFromComments(comments, "comment", info.issueNumber, filter));
        if (info.isPullRequest) {
            const reviews = await client.listReviewComments(info.issueNumber, iso);
            found.push(...triggersFromComments(reviews, "review_comment", info.issueNumber, filter));
        }
    }
    const byKey = new Map();
    for (const trigger of found) {
        if (!since ||
            trigger === current ||
            Date.parse(trigger.createdAt) >= since.getTime()) {
            byKey.set(trigger.key, byKey.get(trigger.key) ?? trigger);
        }
    }
    return [...byKey.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
