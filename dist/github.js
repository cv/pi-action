function triggerSource(payload, comment) {
    if (!comment) {
        return "body";
    }
    // Review comments belong to a review and arrive with pull_request, not issue.
    return !payload.issue && "pull_request_review_id" in comment
        ? "review_comment"
        : "comment";
}
export function extractTriggerInfo(payload) {
    const comment = payload.comment;
    const issue = (payload.issue || payload.pull_request);
    if (!issue) {
        return null;
    }
    const isCommentEvent = !!comment;
    const origin = comment ?? issue;
    const triggerText = origin.body;
    const author = origin.user;
    const authorAssociation = origin.author_association;
    if (!(triggerText && author)) {
        return null;
    }
    return {
        isCommentEvent,
        triggerText,
        author,
        authorAssociation,
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueBody: issue.body || "",
        commentId: comment?.id,
        isPullRequest: !!(payload.pull_request || issue.pull_request),
        source: triggerSource(payload, comment),
        createdAt: origin.created_at,
        url: origin.html_url,
    };
}
const PAGE_SIZE = 100;
async function listAll(fetchPage) {
    const all = [];
    for (let page = 1;; page++) {
        const { data } = await fetchPage(page);
        all.push(...data);
        if (data.length < PAGE_SIZE) {
            return all;
        }
    }
}
export function createGitHubClient(octokit, context) {
    const { owner, name: repo } = context.repo;
    return {
        async addReactionToComment(commentId, reaction, source = "comment") {
            const params = { owner, repo, comment_id: commentId, content: reaction };
            if (source === "review_comment") {
                await octokit.rest.reactions.createForPullRequestReviewComment(params);
            }
            else {
                await octokit.rest.reactions.createForIssueComment(params);
            }
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
            const { data } = await octokit.rest.issues.createComment({
                owner,
                repo,
                issue_number: issueNumber,
                body,
            });
            return { id: data.id, url: data.html_url };
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
        listIssueComments(issueNumber, since) {
            return listAll((page) => octokit.rest.issues.listComments({
                owner,
                repo,
                issue_number: issueNumber,
                since,
                per_page: PAGE_SIZE,
                page,
            }));
        },
        listReviewComments(pullNumber, since) {
            return listAll((page) => octokit.rest.pulls.listReviewComments({
                owner,
                repo,
                pull_number: pullNumber,
                since,
                per_page: PAGE_SIZE,
                page,
            }));
        },
    };
}
export async function addReaction(client, trigger, reaction) {
    if (trigger.isCommentEvent && trigger.commentId) {
        await client.addReactionToComment(trigger.commentId, reaction, trigger.source);
    }
    else {
        await client.addReactionToIssue(trigger.issueNumber, reaction);
    }
}
