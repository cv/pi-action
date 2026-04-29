function isSupportedWebhookPayload(payload) {
    return (typeof payload === "object" &&
        payload !== null &&
        ("issue" in payload || "pull_request" in payload));
}
function getTriggerSubject(payload) {
    return "pull_request" in payload ? payload.pull_request : payload.issue;
}
function getTriggerComment(payload) {
    return "comment" in payload ? payload.comment : undefined;
}
function isPullRequestTrigger(payload, subject) {
    return "pull_request" in payload || "pull_request" in subject;
}
export function extractTriggerInfo(payload) {
    if (!isSupportedWebhookPayload(payload)) {
        return null;
    }
    const subject = getTriggerSubject(payload);
    const comment = getTriggerComment(payload);
    const triggerText = comment?.body ?? subject.body ?? "";
    const author = comment?.user ?? subject.user;
    const authorAssociation = comment?.author_association ?? subject.author_association;
    if (!(triggerText && author)) {
        return null;
    }
    return {
        isCommentEvent: !!comment,
        triggerText,
        author,
        authorAssociation,
        issueNumber: subject.number,
        issueTitle: subject.title,
        issueBody: subject.body ?? "",
        commentId: comment?.id,
        isPullRequest: isPullRequestTrigger(payload, subject),
    };
}
export function createGitHubClient(octokit, context) {
    const { owner, name: repo } = context.repo;
    return {
        async addReactionToComment(commentId, reaction) {
            await octokit.rest.reactions.createForIssueComment({
                owner,
                repo,
                comment_id: commentId,
                content: reaction,
            });
        },
        async addReactionToIssue(issueNumber, reaction) {
            await octokit.rest.reactions.createForIssue({
                owner,
                repo,
                issue_number: issueNumber,
                content: reaction,
            });
        },
        async createComment(issueNumber, body) {
            await octokit.rest.issues.createComment({
                owner,
                repo,
                issue_number: issueNumber,
                body,
            });
        },
        async getPullRequestDiff(pullNumber) {
            const { data: diff } = await octokit.rest.pulls.get({
                owner,
                repo,
                pull_number: pullNumber,
                mediaType: { format: "diff" },
            });
            return diff;
        },
        async createGist(content, filename, description, isPublic = false) {
            const { data: gist } = await octokit.rest.gists.create({
                files: { [filename]: { content } },
                public: isPublic,
                description,
            });
            return gist.html_url || "";
        },
    };
}
export async function addReaction(client, triggerInfo, reaction) {
    if (triggerInfo.isCommentEvent && triggerInfo.commentId) {
        await client.addReactionToComment(triggerInfo.commentId, reaction);
    }
    else {
        await client.addReactionToIssue(triggerInfo.issueNumber, reaction);
    }
}
